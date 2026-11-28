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

## Brain Sprint

- Students can play **Brain Sprint** at any time as practice. It uses procedural
  number, sequence and pattern puzzles, so it never reads the class question bank.
- Each round lasts 60 seconds. A correct answer earns 100 points × the current
  streak multiplier (starts at 1×, rises by 0.25× per correct answer, capped at
  3×). A wrong answer resets the streak and costs 5 seconds.
- The first completed round each UTC day adds a 100-point bonus. Finishing twice
  cannot award the bonus twice.
- Brain Sprint scores live in `game_sessions`, `game_scores`, `game_active` and
  `game_daily`. They appear only on the school-wide Brain Sprint leaderboard and
  never enter exam submissions, XP, badges or the class leaderboard.

## Word Quest

- Students can play **Word Quest** at any time as a practice puzzle. The server
  generates a 10×10 board with seven hidden words and keeps the placements
  private; the browser only receives the letters, clues and target words.
- Each round lasts 90 seconds. A correct find earns 60 points × the current combo
  multiplier (starts at 1×, rises by 0.25× per find, capped at 2.5×). A miss
  resets the combo and adds 3 seconds. A hint reveals one cell for up to 30
  points.
- The first completed round with a find each UTC day adds a 100-point bonus.
  Finishing twice cannot award the bonus twice.
- Word Quest data lives in `word_sessions`, `word_scores`, `word_active` and
  `word_daily`. It appears only on the school-wide Word Quest leaderboard and
  never enters exams, XP, badges, class standings or Brain Sprint scores.

## Class discussion and AI guide

- Students can start class-only threads, reply and report posts. Teachers see
  only their assigned classes; admins see every class. Posts are checked by basic
  profanity/spam filters, and staff can hide reported content.
- Discussion data lives in `discussion_threads`, `discussion_replies` and
  `discussion_reports`. It never touches attempts, submissions, XP or results.
- The **AI Guide** drawer is available across the portal. It uses Gemini
  server-side with `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) and defaults to
  `gemini-3.8-flash`; set `GEMINI_MODEL` to override the model.
- The guide never receives quiz questions, options, solutions or Brain Sprint
  puzzle state. Requests for exam answers, exact practice answers, secrets or
  prompt injection are blocked before Gemini is called, and every turn is
  logged in `ai_guide_logs` for staff review.

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
