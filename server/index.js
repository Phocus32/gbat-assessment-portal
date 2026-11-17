"use strict";

const app = require("./app");
const config = require("./config");
const { close } = require("./fdb");
const { ensureBootstrapped } = require("./bootstrap");

async function start() {
  await ensureBootstrapped();

  const server = app.listen(config.port, config.host, () => {
    console.log(`GBAT portal listening on http://${config.host}:${config.port}`);
  });

  async function shutdown(signal) {
    console.log(`${signal} received, shutting down.`);
    server.close(async () => {
      try {
        await close();
      } finally {
        process.exit(0);
      }
    });

    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

const started = start().catch(error => {
  console.error(`[gbat] Startup failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = started;
