"use strict";

/**
 * One-time setup for direct browser uploads in Learning Materials.
 *
 * The signed upload URL points at storage.googleapis.com, so the bucket must
 * return CORS headers for the app origin. This script writes the CORS policy
 * with the service-account credentials already used by the server.
 */

const config = require("../server/config");
const { bucketName, configureStorageCors } = require("../server/storage");

async function main() {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("Unset FIRESTORE_EMULATOR_HOST before configuring a real bucket.");
  }

  const { clientEmail, privateKey, serviceAccountJson } = config.firebase;
  if (!serviceAccountJson && !(clientEmail && privateKey)) {
    throw new Error(
      "Set FIREBASE_SERVICE_ACCOUNT or FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY before running this script."
    );
  }

  console.log(`Configuring CORS for project ${config.firebase.projectId} (${bucketName()} first)...`);
  const result = await configureStorageCors();
  console.log(`CORS configured on ${result.bucket}.`);
  if (!config.firebase.storageBucket) {
    console.log(`Recommended Vercel variable: FIREBASE_STORAGE_BUCKET=${result.bucket}`);
  }
  console.log(JSON.stringify(result.cors, null, 2));
}

main().catch(error => {
  console.error(`[storage-cors] ${error.message}`);
  process.exit(1);
});
