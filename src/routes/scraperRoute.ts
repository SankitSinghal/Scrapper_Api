import { Router } from "express";
import { runIBPSScraper } from "../controller/scraperController";

const router = Router();

router.post("/ibps", runIBPSScraper);

export default router;