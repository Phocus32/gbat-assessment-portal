"use strict";

const { applySchema } = require("../server/schema");
const { pool } = require("../server/db");

async function main() {
  await applySchema();
  console.log(`[gbat] Schema ready (${require("../server/config").db.driver}).`);
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(`Database setup failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}

module.exports = { main };
