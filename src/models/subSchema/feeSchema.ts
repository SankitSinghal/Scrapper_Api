import { Schema } from "mongoose";

export interface IFees {
  generalObc: string;       // REQUIRED (e.g., "100", "0")
  scStPwdFemale: string;    // REQUIRED (e.g., "0", "50")
  paymentMode?: string;     // Optional
}

export const feesSchema = new Schema<IFees>(
  {
    generalObc: { type: String, required: true, trim: true },
    scStPwdFemale: { type: String, required: true, trim: true },
    paymentMode: { type: String, trim: true },
  },
  { _id: false }
);

export default feesSchema;