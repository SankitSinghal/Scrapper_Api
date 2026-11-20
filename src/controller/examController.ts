
import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import path from "node:path";
import fs from "node:fs/promises";
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

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const advertisementHttpsAgent = new https.Agent({
  minVersion: "TLSv1.2",
  rejectUnauthorized: false,
});

const fetchAndStoreAdvertisementPdf = async (
  examId: string,
  rawUrl: string
): Promise<{ relativePath: string; absolutePath: string; fileSize: number }> => {
  let temporaryPath: string | undefined;
  let finalPath: string | undefined;
  let databaseUpdated = false;

  try {
    const sourceUrl = validateAdvertisementUrl(rawUrl.trim());
    await fs.mkdir(ADVERTISEMENT_DIR, { recursive: true });

    const response = await axios.get<ArrayBuffer>(sourceUrl.toString(), {
      responseType: "arraybuffer",
      timeout: Number(process.env.SCRAPER_TIMEOUT) || 30000,
      maxContentLength: MAX_PDF_SIZE,
      maxBodyLength: MAX_PDF_SIZE,
      maxRedirects: 5,
      httpsAgent: advertisementHttpsAgent,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ExamMetadataBot/1.0)",
        Accept: "application/pdf, application/octet-stream;q=0.9",
      },
    });

    const pdfBuffer = Buffer.from(response.data);

    if (pdfBuffer.length === 0 || pdfBuffer.length > MAX_PDF_SIZE) {
      const err: any = new Error("Advertisement source returned an empty or oversized file");
      err.statusCode = 502;
      throw err;
    }

    const contentType = String(response.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (
      !["application/pdf", "application/octet-stream"].includes(contentType) ||
      !isPdf(pdfBuffer)
    ) {
      const err: any = new Error("Source did not return a valid PDF");
      err.statusCode = 415;
      throw err;
    }

    const filename = `${randomUUID()}.pdf`;
    finalPath = path.join(ADVERTISEMENT_DIR, filename);
    temporaryPath = `${finalPath}.tmp`;

    await fs.writeFile(temporaryPath, pdfBuffer, { flag: "wx" });
    await fs.rename(temporaryPath, finalPath);
    temporaryPath = undefined;

    const relativePath = path.posix.join("uploads", "advertisements", filename);

    const updatedExam = await Exam.findByIdAndUpdate(
      examId,
      {
        $set: {
          "links.advertisementFilePath": relativePath,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).select("_id");

    if (!updatedExam) {
      const err: any = new Error("Exam disappeared before its file path could be saved");
      err.statusCode = 404;
      throw err;
    }

    databaseUpdated = true;

    return {
      relativePath,
      absolutePath: finalPath,
      fileSize: pdfBuffer.length,
    };
  } catch (error) {
    if (temporaryPath) {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
    if (!databaseUpdated && finalPath) {
      await fs.unlink(finalPath).catch(() => undefined);
    }
    throw error;
  }
};

const resolveExistingAdvertisementPath = async (
  storedRelativePath?: string | null
): Promise<string | undefined> => {
  if (!storedRelativePath) return undefined;

  const projectRoot = process.cwd();
  const absolutePath = path.resolve(projectRoot, storedRelativePath);
  const relativeFromDir = path.relative(ADVERTISEMENT_DIR, absolutePath);

  if (
    relativeFromDir === ".." ||
    relativeFromDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromDir)
  ) {
    return undefined;
  }

  try {
    await fs.access(absolutePath);
    return absolutePath;
  } catch {
    return undefined;
  }
};

export const getAllExams = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const filter: any = {
      title: { $exists: true, $ne: null },
      "links.sourceUrl": { $not: /policies-rules-guidelines|overviewofibps/i },
    };

    if (req.query.qualification) {
      filter["qualification"] = new RegExp(
        escapeRegex(String(req.query.qualification)),
        "i"
      );
    }

    if (req.query.category) {
      filter["category"] = new RegExp(
        escapeRegex(String(req.query.category)),
        "i"
      );
    }

    if (req.query.status) {
      filter["status"] = String(req.query.status);
    }

    if (req.query.search) {
      filter.title = {
        $regex: escapeRegex(String(req.query.search)),
        $options: "i",
      };
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

    if (
      !exam ||
      /policies-rules-guidelines|overviewofibps/i.test(exam.links?.sourceUrl ?? "")
    ) {
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

    const exam = await Exam.findById(id).select("title links importantDates");

    if (!exam) {
      res.status(404).json({
        success: false,
        message: "Exam not found",
      });
      return;
    }

    const examData = exam as any;
    const admitCardLink =
      examData.links?.admitCardUrl || examData.importantDates?.admitCardDate;

    res.status(200).json({
      success: true,
      data: {
        jobTitle: examData.title,
        admitCardUrl: admitCardLink,
        available: Boolean(
          admitCardLink &&
            admitCardLink !== "To be announced" &&
            !admitCardLink.includes("Days before")
        ),
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/exams/:id/advertisement/save
export const saveAdvertisement = async (
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
      "title links.sourceUrl links.notificationPdf links.advertisementFilePath"
    );

    if (!exam) {
      res.status(404).json({
        success: false,
        message: "Exam not found",
      });
      return;
    }

    const targetUrl = exam.links?.notificationPdf || exam.links?.sourceUrl;

    if (!targetUrl?.trim()) {
      res.status(400).json({
        success: false,
        message: "Exam has no advertisement URL",
      });
      return;
    }

    try {
      validateAdvertisementUrl(targetUrl.trim());
    } catch {
      res.status(400).json({
        success: false,
        message: "Advertisement URL is invalid or not allowed",
      });
      return;
    }

    const savedResult = await fetchAndStoreAdvertisementPdf(
      String(exam._id),
      targetUrl
    );

    res.status(200).json({
      success: true,
      message: "Advertisement downloaded and saved successfully",
      data: {
        examId: exam._id,
        jobTitle: exam.title,
        advertisementFilePath: savedResult.relativePath,
        fileSize: savedResult.fileSize,
      },
    });
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error("Advertisement source request failed:", {
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

    const statusCode = (error as any)?.statusCode;
    if (statusCode && error instanceof Error) {
      res.status(statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("saveAdvertisement failed:", error);
    next(error);
  }
};

// GET /api/v1/exams/:id/advertisement
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

    const exam = await Exam.findById(id).select(
      "title links.advertisementFilePath links.notificationPdf"
    );

    if (!exam) {
      res.status(404).json({
        success: false,
        message: "Exam not found",
      });
      return;
    }

    let fileToServe = await resolveExistingAdvertisementPath(
      exam.links?.advertisementFilePath
    );

    if (!fileToServe && exam.links?.notificationPdf?.trim()) {
      try {
        const fetched = await fetchAndStoreAdvertisementPdf(
          String(exam._id),
          exam.links.notificationPdf
        );
        fileToServe = fetched.absolutePath;
      } catch (downloadErr) {
        console.warn("On-demand PDF download failed, checking redirect fallback:", downloadErr);
        try {
          const validPdfUrl = validateAdvertisementUrl(
            exam.links.notificationPdf.trim()
          );
          res.redirect(validPdfUrl.toString());
          return;
        } catch {
          // Fall through to 404 below
        }
      }
    }

    if (!fileToServe) {
      res.status(404).json({
        success: false,
        message: "Exam or advertisement PDF file path is not available",
      });
      return;
    }

    res.download(fileToServe, `${String(exam._id)}-advertisement.pdf`, (error) => {
      if (error && !res.headersSent) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
};