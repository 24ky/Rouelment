import express from "express";
import multer from "multer";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import sanitize from "sanitize-filename";

import admin from "firebase-admin";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const raw = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (raw.private_key) raw.private_key = raw.private_key.replace(/\\n/g, "\n");

if (!getApps().length) {
  admin.initializeApp({
    credential: admin.credential.cert(raw),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // <-- ajoute cette variable
  });
}

const db = getFirestore();
const bucket = getStorage().bucket();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(process.cwd(), "uploads");

// Assure le dossier temporaire
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = sanitize(file.originalname);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${original}`;
    cb(null, unique);
  },
});

const allowedExt = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExt.includes(ext)) cb(null, true);
  else cb(new Error("Type de fichier non autorisé: " + ext));
}

const upload = multer({ storage, fileFilter });

// FCM notification
async function sendNotificationToAll(title, body, fileData = null) {
  const message = {
    topic: "allUsers",
    notification: { title, body },
    data: fileData ? { fileData: JSON.stringify(fileData) } : {},
  };
  try {
    const response = await admin.messaging().send(message);
    console.log("✅ Notification FCM envoyée :", response);
  } catch (error) {
    console.error("❌ Erreur FCM :", error.message);
  }
}

// Routes
app.get('/ping', (req, res) => {
  const msg = `🔔 Ping reçu de la part de ${req.ip}`;
  console.log(`[${new Date().toISOString()}] ${msg}`);
  io.emit('pingStatus', msg);
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Upload vers Firebase Storage + Firestore
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = path.join(UPLOAD_DIR, req.file.filename);
    const destination = `uploads/${req.file.filename}`;

    await bucket.upload(filePath, {
      destination,
      metadata: { contentType: req.file.mimetype },
    });

    await fsPromises.unlink(filePath); // clean local

    const [url] = await bucket.file(destination).getSignedUrl({
      action: "read",
      expires: "03-01-2500", // quasi permanent
    });

    const receivedAt = new Date().toISOString();
    const originalName = req.file.originalname;
    const storedAs = req.file.filename;

    await db.collection("uploads").add({
      originalName,
      storedAs,
      url,
      receivedAt,
    });

    await sendNotificationToAll("Nouveau fichier reçu", `"${originalName}"`, { originalName, storedAs, url, receivedAt });
    io.emit("fileUploaded", { originalName, storedAs, url, receivedAt });

    res.json({ message: "File uploaded successfully", originalName, storedAs, url, receivedAt });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Erreur serveur lors de l'upload" });
  }
});

// Liste des fichiers
app.get("/files", async (req, res) => {
  try {
    const snapshot = await db.collection("uploads").orderBy("receivedAt", "desc").get();
    const files = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de lire les fichiers" });
  }
});

// Téléchargement
app.get("/download/:filename", async (req, res) => {
  const filename = req.params.filename;
  if (filename.includes("..")) return res.status(400).send("Nom de fichier invalide");

  try {
    const snapshot = await db.collection("uploads").where("storedAs", "==", filename).limit(1).get();
    if (snapshot.empty) return res.status(404).send("Fichier non trouvé");
    const file = snapshot.docs[0].data();
    return res.redirect(file.url);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur serveur");
  }
});

// Socket.io
io.on("connection", (socket) => {
  console.log("Socket connecté :", socket.id);
  socket.on("disconnect", () => console.log("Socket déconnecté :", socket.id));
});

// Démarrage
httpServer.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));

// Keep-alive ping
const TARGET_SERVER = 'https://serveur-vt4p.onrender.com/ping';

async function pingTargetServer() {
  try {
    const res = await axios.get(TARGET_SERVER);
    const msg = `✅ Ping envoyé à ${TARGET_SERVER} - Status: ${res.status}`;
    console.log(`[${new Date().toISOString()}] ${msg}`);
    io.emit('pingStatus', msg);
  } catch (err) {
    const msg = `❌ Erreur de ping vers ${TARGET_SERVER}: ${err.message}`;
    console.error(`[${new Date().toISOString()}] ${msg}`);
    io.emit('pingStatus', msg);
  }

  const delay = Math.floor(Math.random() * (7 - 2 + 1) + 2) * 60 * 1000;
  console.log(`🕒 Prochain ping dans ${(delay / 60000).toFixed(1)} minutes...`);
  io.emit('pingStatus', `🕒 Prochain ping dans ${(delay / 60000).toFixed(1)} minutes...`);
  setTimeout(pingTargetServer, delay);
}

pingTargetServer();
