import { Schema } from "mongoose";

export interface IFees {
  generalObc: number;       
  scStPwdFemale: number;    
  paymentMode?: string;     
}

export const feesSchema = new Schema<IFees>(
  {
    generalObc: { type: Number, required: true },
    scStPwdFemale: { type: Number, required: true },
    paymentMode: { type: String, trim: true },
  },
  { _id: false }   
);

export default feesSchema;