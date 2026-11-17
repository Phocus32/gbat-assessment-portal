# GBAT Assessment Portal

Secure online assessment portal for admins, teachers and students. The app is
an Express server with a SQLite database stored in a single file — no separate
database service is needed.

## Run it locally

```bash
npm ci
npm start
```

Open <http://localhost:3000>. On the first run the app creates `data/gbat.db`,
imports the sample questions, sets up three classes and prints the temporary
admin / teacher / student passwords in the terminal (also saved to
`data/initial-credentials.txt`).

```bash
npm run dev     # auto-restart while developing
npm test        # API tests against a temporary SQLite database
```

## Host it online

See **[HOSTING.md](HOSTING.md)** for copy-paste instructions for Render,
Fly.io, Railway, Docker or any VPS. Quick summary:

```bash
docker compose up -d --build
```

Then read the first-run credentials with `docker compose logs gbat`.

## Legacy MySQL mode

Set `DB_DRIVER=mysql` and provide either `DATABASE_URL` or `DB_HOST`,
`DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME`. The original schema is in
`db/schema.sql`; see [DEPLOYMENT.md](DEPLOYMENT.md).
