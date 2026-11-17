# GBAT Assessment Portal

Secure online assessment portal for admins, teachers and students.

The app is a single Express service with **Cloud Firestore** as its only
database. It is designed for Vercel's free Hobby plan plus Firebase's free
Spark plan: no server to maintain, no disk, and no separate database host to
configure.

## Run it locally

```bash
npm ci
cp .env.example .env   # Windows: copy .env.example .env
# add Firebase credentials to .env, or use the emulator below
npm start
```

Open <http://localhost:3000>. On a brand-new project the app imports the sample
questions, creates the classes, a teacher, a quiz per class and demo students,
then prints the temporary passwords once in the terminal.

```bash
npm run dev     # auto-restart while developing
npm test        # API tests against the Firestore emulator (Java 21+ required)
```

To develop without touching real Firebase data:

```bash
npm run emulators
# in a second terminal:
# FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm start
```

## Host it online

See **[HOSTING.md](HOSTING.md)** for the full Vercel + Firebase walkthrough.

Short version:

1. Create a Firebase project and enable Cloud Firestore.
2. Generate a Firebase service account and add its values to Vercel.
3. Add a strong `JWT_SECRET` to Vercel.
4. Import this GitHub repository into Vercel and deploy.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run setup-db` | Verify the Firestore connection (no schema migration needed) |
| `npm run import-html` | Refresh the question bank from `questions-source.html` |
| `npm run seed-portal` | Add demo classes/quizzes/students if missing |
| `npm run create-admin` | Create an additional admin interactively |
| `npm run import-students -- students.csv` | Import students from CSV |
