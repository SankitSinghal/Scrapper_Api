import mongoose, { Document, Schema } from "mongoose";
import ageLimitSchema, { IAgeLimit } from "./subSchema/ageLimitSchema";
import feesSchema, { IFees } from "./subSchema/feeSchema";
import importantDatesSchema, { IImportantDates } from "./subSchema/importantDatesSchema";
import linksSchema, { ILinks } from "./subSchema/linkSchema";

export interface IExam extends Document {
  title: string;
  org: string;
  sector: 'CENTRAL GOVT' | 'RAILWAYS' | 'BANKING' | 'DEFENCE' | 'STATE GOVT' | 'TEACHING';
  posts: string;
  qualification: string;
  lastDate: string;
  location?: string;
  category?: string;
  salaryMin?: string;
  salaryMax?: string;
  tags?: string[];
  status?: 'apply' | 'upcoming' | 'admit' | 'result' | 'closed';
  featured?: boolean;
  
  fees: IFees;
  ageLimit: IAgeLimit;
  links: ILinks;
  importantDates?: IImportantDates;
  recruitmentId: string;

  isLiveOnWeb?: boolean;
  isLiveOnApp?: boolean;
}

const examSchema = new Schema<IExam>(
  {
    title: { type: String, required: true, trim: true, index: true },
    org: { type: String, required: true, trim: true, index: true },
    sector: { 
      type: String, 
      required: true, 
      enum: ['CENTRAL GOVT', 'RAILWAYS', 'BANKING', 'DEFENCE', 'STATE GOVT', 'TEACHING'],
      trim: true 
    },
    posts: { type: String, required: true, trim: true },
    qualification: { type: String, required: true, trim: true },
    lastDate: { type: String, required: true, trim: true },
    
    location: { type: String, default: "All India", trim: true },
    category: { type: String, default: "Recruitment", trim: true },
    salaryMin: { type: String, default: "21700", trim: true },
    salaryMax: { type: String, default: "69100", trim: true },
    tags: [{ type: String, trim: true }],
    status: { 
      type: String, 
      enum: ['apply', 'upcoming', 'admit', 'result', 'closed'], 
      default: 'apply', 
      trim: true 
    },
    featured: { type: Boolean, default: false },

    // Sub-schemas (Strictly Required as per spec)
    fees: { type: feesSchema, required: true },
    ageLimit: { type: ageLimitSchema, required: true },
    links: { type: linksSchema, required: true },
    importantDates: { type: importantDatesSchema },
    recruitmentId: { type: String, required: true, unique: true, index: true },
    isLiveOnWeb: { type: Boolean, default: true },
    isLiveOnApp: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

// Optional: Compound index for duplicate prevention based on (title + org)
examSchema.index({ title: 1, org: 1 }, { unique: true });

const Exam = mongoose.model<IExam>("Exam", examSchema);
export default Exam;