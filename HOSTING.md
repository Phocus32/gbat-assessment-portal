# Hosting the GBAT Assessment Portal

The app now runs as **one service with one SQLite database file**. There is no
MySQL server to install and no manual `setup-db` / `create-admin` step. On first
boot the app creates the schema, imports the sample questions from `index.html`,
creates the classes, a teacher, a quiz per class and demo students, then prints
all temporary passwords once.

> **Node.js 22.13+ is required** because the app uses the built-in `node:sqlite`
> module. Node 24 LTS is used in the Dockerfile.

---

## 1. Choose a host

### A. Render (easiest, ~US$7/month)

`render.yaml` is already configured with a 1 GB persistent disk.

1. Push this folder to GitHub / GitLab / Bitbucket.
2. In Render: **New → Blueprint** → select the repository.
3. Name the service and deploy. Render builds the `Dockerfile` and mounts the
   disk at `/data`.
4. Open `https://<your-service>.onrender.com/api/health` → `{"ok":true}`.
5. In **Logs**, find the `GBAT portal is ready` block with the first-run
   usernames and passwords. Sign in as `admin`, change the password, then set up
   your real classes/students.

> Render's free plan has **no persistent disk**. Use the paid Starter plan or
> your data will disappear on restart. A disk-backed service runs one instance
> and has a few seconds of downtime during deploys — that is expected.

### B. Any VPS with Docker (DigitalOcean, Hetzner, your own server)

```bash
git clone <your-repo-url> gbat-quiz
cd gbat-quiz
docker compose up -d --build
```

- App: `http://YOUR_SERVER_IP:3000`
- Data: Docker volume `gbat-assessment-portal_gbat-data`
- Credentials: `docker compose logs gbat` (first run only)
- Stop: `docker compose down` (data is kept)

Put a reverse proxy (Caddy/Nginx) in front for HTTPS and set
`APP_ORIGIN=https://your.domain` in `docker-compose.yml` when you do.

### C. Fly.io (~US$2–4/month)

```bash
fly auth login
fly apps create gbat-assessment-portal   # pick a unique name; edit fly.toml to match
fly volumes create gbat_data --size 1 --region iad
fly deploy
fly logs        # first-run credentials
```

Keep **one machine**: a Fly volume can only be attached to one machine.
`fly.toml` already keeps the machine warm so exam timers are not interrupted.

### D. Railway (~US$5/month)

1. **New Project → Deploy from GitHub repo**. Choose **Dockerfile** as the
   builder (Railway will find the `Dockerfile` at the repo root).
2. In the service settings add a **volume** mounted at `/data`, then set
   `DATA_DIR=/data` and `SQLITE_PATH=/data/gbat.db`.
3. Set the health check path to `/api/health`, generate a domain and open it.
4. Read credentials from the deploy logs.

> Railway's config-as-code (`railway.json`) is being retired for new services,
> so treat the included file as a reference only. The volume **must** be added
> in the dashboard or the database file will be lost on redeploy.

---

## 2. First-run accounts

On a brand-new database the startup log contains something like:

```
============================================================
 GBAT portal is ready
 Admin: admin / XnKK@n4uuw%HHjG6
 Teacher: gbat.teacher / *cg5pQ#zMpuSnP8M
 Student (SHS 1A): demo.shs1a / %uz9S9FYyor$&4nT
 Saved once to: /data/initial-credentials.txt
============================================================
```

- Every account must change its password at first sign-in.
- The same list is written to `<DATA_DIR>/initial-credentials.txt`. Delete that
  file after you have saved the passwords.
- To choose the admin password yourself, set `ADMIN_USERNAME` and
  `ADMIN_PASSWORD` before the first boot.
- To skip demo classes/quizzes/students, set `SEED_DEMO=false`. Only an admin
  account will be created; you can import students from Excel in the dashboard.

---

## 3. Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` (no setup) or `mysql` (existing deployments) |
| `DATA_DIR` | `./data` | Folder for the database and generated JWT secret |
| `SQLITE_PATH` | `<DATA_DIR>/gbat.db` | SQLite file — **must be on a persistent disk** |
| `JWT_SECRET` | auto-generated into `DATA_DIR` | Signing key; if you set it, keep it stable |
| `SEED_DEMO` | `true` | Set `false` for an empty portal with just an admin |
| `ADMIN_USERNAME` | `admin` | First-run admin username |
| `ADMIN_PASSWORD` | random | First-run admin password (otherwise printed once) |
| `APP_ORIGIN` | `http://localhost:PORT` | Public URL (informational) |
| `COOKIE_SECURE` | auto in production | Set `true` when serving HTTPS |
| `TRUST_PROXY` | auto in production | Set `true` behind Render/Fly/Nginx |
| `JWT_EXPIRES_IN` | `4h` | Session lifetime |
| `AUTO_MIGRATE` | `true` | Apply schema on startup; set `false` to manage manually |

For MySQL mode, set `DB_DRIVER=mysql` and either `DATABASE_URL` or
`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`. The original MySQL
schema in `db/schema.sql` still works.

---

## 4. Backups (important)

SQLite is a single file, so a backup is a file copy. When the app is running,
copy the WAL files together:

```bash
cp /path/to/data/gbat.db* /backup/location/
```

Or use SQLite's online backup API from the host:

```bash
node -e "const s=require('node:sqlite');(async()=>{await s.backup(new s.DatabaseSync('/path/to/data/gbat.db'),'/backup/gbat.db')})()"
```

Restore by stopping the app, replacing `gbat.db`, `gbat.db-wal` and
`gbat.db-shm`, then starting it again. Render takes daily disk snapshots; Fly
takes volume snapshots. Keep your own copy as well.

---

## 5. Day-two operations

```bash
# Add a second admin (interactive on your machine)
npm run create-admin

# Re-apply the schema / migrations
npm run setup-db

# Re-import questions or refresh demo content (idempotent)
npm run import-html
npm run seed-portal

# Run the API test suite (uses a temporary SQLite file)
npm test
```

When running against the deployed database from your laptop, pass the same
`SQLITE_PATH`/`DB_*` environment variables; for SQLite it is simpler to copy the
database file locally first.

---

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot find module 'node:sqlite'` | Use Node 22.13+ (Node 24 recommended) |
| Data resets after redeploy | The SQLite file is not on a persistent disk/volume |
| Login loop or cookie rejected | Set `COOKIE_SECURE=true` and `TRUST_PROXY=true` behind HTTPS proxy |
| `Missing required environment variable: DB_USER` | `DB_DRIVER` is set to `mysql`; switch it to `sqlite` or provide DB credentials |
| No credentials in the log | They are only printed on the first boot; check `data/initial-credentials.txt` or reset the password from the admin dashboard |
