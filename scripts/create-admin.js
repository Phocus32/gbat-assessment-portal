"use strict";

const readline = require("readline");
const { query, pool } = require("../server/db");
const { applySchema } = require("../server/schema");
const { hashPassword } = require("../server/security");
const { nameSchema, usernameSchema, passwordSchema } = require("../server/validation");
const { logActivity } = require("../server/utils");

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("A terminal is required to enter the password securely."));
      return;
    }

    process.stdout.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    }

    function onData(chunk) {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length) value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    }

    stdin.on("data", onData);
  });
}

function firstIssue(result) {
  return result.error.issues[0].message;
}

async function main() {
  await applySchema();

  let name = process.env.ADMIN_NAME || process.argv[2] || "";
  let username = process.env.ADMIN_USERNAME || process.argv[3] || "";

  if (!name) name = (await ask("Admin full name: ")).trim();
  if (!username) username = (await ask("Admin username: ")).trim();

  const nameResult = nameSchema.safeParse(name);
  if (!nameResult.success) throw new Error(firstIssue(nameResult));
  const usernameResult = usernameSchema.safeParse(username);
  if (!usernameResult.success) throw new Error(firstIssue(usernameResult));

  let password = process.env.ADMIN_PASSWORD || "";
  if (!password) {
    password = await readHidden("Password (min 10 chars, upper/lower/number): ");
    const confirmation = await readHidden("Confirm password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
  }

  const passwordResult = passwordSchema.safeParse(password);
  if (!passwordResult.success) throw new Error(firstIssue(passwordResult));

  const duplicate = await query("SELECT id FROM users WHERE username = ? LIMIT 1", [usernameResult.data]);
  if (duplicate.length) throw new Error("That username is already in use.");

  const passwordHash = await hashPassword(passwordResult.data);
  await query(
    `INSERT INTO users (name, username, password_hash, role, must_change_password)
     VALUES (?, ?, ?, 'admin', 0)`,
    [nameResult.data, usernameResult.data, passwordHash]
  );

  await logActivity(null, `Created admin account "${nameResult.data}" (${usernameResult.data})`);
  console.log(`Admin account "${usernameResult.data}" created.`);
}

main()
  .catch(error => {
    console.error(`Could not create admin: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
