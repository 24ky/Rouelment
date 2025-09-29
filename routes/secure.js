// routes/secure.js
import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";

const router = express.Router();

// Exemple de route privée
router.get("/secure", verifyToken, (req, res) => {
  res.json({ message: "Accès autorisé", uid: req.user.uid });
});

export default router;
