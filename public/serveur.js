import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import sanitize from "sanitize-filename";

import admin from "firebase-admin";
import { getApps } from "firebase-admin/app";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const raw = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (raw.private_key) {
  raw.private_key = raw.private_key.replace(/\\n/g, "\n");
}

// Initialisation de Firebase Admin si ce n'est pas déjà fait
if (!getApps().length) {
  admin.initializeApp({
    credential: admin.credential.cert(raw),
  });
}

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {});

const PORT = process.env.PORT;
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const META_FILE = path.join(UPLOAD_DIR, "metadata.json");

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
  },
});

const allowedExt = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExt.includes(ext)) cb(null, true);
  else cb(new Error("Type de fichier non autorisé: " + ext));
}

const upload = multer({ storage, fileFilter });

// 📤 Fonction d’envoi de notification push à tous les utilisateurs
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

app.get('/ping', (req, res) => {
  const msg = `🔔 Ping reçu de la part de ${req.ip}`;
  console.log(`[${new Date().toISOString()}] ${msg}`);
  io.emit('pingStatus', msg);  // 🟢 Envoie au dashboard
  res.status(200).send('OK');
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 🔒 Routes protégées par authentification Firebase

app.post("/upload", upload.single("file"), async (req, res) => {
  console.log("req.file =", req.file);
  console.log("req.body =", req.body);
  
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const receivedAt = new Date().toISOString();
  const originalName = req.file.originalname;
  const storedAs = req.file.filename;

  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    meta.push({ originalName, storedAs, receivedAt });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");

    await sendNotificationToAll(
      "Nouveau fichier reçu",
      `"${originalName}"`,
      { originalName, storedAs, receivedAt }
    );

    io.emit("fileUploaded", { originalName, storedAs, receivedAt });

    return res.json({ message: "File uploaded successfully", originalName, storedAs, receivedAt });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ error: "Erreur serveur lors de l'upload" });
  }
});

app.get("/files", (req, res) => {
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    meta.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json(meta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de lire les métadonnées" });
  }
});

app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  if (filename.includes("..")) return res.status(400).send("Nom de fichier invalide");
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier non trouvé");
  res.download(filePath);
});

// 🔌 Gestion des connexions socket.io
io.on("connection", (socket) => {
  console.log("Socket connecté :", socket.id);
  socket.on("disconnect", () => {
    console.log("Socket déconnecté :", socket.id);
  });
});

// 🚀 Démarrage du serveur HTTP
httpServer.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
// ================================
// 🔁 PING DU SERVEUR B (keep alive)
// ================================
import axios from 'axios';

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
