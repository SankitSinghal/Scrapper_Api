import { Schema } from "mongoose";

export interface IImportantDates {
  applyStart?: string;
  applyEnd?: string;
  feeLastDate?: string;
  correctionWindow?: string;
  examDate?: string;
  admitCardDate?: string;
  resultDate?: string;
}

const importantDatesSchema = new Schema<IImportantDates>(
  {
    applyStart: { type: String, trim: true },
    applyEnd: { type: String, trim: true },
    feeLastDate: { type: String, trim: true },
    correctionWindow: { type: String, trim: true },
    examDate: { type: String, trim: true },
    admitCardDate: { type: String, trim: true },
    resultDate: { type: String, trim: true },
  },
  { _id: false }
);

export default importantDatesSchema;