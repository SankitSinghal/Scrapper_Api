import { NextFunction, Request, Response } from "express";

export interface AppError {
  message: string;
  statusCode?: number;
  code?: string | number;
  name?: string;
  stack?: string;
}

const errorMiddleware = (
  error: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  console.error("API Error: ", error);

  let statusCode = error.statusCode || 500;
  let message = error.message || "Internal server error";

  // 1. Handle Mongoose Duplicate Key Error (e.g. unique sourceUrl collision during scraping)
  if (error.code === 11000) {
    statusCode = 409;
    message = "A recruitment record with this source URL or ID already exists.";
  }

  // 2. Handle Mongoose Validation Errors
  if (error.name === "ValidationError") {
    statusCode = 400;
    message = "Database validation failed. Please check the schema fields.";
  }

  // 3. Handle Axios / Scraping Network Errors gracefully
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
    statusCode = 504;
    message = "Request to the government source timed out.";
  } else if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
    statusCode = 502;
    message = "Unable to reach the target government website.";
  }

  res.status(statusCode).json({
    success: false,
    message: statusCode === 500 ? "Request could not be completed" : message,
    ...(process.env.NODE_ENV !== "production" && { 
      detail: error.message,
      code: error.code 
    }),
  });
};

export default errorMiddleware;