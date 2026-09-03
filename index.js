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

import ImageKit from "imagekit";
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const raw = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (raw.private_key) raw.private_key = raw.private_key.replace(/\\n/g, "\n");

if (!getApps().length) {
  admin.initializeApp({ credential: admin.credential.cert(raw) });
}
const db = getFirestore();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(process.cwd(), "uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

if (!process.env.IMAGEKIT_PUBLIC_KEY || !process.env.IMAGEKIT_PRIVATE_KEY || !process.env.IMAGEKIT_URL_ENDPOINT) {
  throw new Error("Variables ImageKit manquantes !");
}

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
  io.emit('pingStatus', msg);
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier sélectionné." });

    const filePath = path.join(UPLOAD_DIR, req.file.filename);
    const fileBuffer = await fsPromises.readFile(filePath);

    const result = await imagekit.upload({
      file: fileBuffer,
      fileName: req.file.filename,
      folder: "/uploads",
    });

    await fsPromises.unlink(filePath);

    const receivedAt = new Date().toISOString();
    const originalName = req.file.originalname;
    const storedAs = req.file.filename;

    await db.collection("uploads").add({
      originalName,
      storedAs,
      fileId: result.fileId,
      filePath: result.filePath, // ✅ chemin correct vers le fichier
      receivedAt,
    });

    await sendNotificationToAll("Nouveau fichier reçu", `"${originalName}"`);
    io.emit("fileUploaded", { originalName, storedAs, receivedAt });

    res.json({ message: "Fichier envoyé ✅", originalName, storedAs, receivedAt });
  } catch (err) {
    console.error("Upload error:", err);
    let msg = "Erreur serveur";
    if (err.statusCode === 413) msg = "Fichier trop lourd (max ~25 MB).";
    if (err.statusCode === 401) msg = "Clés ImageKit invalides.";
    res.status(500).json({ error: msg });
  }
});

// ✅ Endpoint /health - toujours accessible
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase_initialized: !!admin.apps.length,
    imagekit_configured: !!process.env.IMAGEKIT_PUBLIC_KEY,
    upload_dir_exists: fs.existsSync(UPLOAD_DIR)
  });
});

// ✅ Endpoint /files - avec fallback si Firestore échoue
app.get("/files", async (req, res) => {
  try {
    // Vérifier si Firestore est initialisé
    if (!admin.apps.length || !db) {
      console.warn('⚠️ Firestore non initialisé - retourne liste vide');
      return res.json([]);
    }
    
    const snap = await db.collection("uploads").orderBy("receivedAt", "desc").get();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(list);
  } catch (err) {
    console.error('❌ Erreur /files:', err.message);
    // En cas d'erreur, retourner une liste vide (pas d'erreur 500)
    res.json([]);
  }
});

// ✅ Endpoint /download - avec fallback
app.get("/download/:filename", async (req, res) => {
  const filename = req.params.filename;
  if (filename.includes("..")) {
    return res.status(400).send("Nom invalide");
  }
  
  try {
    if (!admin.apps.length || !db) {
      console.warn('⚠️ Firestore non initialisé - retourne 404');
      return res.status(404).send("Service non disponible");
    }
    
    const snap = await db.collection("uploads").where("storedAs", "==", filename).limit(1).get();
    if (snap.empty) {
      return res.status(404).send("Fichier non trouvé");
    }

    const { filePath, originalName } = snap.docs[0].data();
    
    if (!process.env.IMAGEKIT_PUBLIC_KEY) {
      // Fallback: retourner un message d'erreur
      return res.status(503).send("Service de téléchargement non disponible");
    }

    const url = imagekit.url({
      path: filePath,
      expiresIn: 3600,
      responseHeaders: {
        "Content-Disposition": `attachment; filename="${originalName || filename}"`,
      },
    });

    res.redirect(url);
  } catch (e) {
    console.error("Download error", e);
    res.status(500).send("Erreur serveur");
  }
});

// ✅ Endpoint /test-firestore
app.get('/test-firestore', async (req, res) => {
  try {
    if (!admin.apps.length || !db) {
      return res.status(503).json({ 
        error: 'Firestore non initialisé',
        firebase_initialized: !!admin.apps.length
      });
    }
    
    const testDoc = await db.collection('test').add({
      timestamp: new Date().toISOString(),
      message: 'Test Firestore'
    });
    
    await db.collection('test').doc(testDoc.id).delete();
    res.json({ 
      success: true, 
      message: 'Firestore fonctionne correctement',
      testId: testDoc.id
    });
  } catch (error) {
    console.error('❌ Erreur Firestore:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.head("/exists/:filename", async (req, res) => {
  const filename = req.params.filename;
  if (filename.includes("..")) return res.status(400).send("Nom invalide");

  try {
    const snap = await db.collection("uploads").where("storedAs", "==", filename).limit(1).get();
    if (snap.empty) return res.status(404).send("Non trouvé");
    res.status(200).send("Existe");
  } catch (e) {
    console.error("Exists error", e);
    res.status(500).send("Erreur serveur");
  }
});

io.on("connection", (socket) => {
  console.log("Socket connecté :", socket.id);
  socket.on("disconnect", () => console.log("Socket déconnecté :", socket.id));
});

httpServer.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));

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
