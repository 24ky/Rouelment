// middleware/verifyToken.js
import admin from "../firebase.js";

export async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith(" ")) {
    return res.status(401).json({ error: "Token manquant" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // on attache le user à la req
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token invalide" });
  }
}
