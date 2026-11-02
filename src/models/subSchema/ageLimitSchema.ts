import { Schema } from "mongoose";

export interface IAgeLimit {
  minAge: string;           // REQUIRED (e.g., "18")
  maxAge: string;           // REQUIRED (e.g., "32", "No Upper Limit")
  cutoffDate?: string;      // Optional (e.g., "as on 01/08/2026")
  relaxations?: string;     // Optional
}

const ageLimitSchema = new Schema<IAgeLimit>(
  {
    minAge: { type: String, required: true, trim: true },
    maxAge: { type: String, required: true, trim: true },
    cutoffDate: { type: String, trim: true },
    relaxations: { type: String, trim: true },
  },
  { _id: false }
);

export default ageLimitSchema;