ROLE
You are a senior full-stack developer. Upgrade the attached single-file HTML app
(Learners Connect) so that teachers can create quizzes for a
specific class and see that class's scores.

CURRENT SITUATION
- The app has Admin, Teacher and Student dashboards in one HTML file.
- All data is kept in a global `state` object saved to localStorage.
- There is only ONE shared question bank (state.questions). Every student takes
  all of it. There are no classes, and no separate quizzes.
- The teacher sees every submission from every student, with no class filter.

GOAL
A teacher can: (1) create a quiz, (2) assign it to one class, (3) see which
students in that class took it and what they scored. Students see and take
only the quizzes assigned to their own class.

REQUIREMENTS

1. Data model (add to getDefaultState and migrate old saved data safely)
   - classes: [{ id, name }]  e.g. "SHS 1A", "SHS 1B"
   - users: add `classId` to every student
   - questions: give every question a stable `id`
   - quizzes: [{ id, title, classId, minutes, open, teacher, created,
                 questions: [...] }]
     The quiz stores a COPY (snapshot) of its questions, so later edits or
     deletions in the question bank do not change existing quizzes.
   - submissions: add `quizId`, `classId`, and store the `questions` snapshot
     so the review screen still works after the bank changes.

2. Admin dashboard
   - New "Classes" section: add, rename and delete classes.
   - Student creation form: add a required Class dropdown.
   - Deleting a class that still has students or quizzes must be blocked
     with a clear message.

3. Teacher dashboard: new "Quizzes" tab
   - Form: quiz title, class dropdown, duration in minutes, and a checklist
     of questions from the bank (with "select all").
   - Create button validates input (title, class, at least one question).
   - Table of existing quizzes: title, class, number of questions,
     open/closed toggle, delete, and a "View Results" button.

4. Teacher results view for one quiz
   - Start from the CLASS ROSTER, not from submissions, so students who have
     NOT taken the quiz appear as "Not attempted".
   - Table: Student name | Index number | Attempts | Best score % | Status
   - KPI cards: class average (best attempts), highest, lowest,
     number completed / total in class.
   - Per-question accuracy table for this quiz only.
   - "Inspect" opens the worked-solution review for a student's submission.
   - "Download CSV" exports this quiz's results for this class.

5. Student dashboard
   - Show only quizzes where quiz.classId equals the student's classId
     and quiz.open is true.
   - Each quiz card shows title, number of questions, duration and the
     student's best score so far.
   - The quiz engine must run on the chosen quiz's questions
     (use activeQuiz.questions instead of state.questions everywhere).
   - Keep the existing behaviour: a wrong answer shows the full
     step-by-step worked solution; timer for exam mode; question navigator.

6. Login rules
   - Remove automatic registration of unknown students. Only students
     created by the admin can log in. Show a friendly error otherwise.

7. Live updates
   - Add a window "storage" event listener that reloads `state` and
     re-renders the current dashboard (but never while a quiz is running),
     so changes made in another tab show up without refreshing.

8. Activity log
   - Log: class created, quiz created, quiz opened/closed, quiz deleted.

TECHNICAL CONSTRAINTS
- Keep it a single self-contained HTML file with plain HTML, CSS and
  vanilla JavaScript. No frameworks, no external libraries.
- Keep the existing design (CSS variables, cards, badges, tables). Code must
  be professional and readable, with clear comments and consistent naming.
- Build DOM with textContent / createElement. Do not inject user-entered
  text with innerHTML.
- Keep the existing sample data working, and put the sample students into
  classes so the demo works immediately.
- The whole app must stay responsive on mobile screens.

DELIVERABLES
1. The complete updated HTML file (not snippets).
2. A short list of what changed and where.
3. A manual test checklist: create class, add student, create quiz,
   take the quiz as the student, view results as the teacher, and confirm a
   student from another class cannot see the quiz.

OPTIONAL SECOND PHASE (only after phase 1 works)
Convert the data layer to Node.js + Express + MySQL with tables: classes,
users (class_id), quizzes, quiz_questions, submissions, submission_answers.
Add JWT login by role, password hashing with bcrypt, and role-protected
API routes. Add Socket.IO so teachers see new submissions instantly.