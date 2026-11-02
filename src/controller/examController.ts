import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import axios from "axios";
import https from "node:https";
import Exam from "../models/examModel";


const ADVERTISEMENT_DIR = path.resolve(
  process.cwd(),
  "uploads",
  "advertisements"
);

const MAX_PDF_SIZE = 15 * 1024 * 1024;

const getAllowedHosts = (): Set<string> => {
  return new Set(
    (process.env.ALLOWED_SCRAPE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
};

const validateAdvertisementUrl = (value: string): URL => {
  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !getAllowedHosts().has(url.hostname.toLowerCase())
  ) {
    throw new Error("Advertisement URL is not allowed");
  }

  return url;
};

const isPdf = (buffer: Buffer): boolean => {
  return (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  );
};

export const getAllExams = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 10)
    );

    const skip = (page - 1) * limit;

    const filter: any = {
   
      jobTitle: { $exists: true, $ne: null },
      "links.sourceUrl": { $not: /policies-rules-guidelines|overviewofibps/i }
    };

    if (req.query.qualification) {
      filter["eligibility.qualification"] = new RegExp(String(req.query.qualification), "i");
    }

    if (req.query.search) {
      filter.jobTitle = { $regex: String(req.query.search), $options: "i" };
    }

    const [exams, total] = await Promise.all([
      Exam.find(filter)
        .select("-links.advertisementFilePath")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Exam.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      count: exams.length,
      data: exams,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/exams/:id
export const getExamById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid exam ID",
      });
      return;
    }

    const exam = await Exam.findById(id)
      .select("-links.advertisementFilePath")
      .lean();

    if (!exam || /policies-rules-guidelines|overviewofibps/i.test(exam.links?.sourceUrl)) {
      res.status(404).json({
        success: false,
        message: "Exam not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: exam,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/exams/:id/admit-card
export const getAdmitCard = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid exam ID",
      });
      return;
    }

    const exam = await Exam.findById(id).select(
      "jobTitle links.admitCardUrl"
    );

    if (!exam) {
      res.status(404).json({
        success: false,
        message: "Exam not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        jobTitle: exam.jobTitle,
        admitCardUrl: exam.links?.admitCardUrl,
        available: Boolean(exam.links?.admitCardUrl),
      },
    });
  } catch (error) {
    next(error);
  }
};

const advertisementHttpsAgent = new https.Agent({
  minVersion: "TLSv1.2",
  rejectUnauthorized: false,
});

// POST /api/v1/exams/:id/advertisement/save
export const saveAdvertisement = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let temporaryPath: string | undefined;
  let finalPath: string | undefined;
  let databaseUpdated = false;

  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid exam ID",
      });
      return;
    }

    const exam = await Exam.findById(id).select(
      "jobTitle links.sourceUrl links.officialNotificationUrl links.advertisementFilePath"
    );

    if (!exam) {
      res.status(404).json({
        success: false,
        message: "Exam not found",
      });
      return;
    }

    const targetUrl = exam.links?.officialNotificationUrl || exam.links?.sourceUrl;

    if (!targetUrl?.trim()) {
      res.status(400).json({
        success: false,
        message: "Exam has no advertisement URL",
      });
      return;
    }

    let sourceUrl: URL;

    try {
      sourceUrl = validateAdvertisementUrl(targetUrl.trim());
    } catch {
      res.status(400).json({
        success: false,
        message: "Advertisement URL is invalid or not allowed",
      });
      return;
    }

    await fs.mkdir(ADVERTISEMENT_DIR, { recursive: true });

    let response;

    try {
      response = await axios.get<ArrayBuffer>(
        sourceUrl.toString(),
        {
          responseType: "arraybuffer",
          timeout: Number(process.env.SCRAPER_TIMEOUT) || 30000,
          maxContentLength: MAX_PDF_SIZE,
          maxBodyLength: MAX_PDF_SIZE,
          maxRedirects: 0,
          httpsAgent: advertisementHttpsAgent,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ExamMetadataBot/1.0)",
            Accept: "application/pdf, application/octet-stream;q=0.9",
          },
        }
      );
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        console.error("Advertisement source request failed:", {
          sourceHost: sourceUrl.hostname,
          code: error.code,
          message: error.message,
          status: error.response?.status,
        });

        if (error.response?.status === 404) {
          res.status(404).json({
            success: false,
            message: "Advertisement PDF was not found at the source",
          });
          return;
        }

        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
          res.status(504).json({
            success: false,
            message: "Advertisement download timed out",
          });
          return;
        }

        if (
          error.code === "EPROTO" ||
          error.code === "ERR_SSL_WRONG_VERSION_NUMBER" ||
          error.code === "ECONNRESET" ||
          error.code === "CERT_HAS_EXPIRED" ||
          error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
        ) {
          res.status(502).json({
            success: false,
            message: "Secure connection to the advertisement source failed",
            detail: error.code,
          });
          return;
        }
      }

      throw error;
    }

    const pdfBuffer = Buffer.from(response.data);

    if (pdfBuffer.length === 0 || pdfBuffer.length > MAX_PDF_SIZE) {
      res.status(502).json({
        success: false,
        message: "Advertisement source returned an empty or oversized file",
      });
      return;
    }

    const contentType = String(response.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (!["application/pdf", "application/octet-stream"].includes(contentType) || !isPdf(pdfBuffer)) {
      res.status(415).json({
        success: false,
        message: "Source did not return a valid PDF",
      });
      return;
    }

    const filename = `${randomUUID()}.pdf`;
    finalPath = path.join(ADVERTISEMENT_DIR, filename);
    temporaryPath = `${finalPath}.tmp`;

    await fs.writeFile(temporaryPath, pdfBuffer, { flag: "wx" });
    await fs.rename(temporaryPath, finalPath);
    temporaryPath = undefined;

    const relativePath = path.posix.join("uploads", "advertisements", filename);

    const updatedExam = await Exam.findByIdAndUpdate(
      id,
      {
        $set: {
          "links.advertisementFilePath": relativePath,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).select("jobTitle links.advertisementFilePath");

    if (!updatedExam) {
      res.status(404).json({
        success: false,
        message: "Exam disappeared before its file path could be saved",
      });
      return;
    }

    databaseUpdated = true;

    res.status(200).json({
      success: true,
      message: "Advertisement downloaded and saved successfully",
      data: {
        examId: updatedExam._id,
        jobTitle: updatedExam.jobTitle,
        advertisementFilePath: updatedExam.links?.advertisementFilePath,
        fileSize: pdfBuffer.length,
      },
    });
  } catch (error: unknown) {
    console.error("saveAdvertisement failed:", error);

    if (temporaryPath) {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }

    if (!databaseUpdated && finalPath) {
      await fs.unlink(finalPath).catch(() => undefined);
    }

    next(error);
  }
};
// Downloads the already-saved PDF to the client.
export const downloadAdvertisement = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid exam ID",
      });
      return;
    }

    const exam = await Exam.findById(id);

    if (!exam || !exam.links?.advertisementFilePath) {
      res.status(404).json({
        success: false,
        message: "Exam or advertisement PDF file path is not available",
      });
      return;
    }

    const projectRoot = process.cwd();
    const absolutePath = path.resolve(projectRoot, exam.links.advertisementFilePath);
    const uploadDirectory = path.resolve(projectRoot, "uploads", "advertisements");
    const relativePath = path.relative(uploadDirectory, absolutePath);

    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath) ||
      !existsSync(absolutePath)
    ) {
      res.status(404).json({
        success: false,
        message: "Advertisement PDF file not found on server",
      });
      return;
    }

    res.download(absolutePath, `${String(exam._id)}-advertisement.pdf`, (error) => {
      if (error && !res.headersSent) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
};

// export const triggerEnrichment = async (req: Request, res: Response) => {
//   try {
//     const rawId = req.params.id;
//     const examId = Array.isArray(rawId) ? rawId[0] : rawId;
//     const updatedExam = await enrichExamDetails(examId);
    
//     if (!updatedExam) {
//       return res.status(404).json({ success: false, message: "Exam not found or enrichment failed" });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "Exam details enriched successfully",
//       data: updatedExam,
//     });
//   } catch (error: any) {
//     return res.status(500).json({ success: false, error: error.message });
//   }
// };