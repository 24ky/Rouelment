import admin from "firebase-admin";
import { getApps } from "firebase-admin/app";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (serviceAccount.private_key) {
  // Remplace les \n littéraux par de vrais retours à la ligne dans la clé privée
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

if (!getApps().length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export default admin;
