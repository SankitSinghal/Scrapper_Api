import { Router } from "express";
import {
    downloadAdvertisement,
    getAdmitCard,
    getAllExams,
    getExamById,
    saveAdvertisement,
} from "../controller/examController";


export const examroute = Router();

examroute.get("/", getAllExams);
examroute.get("/:id", getExamById);
examroute.get("/:id/admit-card", getAdmitCard);
examroute.post("/:id/advertisement/save", saveAdvertisement);
examroute.get("/:id/advertisement", downloadAdvertisement);



