import { Schema } from "mongoose";

export interface IVacancy {
  total?: number;
  postName?: string;         
  reservationNotes?: string;  
}

const vacancySchema = new Schema<IVacancy>(
  {
    total: { type: Number, default: 0 },
    postName: { type: String, trim: true },
    reservationNotes: { type: String, trim: true },
  },
  { _id: false } 
);

export default vacancySchema;