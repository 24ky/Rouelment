import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import sanitize from "sanitize-filename";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);


const raw = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Remplacement des sauts de ligne échappés :
if (raw.private_key) {
  raw.private_key = raw.private_key.replace(/\\n/g, "\n");
}

// Initialise seulement s’il n’y a pas déjà d’instance
if (!admin.getApps().length) {
  admin.initializeApp({
    credential: admin.credential.cert(raw)
  });
}


const app = express();
app.use(cors());
app.use(express.json());
const httpServer = createServer(app);
const io = new Server(httpServer, {});

const PORT = process.env.PORT || 10000;
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const META_FILE = path.join(UPLOAD_DIR, "metadata.json");

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
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const receivedAt = new Date().toISOString();
  const originalName = req.file.originalname;
  const storedAs = req.file.filename;

  try {
    // Mise à jour du fichier metadata.json
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    meta.push({ originalName, storedAs, receivedAt });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");

    // Envoi notification push à tous les utilisateurs
    await sendNotificationToAll(
      "Nouveau fichier reçu",
      `Fichier "${originalName}" uploadé avec succès`
    );

    // Notification socket.io aux clients connectés
    io.emit("fileUploaded", { originalName, storedAs, receivedAt });

    return res.json({ message: "File uploaded successfully", originalName, storedAs, receivedAt });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ error: "Erreur serveur lors de l'upload" });
  }
});

// 📜 Endpoint pour récupérer la liste des fichiers uploadés
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

// 📥 Endpoint pour télécharger un fichier
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

