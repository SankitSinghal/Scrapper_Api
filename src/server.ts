import "dotenv/config";
import app from "./app";
import connectDB from "./config/db";
import env from "./config/env";

const startServer = async (): Promise<void> => {
 
    try {
    await connectDB();

    app.listen(env.PORT, () => {
      console.log(
        `Exam scraper API running at http://localhost:${env.PORT}`
      );
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exitCode = 1;
  }
};

void startServer();