# Learners Connect

Learners Connect is a secure online assessment portal for admins, teachers and students.

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

A development JWT secret is generated into `./data` (override with
`DATA_DIR`) unless `JWT_SECRET` is set.

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

## Sessions and complaints

- Inactive sessions are signed out automatically (default: 1 minute idle, with a
  15-second warning). Set `IDLE_TIMEOUT_MINUTES`, `IDLE_WARNING_SECONDS` and
  `IDLE_HEARTBEAT_SECONDS` in `.env` to change this. Activity in any open tab
  keeps the session alive; an in-progress exam pauses the countdown.
- Classes are managed as batches of students: admins can add, move and remove
  students from each class and search accounts and classes by name.
- Practice mode is controlled per quiz. Teachers can enable/disable it on their
  own quizzes, admins can override any quiz, and the server blocks students
  from starting or continuing disabled practice attempts.
- Teachers and students can submit complaints; admins see all complaints, can
  filter/search them, reply and close/reopen them.

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
| `npm run import-students -- students.csv` | Import students from CSV (optionally write credentials with `--out credentials.csv`) |
