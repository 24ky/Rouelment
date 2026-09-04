import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { v2 as cloudinary } from "cloudinary";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Configuration Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ✅ Initialisation Express
const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "DELETE"]
  }
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(process.cwd(), "temp");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ✅ Multer pour recevoir les fichiers
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error("Type de fichier non autorisé"));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// ==================== ENDPOINTS ====================

// 🏥 Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    cloudinary: !!process.env.CLOUDINARY_CLOUD_NAME,
  });
});

// 📤 Upload fichier
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier sélectionné" });
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const fileSize = req.file.size;

    console.log(`📤 Upload en cours: ${originalName} (${fileSize} bytes)`);

    // Upload vers Cloudinary
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: "raw",
      public_id: `files/${Date.now()}-${uuidv4()}`,
      display_name: originalName,
    });

    // Supprimer le fichier temporaire
    fs.unlinkSync(filePath);

    const fileData = {
      id: result.public_id,
      originalName,
      fileSize,
      url: result.secure_url,
      createdAt: new Date().toISOString(),
    };

    console.log(`✅ Fichier uploadé: ${originalName} (${result.public_id})`);

    // Notifier tous les clients connectés
    io.emit("fileUploaded", fileData);

    res.json({
      success: true,
      message: "Fichier uploadé avec succès",
      file: fileData,
    });

  } catch (err) {
    console.error("❌ Erreur upload:", err);
    res.status(500).json({ error: err.message });
  }
});

// 📋 Liste des fichiers
app.get("/files", async (req, res) => {
  try {
    console.log("📁 Récupération de la liste des fichiers...");

    const result = await cloudinary.api.resources({
      resource_type: "raw",
      type: "upload",
      prefix: "files/",
      max_results: 500,
    });

    const files = result.resources.map(file => ({
      id: file.public_id,
      originalName: file.display_name || file.public_id.split("/").pop(),
      fileSize: file.bytes,
      url: file.secure_url,
      createdAt: file.created_at,
      format: file.format,
    }));

    console.log(`📁 ${files.length} fichiers trouvés`);
    res.json(files);

  } catch (err) {
    console.error("❌ Erreur /files:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🗑️ Supprimer un fichier
app.delete("/files/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️ Suppression du fichier: ${id}`);

    const result = await cloudinary.uploader.destroy(id, {
      resource_type: "raw",
    });

    if (result.result === "ok") {
      io.emit("fileDeleted", { id });
      res.json({ success: true, message: "Fichier supprimé" });
    } else {
      res.status(404).json({ error: "Fichier non trouvé" });
    }

  } catch (err) {
    console.error("❌ Erreur suppression:", err);
    res.status(500).json({ error: err.message });
  }
});

// 📥 Télécharger un fichier (redirection Cloudinary)
app.get("/download/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📥 Téléchargement demandé: ${id}`);

    // Vérifier que le fichier existe
    const result = await cloudinary.api.resource(id, { resource_type: "raw" });

    // Rediriger vers l'URL Cloudinary
    const downloadUrl = cloudinary.url(id, {
      resource_type: "raw",
      flags: "attachment",
      display_name: result.display_name || id.split("/").pop(),
    });

    res.redirect(downloadUrl);

  } catch (err) {
    console.error("❌ Erreur téléchargement:", err);
    res.status(404).json({ error: "Fichier non trouvé" });
  }
});

// 🔌 WebSocket
io.on("connection", (socket) => {
  console.log(`🔌 Client connecté: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`🔌 Client déconnecté: ${socket.id}`);
  });
});

// ==================== PING ====================
app.get("/ping", (req, res) => {
  const msg = `🔔 Ping reçu de ${req.ip}`;
  console.log(`[${new Date().toISOString()}] ${msg}`);
  io.emit("pingStatus", msg);
  res.send("OK");
});

// ==================== DÉMARRAGE ====================
httpServer.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
  console.log(`📁 Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? "✅" : "❌"}`);
});
