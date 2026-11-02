import express from 'express';
import errorMiddleware from './middleware/errorMiddleware';
import scraperRoutes from './routes/scraperRoute';
import { examroute as examRoutes } from './routes/examRoute';

const app = express();
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
    res.status(200).json({
        success: true,
        message: "Exam Scraper API is running"
    });
});

app.use("/api/v1/scraper", scraperRoutes);
app.use("/api/v1/exams", examRoutes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use(errorMiddleware);

export default app;