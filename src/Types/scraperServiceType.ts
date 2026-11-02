import mongoose from "mongoose";

export interface ExamData {
  recruitmentId: unknown;
  jobTitle: unknown;
  links: unknown;
  dates: unknown;
  examName: string;
  sourceUrl: string;
  advertisementUrl?: string;
  advertisementFilePath?: string;
  admitCardUrl?: string;
  eligibility?: string;
  examStartedDate?: Date;
  feeSubmissionDate?: Date;
  lastFeeSubmissionDate?: Date;
}

export interface ScraperResult {
  found: number;
  saved: number;
  announcements: ExamData[];
}

export interface IExam extends mongoose.Document {
  examName: string;
  advertisementFilePath?: string;
}

export interface VacancyResult {
  total: number;
}

export interface CategoryFeeResult {
  applicationFee: number;
  categoryWiseFee: {
    general: number;
    obc: number;
    sc: number;
    st: number;
    ews: number;
    pwd: number;
    female: number;
  };
}
