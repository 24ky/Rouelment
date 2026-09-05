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

// 📤 Upload fichier - VERSION SIMPLIFIÉE
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    // Vérifier que le fichier existe
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier sélectionné" });
    }

    // 🔥 Vérifier la taille (Multer nous donne déjà req.file.size)
    if (req.file.size === 0) {
      // Nettoyer le fichier temporaire
      if (req.file.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      return res.status(400).json({ error: "Le fichier est vide (0 bytes)" });
    }

    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    console.log(`📤 Upload: ${originalName} (${req.file.size} bytes)`);

    // 🔥 Upload vers Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      resource_type: "raw",
      public_id: `${Date.now()}-${uuidv4()}`,
      display_name: originalName,
    });

    // Nettoyer le fichier temporaire
    if (req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }

    const fileData = {
      id: result.public_id,
      originalName: originalName,
      fileSize: req.file.size,
      url: result.secure_url,
      createdAt: new Date().toISOString(),
    };

    console.log(`✅ Upload réussi: ${originalName}`);
    io.emit("fileUploaded", fileData);

    res.json({ success: true, file: fileData });

  } catch (err) {
    console.error("❌ Erreur upload:", err);
    
    // Nettoyer en cas d'erreur
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    
    res.status(500).json({ error: err.message });
  }
});


// 📋 Liste des fichiers - VERSION CORRIGÉE
app.get("/files", async (req, res) => {
  try {
    console.log("📁 Récupération de la liste des fichiers...");

    const result = await cloudinary.api.resources({
      resource_type: "raw",
      type: "upload",
      max_results: 500,  // ✅ Plus de préfixe
    });

    const files = result.resources.map(file => {
      // 🔥 Extraire l'ID sans le préfixe "files/" si présent
      let cleanId = file.public_id;
      if (cleanId.startsWith('files/')) {
        cleanId = cleanId.replace('files/', '');
      }
      
      return {
        id: cleanId,
        storedAs: cleanId,
        originalName: file.display_name || file.public_id.split("/").pop(),
        fileSize: file.bytes,
        url: file.secure_url,
        createdAt: file.created_at,
        format: file.format,
      };
    });

    console.log(`📁 ${files.length} fichiers trouvés`);
    res.json(files);

  } catch (err) {
    console.error("❌ Erreur /files:", err);
    res.status(500).json({ error: err.message });
  }
});

// 📥 Télécharger un fichier - VERSION REDIRECTION
app.get("/download/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📥 Téléchargement demandé: ${id}`);

    // Nettoyer l'ID
    let cleanId = id;
    if (cleanId.startsWith('files/')) {
      cleanId = cleanId.replace('files/', '');
    }
    
    console.log(`🔍 ID nettoyé: ${cleanId}`);

    // 🔥 Vérifier si le fichier existe
    const result = await cloudinary.api.resource(cleanId, { 
      resource_type: "raw" 
    });
    console.log(`✅ Fichier trouvé: ${result.public_id}`);

    // 🔥 URL de téléchargement direct
    const downloadUrl = cloudinary.url(cleanId, {
      resource_type: "raw",
      flags: "attachment",
      display_name: result.display_name || cleanId.split("/").pop(),
    });

    console.log(`📥 Redirection vers: ${downloadUrl}`);
    
    // 🔥 Rediriger le client vers Cloudinary
    res.redirect(downloadUrl);

  } catch (err) {
    console.error("❌ Erreur téléchargement:", err);
    res.status(404).json({ 
      error: "Fichier non trouvé",
      id: req.params.id
    });
  }
});


// ==================== CORS CONFIGURATION ====================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  exposedHeaders: ['Content-Disposition', 'Content-Length']
}));

// 🔥 Gérer les requêtes OPTIONS
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  res.sendStatus(200);
});

// 🗑️ Supprimer un fichier - VERSION CORRIGÉE
app.delete("/files/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️ Suppression du fichier: ${id}`);

    if (!id) {
      return res.status(400).json({ error: "ID manquant" });
    }

    // 🔥 CORRECTION : Nettoyer l'ID
    let cleanId = id;
    if (cleanId.startsWith('files/')) {
      cleanId = cleanId.replace('files/', '');
    }

    const result = await cloudinary.uploader.destroy(cleanId, {
      resource_type: "raw",
    });

    if (result.result === "ok") {
      io.emit("fileDeleted", { 
        id: cleanId,
        timestamp: new Date().toISOString(),
        deletedBy: req.ip || "unknown"
      });
      
      res.json({ success: true, message: "Fichier supprimé" });
    } else {
      res.status(404).json({ error: "Fichier non trouvé" });
    }

  } catch (err) {
    console.error("❌ Erreur suppression:", err);
    res.status(500).json({ error: err.message });
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
