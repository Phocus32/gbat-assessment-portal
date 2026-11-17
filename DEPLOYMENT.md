# GBAT Assessment Portal — Render Deployment Guide

> **New: single-service hosting is now the easiest option.** The app defaults
> to SQLite and self-initializes on first boot. See **[HOSTING.md](HOSTING.md)**
> for the recommended one-service deploy (Render, Fly.io, Railway or Docker).
> The guide below still applies only if you prefer the original MySQL setup.

## Architecture

- **Runtime:** Node.js ≥ 20 (Express 5 + mysql2)
- **Web service:** Serves the API + static frontend (from `public/`) on a single origin
- **Database:** MySQL / MariaDB (external — Render's free DB tier is PostgreSQL, which is incompatible)
- **TLS:** Terminated by Render at the edge; app runs behind proxy (`TRUST_PROXY=true`)

## 1. Prerequisites

- Git repository (GitHub / GitLab / Bitbucket)
- A MySQL / MariaDB database (Railway, PlanetScale, Azure, or self-managed)
- A Render account

## 2. Database setup

Before or shortly after deploy, set up the database:

```bash
npm run setup-db
```

This applies `db/schema.sql` plus lightweight column migrations.

Create the first admin account:

```bash
npm run create-admin
# or: ADMIN_NAME="…" ADMIN_USERNAME="…" ADMIN_PASSWORD="…" npm run create-admin
```

## 3. Deploy on Render

### Option A — Blueprint (recommended)

1. Push this repository to Git.
2. In the Render dashboard: **New → Blueprint**, select the repo.
3. Render reads `render.yaml` and proposes the `gbat-assessment-portal` web service.
4. When prompted, provide the external database credentials:
   - `DB_HOST`, `DB_PORT` (3306), `DB_USER`, `DB_PASSWORD`, `DB_NAME`
5. Deploy.

### Option B — Manual

1. **New → Web Service** → connect the repo.
2. Runtime: **Node**
3. Build command: `npm ci`
4. Start command: `npm start`
5. Health check path: `/api/health`
6. Node version: `20`
7. Add environment variables (below).
8. Deploy.

## 4. Production environment variables

| Key | Value / guidance |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `20` |
| `HOST` | `0.0.0.0` |
| `PORT` | assigned by Render (do not hardcode) |
| `APP_ORIGIN` | `https://<your-app>.onrender.com` |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `true` |
| `JWT_SECRET` | new random secret, ≥ 32 chars |
| `DB_HOST` | external MySQL host |
| `DB_PORT` | `3306` |
| `DB_USER` | DB user |
| `DB_PASSWORD` | DB password |
| `DB_NAME` | DB name |
| `DB_CONNECTION_LIMIT` | `10` |
| `JWT_EXPIRES_IN` | `4h` |
| `BCRYPT_ROUNDS` | `12` |
| `LOGIN_MAX_ATTEMPTS` | `5` |
| `LOGIN_LOCK_MINUTES` | `15` |
| `LOGIN_RATE_MAX` | `100` |
| `API_RATE_MAX` | `5000` |
| `EXAM_GRACE_SECONDS` | `20` |

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 5. Post-deploy verification

1. `GET /api/health` → `{"ok":true}`
2. `curl -I https://<your-app>` → expect HSTS, `X-Content-Type-Options`, `X-Frame-Options`, CSP headers.
3. Sign in → session cookie must include:
   - `HttpOnly`
   - `Secure`
   - `SameSite=Strict`
4. Confirm no mixed content / blocked resources in the browser console.

## 6. Free-tier notes

- Render free web services spin down after ~15 min of inactivity — may affect live exam timers.
- Free web instance has limited memory (512 MB) — bcrypt at cost 12 should still be fine.
- The database must be an external MySQL provider (not Render's free PostgreSQL tier).

## 7. Rollback / next steps

- To redeploy: push to the branch Render auto-deploys from, or use "Manual Deploy" in the dashboard.
- To change env vars: Render dashboard → service → Environment.
