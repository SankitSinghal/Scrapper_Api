import mongoose from "mongoose";
import env from "./env";

const connectDB = async () => {
  await mongoose.connect(env.MONGO_URI);
  console.log("MongoDB connected successfully");
};

export default connectDB;
