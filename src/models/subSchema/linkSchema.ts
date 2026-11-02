import { Schema } from "mongoose";

export interface ILinks {
  applyOnline?: string;
  notificationPdf?: string;
  officialWebsite?: string;
  sourceUrl?: string;
}

const linksSchema = new Schema<ILinks>(
  {
    applyOnline: { type: String, trim: true },
    notificationPdf: { type: String, trim: true },
    officialWebsite: { type: String, trim: true },
    sourceUrl: { type: String, trim: true },
  },
  { _id: false }
);

export default linksSchema;