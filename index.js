// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import sanitize from "sanitize-filename";
import admin from "firebase-admin";
import serviceAccount from "./firebase-service-account.json" assert { type: "json" }; // 🟡 Change ce nom si nécessaire

const app = express();
app.use(cors());
app.use(express.json());
const httpServer = createServer(app);
const io = new Server(httpServer, {});

const PORT = process.env.PORT || 10000;
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const META_FILE = path.join(UPLOAD_DIR, "metadata.json");

// 📦 Initialiser Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// 📤 Fonction d’envoi de notification push à tous les utilisateurs
async function sendNotificationToAll(title, body) {
  const message = {
    topic: "allUsers", // tous ceux abonnés à ce topic via Firebasex
    notification: { title, body }
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("✅ Notification FCM envoyée :", response);
  } catch (error) {
    console.error("❌ Erreur FCM :", error.message);
  }
}

// 📁 Assure les répertoires
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify([]));

// 📂 Config Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = sanitize(file.originalname);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${original}`;
    cb(null, unique);
  }
});

const allowedExt = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExt.includes(ext)) cb(null, true);
  else cb(new Error("Type de fichier non autorisé: " + ext));
}

const upload = multer({ storage, fileFilter });

// 🧾 Statique
app.use(express.static(path.join(process.cwd(), "public")));

// 🔄 Endpoint d'upload
app.post("/upload", upload.single("file"), async (req, res) => {
  i
