"use strict";

const fs = require("fs");
const path = require("path");
const compression = require("compression");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { ZodError } = require("zod");

const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");
const teacherRouter = require("./routes/teacher");
const studentRouter = require("./routes/student");
const submissionsRouter = require("./routes/submissions");
const config = require("./config");
const { authenticate, requireRole, requirePasswordChanged } = require("./security");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// index.html is never cached. Assets carry a manual ?v= token in that HTML so
// browsers can cache them immutably and a token bump busts the cache on deploy.
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

app.use(compression({ threshold: 1024 }));

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
     "upgrade-insecure-requests": config.env === "production" ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.apiRateMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
  }
}));

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
});

app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  if (req.get("X-Requested-With") !== "XMLHttpRequest") {
    return res.status(403).json({ error: "Invalid request." });
  }

  const origin = req.get("Origin");
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== req.get("host")) {
      return res.status(403).json({ error: "Invalid request origin." });
    }
  }

  return next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);

app.use("/api/admin", authenticate, requirePasswordChanged, requireRole("admin"), adminRouter);
app.use("/api/teacher", authenticate, requirePasswordChanged, requireRole("teacher"), teacherRouter);
app.use("/api/student", authenticate, requirePasswordChanged, requireRole("student"), studentRouter);
app.use("/api/submissions", authenticate, requirePasswordChanged, submissionsRouter);

app.get(["/", "/index.html"], (req, res) => {
  res.type("html")
    .set("Cache-Control", "no-store, no-cache, must-revalidate, private")
    .send(INDEX_HTML);
});

app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    const version = res.req && res.req.query ? res.req.query.v : null;
    const isVersioned = typeof version === "string" && /^[\w-]{1,32}$/.test(version);
    if (isVersioned) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (path.extname(filePath) === ".html") {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    } else {
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    }
  }
}));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});

app.use((req, res) => {
  res.status(404).send("Not found");
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    const first = err.issues[0];
    return res.status(400).json({ error: first ? first.message : "Invalid input." });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }

  if (err.code === "ER_DUP_ENTRY") {
    return res.status(409).json({ error: "That record already exists." });
  }

  if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_ROW_IS_REFERENCED_2") {
    return res.status(409).json({ error: "That action conflicts with existing records." });
  }

  if (err.name === "MulterError") {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      error: err.code === "LIMIT_FILE_SIZE"
        ? "The uploaded file is too large. Check the upload limit for this form."
        : "Could not read that upload."
    });
  }

  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error(err);
  return res.status(500).json({ error: "Something went wrong. Please try again." });
});

module.exports = app;
