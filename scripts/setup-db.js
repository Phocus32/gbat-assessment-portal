"use strict";

/**
 * Firestore is schema-less, so there is nothing to migrate. This command just
 * verifies that the app can reach the configured Firebase project.
 */
const { getDb, close } = require("../server/fdb");

async function main() {
  const db = getDb();
  const collections = await db.listCollections();
  console.log(`[gbat] Firestore connection ready (${collections.length} collection(s)).`);
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(`Firestore connection failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await close();
    });
}

module.exports = { main };
