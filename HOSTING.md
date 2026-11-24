# Host Learners Connect on Vercel + Firebase

This setup uses:

- **Vercel Hobby** (free, personal/school use) for the Express app and static files.
- **Firebase Spark** (free, no card) with **Cloud Firestore** for all data.

There is no SQL database, no persistent disk, no Docker file and no server to
keep alive. The browser never sees Firebase credentials; every request goes
through the Vercel function, which uses the Firebase Admin SDK.

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com/> and choose **Add project**.
2. Name it something like `gbat-assessment-portal`. Google Analytics is not needed.
3. In the left menu choose **Build → Firestore Database → Create database**.
4. Choose a region close to your users and start in **Production mode**.
5. Open **Project settings → Service accounts**.
6. Click **Generate new private key** and download the JSON file. Treat it like a password.

Keep the downloaded file safe. You will copy three values from it into Vercel.

---

## 2. Import the GitHub repository into Vercel

1. Go to <https://vercel.com/new> and import `Phocus32/gbat-assessment-portal`.
2. Do **not** change the build command or output directory.
3. Add these environment variables before deploying:

| Name | Value |
| --- | --- |
| `FIREBASE_PROJECT_ID` | `project_id` from the service-account JSON |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the JSON |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the JSON, including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` |
| `JWT_SECRET` | A random string of at least 32 characters (see below) |
| `SEED_DEMO` | `false` recommended for a real deployment |
| `FIREBASE_STORAGE_BUCKET` | Optional; the app detects either `<project-id>.appspot.com` or `<project-id>.firebasestorage.app` |

Generate `JWT_SECRET` locally:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Alternative: instead of the three `FIREBASE_*` values, set
`FIREBASE_SERVICE_ACCOUNT` to the entire JSON file as a single line. Do not set
both forms at once.

Optional first-boot variables:

| Name | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Choose the first admin username (default `admin`) |
| `ADMIN_PASSWORD` | Choose the first admin password; otherwise one is generated |
| `ADMIN_NAME` | Display name for the first admin |
| `IMPORT_TEACHER_USERNAME` | Username of the teacher who owns imported questions |
| `IMPORT_TEACHER_NAME` | Display name for that teacher |

> Firebase private keys often contain real line breaks. Vercel supports
> multi-line values; paste them as-is. The app also accepts literal `\n`
> characters. Never commit this JSON or put it in `public/`.

### Learning materials storage (one-time)

When a Cloud Storage bucket exists, file uploads go straight from the browser
to Firebase Storage through a short-lived signed form policy, so they do not
need bucket CORS. Firebase projects on the current pay-as-you-go plan create a
`<project-id>.firebasestorage.app` bucket automatically; projects without a
bucket use a Firestore-backed chunked upload fallback instead, so materials
still work without extra setup. The `storage:cors` command below is kept for
deployments that still use the older signed-PUT flow or other browser clients.
After the Firebase variables above are set **on your machine**, run:

```bash
npm run storage:cors
```

That writes a CORS rule for `GET`, `PUT`, and `HEAD` with the `Content-Type`
header. It checks both bucket naming formats and prints the one it configured;
copy that value into `FIREBASE_STORAGE_BUCKET` in Vercel if you want to skip
detection on future cold starts. By default the rule allows any origin, which
is safe because the signed URL is the actual access control. Set
`MATERIAL_CORS_ORIGINS` to a comma-separated list such as
`https://learnersconnect.vercel.app,http://localhost:3000` if you want to
restrict it. Re-run the command whenever that list or the deployment domain
changes.

The account in the Firebase credentials needs permission to update bucket
metadata (the **Storage Admin** role works). If you prefer the Google Cloud
CLI, apply the equivalent CORS JSON with `gcloud storage buckets update`.

4. Click **Deploy**. The first request runs the one-time bootstrap.

---

## 3. First sign-in

1. Open the deployment URL and check `/api/health` → `{"ok":true}`.
2. Open the **Functions** log in Vercel and find the `Learners Connect is ready` block:

   ```text
   Learners Connect is ready
   admin / XnKK@n4uuw%HHjG6
   ```

3. Sign in with those credentials. Every generated account must change its
   password at first sign-in.
4. Change the admin password immediately.

If you set `ADMIN_PASSWORD`, that value is used only when the database is
completely empty. Changing the environment variable later does not reset an
existing password — use the admin dashboard instead.

### Demo data

With the default `SEED_DEMO=true`, the first boot also creates:

- three classes from `questions-source.html`,
- a teacher account owning the imported question bank,
- one diagnostic quiz per class,
- one demo student per class,
- a welcome announcement.

For a clean portal set `SEED_DEMO=false`; only the admin account is created.

> Credentials are printed to the first boot log. Vercel's filesystem is
> read-only/ephemeral, so they are not written to a file there. Save them as
> soon as the deployment finishes.

---

## 4. How the data is stored

Firestore collections:

| Collection | Contents |
| --- | --- |
| `users` | Admins, teachers and students (password hashes included) |
| `classes` | Classes |
| `questions` | Teacher question bank |
| `quizzes` | Quiz metadata; questions are in `quizzes/{id}/items/{position}` |
| `attempts` | Exam/practice attempts; answers are in `attempts/{id}/answers/{position}` |
| `submissions` | Graded results with answers embedded |
| `announcements`, `activity_logs`, `settings` | Supporting data |
| `usernames`, `class_names`, `meta` | Uniqueness locks and ID counters |

Numeric IDs are preserved from the old SQL version via a counter document.
Exam deadlines are stored as timestamps, so Vercel cold starts do not reset a
student's timer. A sleeping free service may take about a second to wake on the
first request.

Firestore's Spark free quota (at the time of writing) is 1 GiB stored,
50,000 document reads/day and 20,000 writes/day. That is ample for a class quiz
portal. If the project is inactive for 10 days, Firebase may archive the
database; sign in or run the app occasionally to keep it active.

---

## 5. Local development and tests

Install Java 21+ (the Firestore emulator is a Java jar), then:

```bash
npm ci
npm test                 # starts the emulator automatically
npm run emulators        # manual emulator for local app development
```

With the manual emulator running, copy `.env.example` to `.env` and set:

```dotenv
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
FIREBASE_PROJECT_ID=gbat-test
```

Then run `npm start`. This points the app at the emulator instead of real
Firebase data. The `.env` file is git-ignored.

Useful scripts against the **real** Firebase project (set the same `FIREBASE_*`
env vars on your machine):

```bash
npm run setup-db
npm run import-html
npm run seed-portal
npm run create-admin
npm run import-students -- students.csv --out credentials.csv
```

Protect or delete any generated credentials file.

---

## 6. Free-plan notes and limits

- Vercel Hobby is for personal/non-commercial use. It includes HTTPS, custom
  domains and 100 deployments/day.
- The function timeout is set to 60 seconds in `vercel.json`; quiz requests are
  far shorter than that. Vercel Hobby allows up to 300 seconds.
- Firebase Spark requires no credit card. Do not enable Blaze unless you
  explicitly want usage-based billing.
- Keep the service account private. If it leaks, rotate it in Firebase
  **Project settings → Service accounts** and update the Vercel variables.

---

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Set the JWT_SECRET environment variable in production` | Add `JWT_SECRET` in Vercel and redeploy |
| `Firestore connection failed: 7 PERMISSION_DENIED` | Check `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`; regenerate the key if needed |
| Login loop or cookie rejected | Confirm deployment is HTTPS; `COOKIE_SECURE` is automatic in production |
| `The service is starting up. Please retry in a moment.` | First cold boot is seeding; refresh after a few seconds and check the function logs |
| No credentials in the log | They are printed only on the first boot; reset the password from the admin dashboard or run `npm run create-admin` |
| Data disappeared | Confirm you are using the same Firebase project, not the emulator project `gbat-test` |
| Tests fail to start | Install Java 21+ and allow the Firebase CLI to download the Firestore emulator jar once |
| `Failed to fetch` during upload | Hard-refresh to load `app.js?v=24`; uploads now use a signed POST form instead of a CORS-restricted PUT |
| `Storage rejected the file (403/404 …)` | Check `FIREBASE_STORAGE_BUCKET` and that the bucket exists; otherwise the app falls back to chunked Firestore uploads |
| `This project has no Cloud Storage bucket` | Files over 10 MB need a Storage bucket; smaller files are stored in Firestore automatically |
