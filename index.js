import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import sanitize from "sanitize-filename";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {});

const PORT = process.env.PORT || 10000;
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const META_FILE = path.join(UPLOAD_DIR, "metadata.json");

// 📁 Crée les dossiers
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify([]));

// 📂 Multer
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const original = sanitize(file.originalname);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${original}`;
    cb(null, unique);
  },
});

const allowedExt = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];
function fileFilter(_, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, allowedExt.includes(ext));
}

const upload = multer({ storage, fileFilter });

// 🧾 Routes simples
app.get("/", (_, res) => res.send("Serveur opérationnel"));
app.get("/ping", (_, res) => res.status(200).send("OK"));

// 📤 Upload (sans auth)
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const receivedAt = new Date().toISOString();
  const originalName = req.file.originalname;
  const storedAs = req.file.filename;

  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    meta.push({ originalName, storedAs, receivedAt });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");

    io.emit("fileUploaded", { originalName, storedAs, receivedAt });

    return res.json({ message: "File uploaded successfully", originalName, storedAs, receivedAt });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ error: "Erreur serveur lors de l'upload" });
  }
});

// 📥 Liste des fichiers (sans auth)
app.get("/files", (_, res) => {
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    meta.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json(meta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de lire les métadonnées" });
  }
});

// ⬇ Téléchargement (sans auth)
app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  if (filename.includes("..")) return res.status(400).send("Nom de fichier invalide");
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier non trouvé");
  res.download(filePath);
});

// 🔌 Socket.io
io.on("connection", (socket) => {
  console.log("Socket connecté :", socket.id);
  socket.on("disconnect", () => console.log("Socket déconnecté :", socket.id));
});

// 🚀 Start
httpServer.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
