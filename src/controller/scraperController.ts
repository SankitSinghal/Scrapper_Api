import { Request, Response, NextFunction } from "express";
import { scrapeIBPSUpdates } from "../services/scraperService";

export const runIBPSScraper = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await scrapeIBPSUpdates();

    res.status(200).json({
      success: true,
      message: "IBPS scraping completed",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};