"use strict";

const appEl = document.getElementById("app");
const modalEl = document.getElementById("modal");
const modalContent = document.getElementById("modal-content");
const toastRegion = document.getElementById("toasts");

const ROLE_LABEL = {
  admin: "Administrator",
  teacher: "Teacher",
  student: "Student"
};

const NAV_ITEMS = {
  admin: [
    ["overview", "Overview"],
    ["subjects", "Subjects"],
    ["classes", "Classes"],
    ["users", "Users"],
    ["quizzes", "Quizzes"],
    ["activity", "Activity"],
    ["settings", "Settings"]
  ],
  teacher: [
    ["overview", "Overview"],
    ["questions", "Question bank"],
    ["quizzes", "Quizzes"],
    ["students", "Students"],
    ["results", "Results"],
    ["submissions", "Submissions"],
    ["announcements", "Announcements"]
  ],
  student: [
    ["dashboard", "Dashboard"],
    ["results", "My results"]
  ]
};

const state = {
  user: null,
  data: null,
  screen: "login",
  view: "overview",
  loginMessage: "",
  passwordForced: false,
  attempt: null,
  currentIndex: 0,
  deadline: null,
  timer: null,
  submitting: false,
  results: null,
  resultsQuizId: null,
  importCredentials: []
};

function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

const SAFE_SVG_TAGS = new Set([
  "svg", "g", "polygon", "polyline", "line", "rect", "circle", "ellipse",
  "path", "text", "tspan", "title", "desc"
]);

const SAFE_SVG_ATTRS = new Set([
  "xmlns", "width", "height", "viewbox", "points", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "d", "fill", "stroke", "stroke-width",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "font-size",
  "font-family", "font-weight", "text-anchor", "transform", "opacity",
  "fill-rule", "clip-rule", "aria-hidden", "role"
]);

function safeSvgMarkup(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const doc = new DOMParser().parseFromString(value, "image/svg+xml");
  if (doc.querySelector("parsererror")) return "";
  const root = doc.documentElement;
  if (!root || String(root.tagName).toLowerCase() !== "svg") return "";

  function scrub(node) {
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE || !SAFE_SVG_TAGS.has(String(node.tagName).toLowerCase())) {
      node.remove();
      return;
    }
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        !SAFE_SVG_ATTRS.has(name) ||
        name.startsWith("on") ||
        /javascript:|data:|url\s*\(/i.test(attribute.value)
      ) {
        node.removeAttribute(attribute.name);
      }
    }
    for (const child of Array.from(node.childNodes)) scrub(child);
  }

  scrub(root);
  return new XMLSerializer().serializeToString(root);
}

function diagramHtml(value) {
  const markup = safeSvgMarkup(value);
  return markup ? `<div class="question-diagram">${markup}</div>` : "";
}

function fmtDate(value) {
  if (!value) return "—";
  return String(value).replace("T", " ").slice(0, 16);
}

function letter(index) {
  return ["A", "B", "C", "D"][index] || "?";
}

function subjectOf(question) {
  return String(question.subject || "General").trim() || "General";
}

function groupQuestionsBySubject(questions) {
  const groups = new Map();
  for (const question of questions) {
    const subject = subjectOf(question);
    const key = subject.toLowerCase();
    if (!groups.has(key)) groups.set(key, { subject, questions: [] });
    groups.get(key).questions.push(question);
  }
  return [...groups.values()].sort((a, b) => a.subject.localeCompare(b.subject));
}

function subjectName(id) {
  const subject = (state.data && state.data.subjects || []).find(item => Number(item.id) === Number(id));
  return subject ? subject.name : "General";
}

function availableSubjects() {
  return (state.data && state.data.subjects) || [];
}

function checkbox(value, checked) {
  return `<input type="checkbox" name="subjectIds" value="${Number(value)}" ${checked ? "checked" : ""}>`;
}

/** Adds data-label attributes so tables can become labelled cards on phones. */
function labelTableCells(root = document) {
  root.querySelectorAll("table").forEach(table => {
    const headers = [...table.querySelectorAll("thead th")].map(th =>
      String(th.textContent || "").replace(/\s+/g, " ").trim()
    );
    table.querySelectorAll("tbody tr").forEach(row => {
      [...row.querySelectorAll("td")].forEach((cell, index) => {
        if (!cell.dataset.label && headers[index]) cell.dataset.label = headers[index];
      });
    });
  });
}

function applyFormVisibility() {
  const quizForm = document.querySelector('form[data-form="create-quiz"]');
  if (quizForm) {
    const select = quizForm.querySelector('select[name="subjectId"]');
    const subjectId = select ? Number(select.value) : 0;
    quizForm.querySelectorAll(".check-group").forEach(group => {
      const match = !subjectId || Number(group.dataset.subjectId) === subjectId;
      group.hidden = !match;
      if (!match) group.querySelectorAll('input[name="questionIds"]').forEach(box => {
        box.checked = false;
      });
    });
  }

  const userForm = document.querySelector('form[data-form="create-user"]');
  if (userForm) {
    const role = userForm.querySelector('select[name="role"]');
    const subjects = userForm.querySelector("[data-teacher-subjects]");
    if (subjects) subjects.hidden = !role || role.value !== "teacher";
  }
}

function defaultView(role) {
  if (role === "student") return "dashboard";
  return "overview";
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  toastRegion.appendChild(node);
  setTimeout(() => node.remove(), 4500);
}

function closeModal() {
  if (modalEl.open) modalEl.close();
}

function openModal(html) {
  modalContent.innerHTML = html;
  labelTableCells(modalContent);
  applyFormVisibility();
  if (!modalEl.open) modalEl.showModal();
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = {};
  const isFormData = options.formData instanceof FormData;

  if (method !== "GET") headers["X-Requested-With"] = "XMLHttpRequest";
  if (options.body !== undefined && !isFormData) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: isFormData
        ? options.formData
        : options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch {
    throw new Error("Cannot reach the server. Check your connection and try again.");
  }

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = new Error(payload && payload.error ? payload.error : `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload ? payload.code : undefined;
    error.payload = payload;

    if (response.status === 401 && !options.ignoreAuth) {
      handleSessionExpired();
    }
    if (response.status === 403 && error.code === "PASSWORD_CHANGE_REQUIRED") {
      state.user.mustChangePassword = true;
      showPassword(true);
    }
    throw error;
  }

  return payload;
}

function handleSessionExpired() {
  if (state.screen === "login") return;
  showLogin("Your session expired. Please sign in again.");
}

function clearTimer() {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function showLogin(message = "") {
  clearTimer();
  state.user = null;
  state.data = null;
  state.screen = "login";
  state.loginMessage = message;
  state.passwordForced = false;
  state.attempt = null;
  state.deadline = null;
  state.results = null;
  state.resultsQuizId = null;
  state.importCredentials = [];
  document.title = "Sign in · GBAT Online Assessment Portal";
  renderLogin();
}

function showPassword(forced) {
  clearTimer();
  state.screen = "password";
  state.passwordForced = Boolean(forced || (state.user && state.user.mustChangePassword));
  document.title = "Password · GBAT Online Assessment Portal";
  renderPassword();
}

function authAsideHtml() {
  return `
    <aside class="auth-aside">
      <div class="auth-brand">
        <span class="brand-mark">GBAT</span>
        <div>
          <strong>GBAT Portal</strong>
          <span>Online assessment</span>
        </div>
      </div>
      <div class="auth-hero">
        <span class="eyebrow">Ghana Basic Achievement Test</span>
        <h1>Assess with clarity and confidence.</h1>
        <p>A focused workspace for practice, timed exams and class-level results.</p>
        <ul class="feature-list">
          <li>Individual accounts with role-based access</li>
          <li>Practice with instant worked feedback</li>
          <li>Timed exams that never reveal answers early</li>
          <li>Class results ready for review and export</li>
        </ul>
      </div>
      <p class="auth-aside-foot">Authorised school users only. Sessions are encrypted and monitored.</p>
    </aside>`;
}

function renderLogin() {
  appEl.innerHTML = `
    <div class="auth-wrap">
      ${authAsideHtml()}
      <main class="auth-main">
        <section class="auth-card">
          <span class="eyebrow">Secure sign in</span>
          <h2>Welcome back</h2>
          <p class="auth-sub">Use the account issued by your school administrator.</p>
          <form class="form" data-form="login" novalidate>
            <p class="form-error" data-form-error role="alert">${esc(state.loginMessage)}</p>
            <div class="field">
              <label for="login-username">Username</label>
              <input id="login-username" name="username" type="text" autocomplete="username" maxlength="80" required autofocus>
            </div>
            <div class="field">
              <label for="login-password">Password</label>
              <div class="password-wrap">
                <input id="login-password" name="password" type="password" autocomplete="current-password" maxlength="72" required>
                <button type="button" class="password-toggle" data-action="toggle-password" data-target="login-password">Show</button>
              </div>
            </div>
            <button class="btn btn-primary btn-block" type="submit">Sign in</button>
          </form>
          <p class="auth-foot">Forgotten your password? Ask your administrator to reset it. Every account has its own private password.</p>
        </section>
      </main>
    </div>`;
}

function renderPassword() {
  const forced = state.passwordForced || (state.user && state.user.mustChangePassword);
  const name = state.user ? state.user.name : "";
  appEl.innerHTML = `
    <div class="auth-wrap">
      ${authAsideHtml()}
      <main class="auth-main">
        <section class="auth-card">
          <span class="eyebrow">${forced ? "Password required" : "Account security"}</span>
          <h2>${forced ? "Set a new password" : "Change your password"}</h2>
          <p class="auth-sub">${forced
            ? `Welcome, ${esc(name)}. Your temporary password must be replaced before you can continue.`
            : `Signed in as ${esc(name)}. Choose a new password you have not used here before.`}</p>
          <form class="form" data-form="change-password" novalidate>
            <p class="form-error" data-form-error role="alert"></p>
            <div class="field">
              <label for="current-password">Current password</label>
              <input id="current-password" name="currentPassword" type="password" autocomplete="current-password" maxlength="72" required>
            </div>
            <div class="field">
              <label for="new-password">New password</label>
              <div class="password-wrap">
                <input id="new-password" name="newPassword" type="password" autocomplete="new-password" maxlength="72" required>
                <button type="button" class="password-toggle" data-action="toggle-password" data-target="new-password">Show</button>
              </div>
            </div>
            <div class="field">
              <label for="confirm-password">Confirm new password</label>
              <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" maxlength="72" required>
            </div>
            <p class="form-note">At least 10 characters, including an uppercase letter, a lowercase letter and a number.</p>
            <button class="btn btn-primary btn-block" type="submit">Update password</button>
          </form>
          <div class="auth-foot">
            ${forced
              ? `<button type="button" class="link-btn" data-action="logout">Sign out instead</button>`
              : `<button type="button" class="link-btn" data-action="cancel-password">Back to the portal</button>`}
          </div>
        </section>
      </main>
    </div>`;
}

async function afterLogin(user) {
  state.user = user;
  if (user.mustChangePassword) {
    showPassword(true);
    return;
  }
  state.screen = "app";
  state.view = defaultView(user.role);
  state.loginMessage = "";
  await loadData();
  render();
}

async function loadData() {
  const path = state.user.role === "admin"
    ? "/admin/bootstrap"
    : state.user.role === "teacher"
      ? "/teacher/bootstrap"
      : "/student/dashboard";
  state.data = await api(path);
}

async function refresh() {
  try {
    await loadData();
    state.results = null;
    state.resultsQuizId = null;
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

function render() {
  if (state.attempt) {
    renderAttempt();
    return;
  }
  if (state.screen === "login") {
    renderLogin();
    return;
  }
  if (state.screen === "password" || (state.user && state.user.mustChangePassword)) {
    renderPassword();
    return;
  }
  renderShell();
}

function navTo(view) {
  state.screen = "app";
  state.view = view;
  if (view === "results") {
    state.results = null;
    state.resultsQuizId = null;
  }
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderShell() {
  const user = state.user;
  if (!state.data) {
    appEl.innerHTML = `<div class="auth-main"><div class="auth-card"><h2>Loading portal…</h2></div></div>`;
    return;
  }

  const nav = (NAV_ITEMS[user.role] || []).map(([view, label]) => `
    <button type="button" class="nav-btn ${state.view === view ? "active" : ""}" data-action="nav" data-view="${view}">${esc(label)}</button>
  `).join("");

  const roleLabel = ROLE_LABEL[user.role] || user.role;
  document.title = `${roleLabel} · GBAT Online Assessment Portal`;

  appEl.innerHTML = `
    <div class="app-frame">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <span class="brand-mark">GBAT</span>
            <div class="brand-text">
              <strong>Assessment Portal</strong>
              <span>Ghana Basic Achievement Test</span>
            </div>
          </div>
          <nav class="main-nav" aria-label="Main navigation">${nav}</nav>
          <div class="topbar-user">
            <div class="user-meta">
              <strong>${esc(user.name)}</strong>
              <span>${esc(roleLabel)}${user.className ? ` · ${esc(user.className)}` : ""}</span>
            </div>
            <button type="button" class="btn btn-sm btn-ghost" data-action="open-password">Password</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="logout">Sign out</button>
          </div>
        </div>
      </header>
      <main class="page">${renderView()}</main>
      <footer class="footer">GBAT Online Assessment Portal · Accounts and data are private to this school.</footer>
    </div>`;
  labelTableCells(appEl);
  applyFormVisibility();
}

function renderView() {
  if (state.user.role === "admin") return renderAdminView();
  if (state.user.role === "teacher") return renderTeacherView();
  return renderStudentView();
}

function statCard(label, value, hint = "") {
  return `
    <article class="stat-card">
      <span class="stat-label">${esc(label)}</span>
      <strong class="stat-value">${esc(value)}</strong>
      ${hint ? `<span class="stat-hint">${esc(hint)}</span>` : ""}
    </article>`;
}

function badge(label, tone = "neutral") {
  return `<span class="badge badge-${tone}">${esc(label)}</span>`;
}

function emptyState(title, text) {
  return `
    <div class="empty">
      <span class="empty-mark">·</span>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
    </div>`;
}

function pageHead(eyebrow, title, subtitle, actions = "") {
  return `
    <div class="page-head">
      <div>
        <span class="eyebrow">${esc(eyebrow)}</span>
        <h1 class="page-title">${esc(title)}</h1>
        <p class="page-sub">${esc(subtitle)}</p>
      </div>
      ${actions ? `<div class="toolbar">${actions}</div>` : ""}
    </div>`;
}

/* Admin */

function renderAdminView() {
  if (state.view === "subjects") return renderAdminSubjects();
  if (state.view === "classes") return renderAdminClasses();
  if (state.view === "users") return renderAdminUsers();
  if (state.view === "quizzes") return renderAdminQuizzes();
  if (state.view === "activity") return renderAdminActivity();
  if (state.view === "settings") return renderAdminSettings();
  return renderAdminOverview();
}

function renderAdminOverview() {
  const d = state.data;
  const recent = d.logs.slice(0, 8);
  return `
    ${pageHead("Administrator", "Overview", "Manage access, classes and the health of the portal.",
      `<button type="button" class="btn btn-primary" data-action="open-create-user">Add account</button>`)}
    <div class="stat-grid">
      ${statCard("Students", d.stats.students)}
      ${statCard("Teachers", d.stats.teachers)}
      ${statCard("Classes", d.stats.classes)}
      ${statCard("Portal average", `${d.stats.average}%`, "Across submitted attempts")}
      ${statCard("Open quizzes", d.stats.openQuizzes)}
      ${statCard("Pending approval", d.stats.pendingApproval, "Teacher quizzes awaiting review")}
    </div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Recent activity</h2>
          <button type="button" class="btn btn-sm btn-ghost" data-action="nav" data-view="activity">View all</button>
        </div>
        ${recent.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Actor</th><th>Action</th><th>When</th></tr></thead>
              <tbody>
                ${recent.map(log => `
                  <tr>
                    <td>${esc(log.actorName)}</td>
                    <td>${esc(log.action)}</td>
                    <td class="nowrap">${esc(fmtDate(log.createdAt))}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>` : emptyState("No activity yet", "Administrative actions will appear here.")}
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Classes</h2>
          <button type="button" class="btn btn-sm btn-ghost" data-action="nav" data-view="classes">Manage</button>
        </div>
        ${d.classes.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Class</th><th>Students</th><th>Quizzes</th></tr></thead>
              <tbody>
                ${d.classes.map(cls => `
                  <tr>
                    <td><strong>${esc(cls.name)}</strong></td>
                    <td>${esc(cls.studentCount)}</td>
                    <td>${esc(cls.quizCount)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>` : emptyState("No classes yet", "Create a class before adding students.")}
      </section>
    </div>`;
}

function renderAdminUsers() {
  const users = state.data.users;
  return `
    ${pageHead("Access control", "Users", "Every account is individual. Temporary passwords must be changed at first sign-in.",
      `<a class="btn" href="/api/admin/students/template.xlsx">Student template</a>
       <button type="button" class="btn btn-primary" data-action="open-create-user">Add account</button>`)}
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">Bulk add students from Excel</h2></div>
      <div class="panel-body">
        <form class="form" data-form="import-students">
          <div class="form-row">
            <div class="field">
              <label for="student-import-file">Excel file (.xlsx)</label>
              <input id="student-import-file" name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required>
            </div>
            <div class="field">
              <span class="field-label">Generated credentials</span>
              <p class="form-note">Username defaults to <strong>firstname.lastname</strong>; temporary password is <strong>FirstnameLastname</strong>. Students must reset it at first sign-in.</p>
            </div>
          </div>
          <p class="form-note">Required columns: First name, Last name, Class. Username is optional. Download the template above to share with students.</p>
          <p class="form-error" data-form-error role="alert"></p>
          <div><button type="submit" class="btn btn-primary">Upload students</button></div>
        </form>
      </div>
    </section>
    <section class="panel mt-1">
      <div class="panel-head">
        <h2 class="panel-title">${esc(users.length)} account${users.length === 1 ? "" : "s"}</h2>
        <span class="pill">Admin accounts are managed from the server</span>
      </div>
      ${users.length ? `
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Role</th><th>Class</th><th>Subjects</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${users.map(user => {
                const status = user.active ? badge("Active", "ok") : badge("Suspended", "danger");
                const temp = user.mustChangePassword ? ` ${badge("Temp password", "warn")}` : "";
                let actions = `<span class="pill">Command line</span>`;
                if (user.role !== "admin") {
                  actions = `
                    <div class="row-actions">
                      <button type="button" class="btn btn-sm btn-ghost" data-action="open-rename-user" data-id="${user.id}">Edit name</button>
                      <button type="button" class="btn btn-sm btn-ghost" data-action="reset-password" data-id="${user.id}">Reset password</button>
                      <button type="button" class="btn btn-sm ${user.active ? "btn-danger" : "btn-success"}" data-action="toggle-user" data-id="${user.id}">${user.active ? "Suspend" : "Activate"}</button>
                      ${user.role === "student" ? `<button type="button" class="btn btn-sm btn-ghost" data-action="open-move-user" data-id="${user.id}">Move class</button>` : ""}
                      ${user.role === "teacher" ? `<button type="button" class="btn btn-sm btn-ghost" data-action="open-assign-subjects" data-id="${user.id}">Assign subjects</button>` : ""}
                      <button type="button" class="btn btn-sm btn-ghost" data-action="delete-user" data-id="${user.id}">Delete</button>
                    </div>`;
                }
                return `
                  <tr>
                    <td>
                      <strong>${esc(user.name)}</strong>
                      <span class="cell-sub">${esc(user.username)}</span>
                    </td>
                    <td>${badge(ROLE_LABEL[user.role] || user.role, user.role === "admin" ? "brand" : "neutral")}</td>
                    <td>${esc(user.className || "—")}</td>
                    <td>${user.subjectNames && user.subjectNames.length
                      ? user.subjectNames.map(name => badge(name, "brand")).join(" ")
                      : esc("—")}</td>
                    <td>${status}${temp}</td>
                    <td class="nowrap">${esc(fmtDate(user.lastLoginAt))}</td>
                    <td>${actions}</td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>` : emptyState("No accounts yet", "Add a teacher or student account to get started.")}
    </section>`;
}

function renderAdminSubjects() {
  const subjects = availableSubjects();
  return `
    ${pageHead("Question bank", "Subjects", "Subjects keep teacher banks and quizzes separate. Renaming a subject never breaks existing questions.",
      `<button type="button" class="btn btn-primary" data-action="open-create-subject">Add subject</button>`)}
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">${esc(subjects.length)} subject${subjects.length === 1 ? "" : "s"}</h2></div>
      ${subjects.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Subject</th><th>Teachers</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              ${subjects.map(subject => {
                const teachers = state.data.users.filter(user =>
                  user.role === "teacher" && (user.subjectIds || []).map(Number).includes(Number(subject.id))
                );
                return `
                  <tr>
                    <td><strong>${esc(subject.name)}</strong></td>
                    <td>${esc(teachers.map(user => user.name).join(", ") || "—")}</td>
                    <td class="nowrap">${esc(fmtDate(subject.createdAt))}</td>
                    <td>
                      <div class="row-actions">
                        <button type="button" class="btn btn-sm btn-ghost" data-action="open-rename-subject" data-id="${subject.id}">Rename</button>
                        <button type="button" class="btn btn-sm btn-danger" data-action="delete-subject" data-id="${subject.id}">Delete</button>
                      </div>
                    </td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>` : emptyState("No subjects yet", "Add a subject before creating questions or assigning teachers.")}
    </section>`;
}

function renderAdminQuizzes() {
  const quizzes = state.data.quizzes || [];
  const s = state.data.settings;
  return `
    ${pageHead("Governance", "Quizzes", "Review teacher-created quizzes, approvals and published availability.",
      `<button type="button" class="btn" data-action="nav" data-view="settings">Quiz rules</button>`)}
    <div class="notice">Teacher quizzes${s.requireApproval ? " require your approval before students can see them" : " open automatically unless you close them"}. Duration and question counts are limited to ${esc(s.minQuizMinutes)}–${esc(s.maxQuizMinutes)} minutes and ${esc(s.minQuestions)}–${esc(s.maxQuestions)} questions.</div>
    <section class="panel mt-1">
      <div class="panel-head"><h2 class="panel-title">${esc(quizzes.length)} quiz${quizzes.length === 1 ? "" : "zes"}</h2></div>
      ${quizzes.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Quiz</th><th>Teacher</th><th>Subject</th><th>Class</th><th>Questions</th><th>Approval</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              ${quizzes.map(quiz => `
                <tr>
                  <td><strong>${esc(quiz.title)}</strong><span class="cell-sub">${esc(fmtDate(quiz.createdAt))}</span></td>
                  <td>${esc(quiz.teacherName)}</td>
                  <td>${esc(quiz.subjectName)}</td>
                  <td>${esc(quiz.className || "—")}</td>
                  <td>${esc(quiz.questionCount)}</td>
                  <td>${quiz.approved ? badge("Approved", "ok") : badge("Pending", "warn")}</td>
                  <td>${quiz.isOpen ? badge("Open", "ok") : badge("Closed", "neutral")}</td>
                  <td>
                    <div class="row-actions">
                      ${quiz.approved
                        ? `<button type="button" class="btn btn-sm btn-ghost" data-action="unapprove-quiz" data-id="${quiz.id}">Return</button>`
                        : `<button type="button" class="btn btn-sm btn-success" data-action="approve-quiz" data-id="${quiz.id}">Approve</button>`}
                      <button type="button" class="btn btn-sm btn-ghost" data-action="admin-toggle-quiz" data-id="${quiz.id}">${quiz.isOpen ? "Close" : "Open"}</button>
                    </div>
                  </td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>` : emptyState("No quizzes yet", "Teacher-created quizzes will appear here for review.")}
    </section>`;
}

function renderAdminClasses() {
  const classes = state.data.classes;
  return `
    ${pageHead("Structure", "Classes", "Students are grouped by class. Class deletion is blocked while students or quizzes remain.")}
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">Add a class</h2></div>
      <div class="panel-body">
        <form class="inline-form" data-form="create-class">
          <div class="field">
            <label for="new-class-name">Class name</label>
            <input id="new-class-name" name="name" type="text" maxlength="80" placeholder="e.g. Basic 8A" required>
          </div>
          <p class="form-error" data-form-error role="alert"></p>
          <button type="submit" class="btn btn-primary">Add class</button>
        </form>
      </div>
    </section>
    <section class="panel mt-1">
      <div class="panel-head"><h2 class="panel-title">${esc(classes.length)} class${classes.length === 1 ? "" : "es"}</h2></div>
      ${classes.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Class</th><th>Students</th><th>Quizzes</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              ${classes.map(cls => `
                <tr>
                  <td><strong>${esc(cls.name)}</strong></td>
                  <td>${esc(cls.studentCount)}</td>
                  <td>${esc(cls.quizCount)}</td>
                  <td class="nowrap">${esc(fmtDate(cls.createdAt))}</td>
                  <td>
                    <div class="row-actions">
                      <button type="button" class="btn btn-sm btn-ghost" data-action="open-rename-class" data-id="${cls.id}">Rename</button>
                      <button type="button" class="btn btn-sm btn-danger" data-action="delete-class" data-id="${cls.id}">Delete</button>
                    </div>
                  </td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>` : emptyState("No classes yet", "Add the first class above.")}
    </section>`;
}

function renderAdminActivity() {
  const logs = state.data.logs;
  return `
    ${pageHead("Audit trail", "Activity", "The most recent actions recorded by the portal.")}
    <section class="panel">
      ${logs.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Actor</th><th>Action</th><th>When</th></tr></thead>
            <tbody>
              ${logs.map(log => `
                <tr>
                  <td>${esc(log.actorName)}</td>
                  <td>${esc(log.action)}</td>
                  <td class="nowrap">${esc(fmtDate(log.createdAt))}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>` : emptyState("No activity yet", "Actions will be recorded here as the portal is used.")}
    </section>`;
}

function renderAdminSettings() {
  const s = state.data.settings;
  const rule = (name, label, checked, description) => `
    <label class="check-item">
      <input type="checkbox" name="${name}" ${checked ? "checked" : ""}>
      <span><strong>${esc(label)}</strong><small>${esc(description)}</small></span>
    </label>`;
  return `
    ${pageHead("Configuration", "Settings", "One place for every quiz limit, approval rule and student-facing policy.")}
    <form class="form" data-form="settings">
      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Duration and questions</h2></div>
          <div class="panel-body form-grid two">
            <div class="field">
              <label for="min-minutes">Minimum duration (minutes)</label>
              <input id="min-minutes" name="minQuizMinutes" type="number" min="1" max="240" value="${esc(s.minQuizMinutes)}" required>
            </div>
            <div class="field">
              <label for="default-minutes">Default duration (minutes)</label>
              <input id="default-minutes" name="defaultQuizMinutes" type="number" min="1" max="240" value="${esc(s.defaultQuizMinutes)}" required>
            </div>
            <div class="field">
              <label for="max-minutes">Maximum duration (minutes)</label>
              <input id="max-minutes" name="maxQuizMinutes" type="number" min="1" max="240" value="${esc(s.maxQuizMinutes)}" required>
            </div>
            <div class="field">
              <label for="min-questions">Minimum questions per quiz</label>
              <input id="min-questions" name="minQuestions" type="number" min="1" max="200" value="${esc(s.minQuestions)}" required>
            </div>
            <div class="field">
              <label for="max-questions">Maximum questions per quiz</label>
              <input id="max-questions" name="maxQuestions" type="number" min="1" max="200" value="${esc(s.maxQuestions)}" required>
            </div>
            <div class="field">
              <label for="pass-mark">Pass mark (%)</label>
              <input id="pass-mark" name="passMark" type="number" min="1" max="100" value="${esc(s.passMark)}" required>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Publishing and students</h2></div>
          <div class="panel-body stack">
            ${rule("requireApproval", "Require approval before students see a quiz", s.requireApproval, "New teacher quizzes stay hidden until you approve them.")}
            ${rule("showSolutions", "Show worked solutions to students", s.showSolutions, "When off, answer keys and solutions are hidden from student result views.")}
            ${rule("allowRetakes", "Allow retakes", s.allowRetakes, "When off, a student can submit each quiz only once.")}
            <div class="field">
              <label for="max-attempts">Maximum attempts per quiz (0 = unlimited)</label>
              <input id="max-attempts" name="maxAttempts" type="number" min="0" max="50" value="${esc(s.maxAttempts)}" required>
            </div>
          </div>
        </section>
      </div>
      <section class="panel mt-1">
        <div class="panel-head"><h2 class="panel-title">Administrator accounts</h2></div>
        <div class="panel-body stack">
          <p class="small">Administrator accounts are created only on the server with <strong>npm run create-admin</strong>. They cannot be created, suspended or password-reset from this screen.</p>
          <div class="notice warn">This protects the highest level of access. Keep administrator credentials offline and share them with as few people as possible.</div>
        </div>
      </section>
      <p class="form-error mt-1" data-form-error role="alert"></p>
      <div class="mt-05"><button type="submit" class="btn btn-primary">Save settings</button></div>
    </form>`;
}

/* Teacher */

function renderTeacherView() {
  if (state.view === "questions") return renderTeacherQuestions();
  if (state.view === "quizzes") return renderTeacherQuizzes();
  if (state.view === "students") return renderTeacherStudents();
  if (state.view === "results") return renderTeacherResults();
  if (state.view === "submissions") return renderTeacherSubmissions();
  if (state.view === "announcements") return renderTeacherAnnouncements();
  return renderTeacherOverview();
}

function renderTeacherOverview() {
  const d = state.data;
  const recent = d.submissions.slice(0, 8);
  const hardest = d.hardestQuestion;
  return `
    ${pageHead("Teacher", "Overview", `Welcome, ${state.user.name}. Your subjects: ${availableSubjects().map(item => item.name).join(", ") || "not assigned"}.`,
      `<a class="btn" href="/api/teacher/students/template.xlsx">Student Excel template</a>
       <button type="button" class="btn" data-action="nav" data-view="questions">Add question</button>
       <button type="button" class="btn btn-primary" data-action="nav" data-view="quizzes">Create quiz</button>`)}
    <div class="stat-grid">
      ${statCard("Submissions", d.stats.submissions)}
      ${statCard("Average score", `${d.stats.average}%`)}
      ${statCard("Highest score", `${d.stats.highest}%`)}
      ${statCard("Question bank", d.questions.length)}
      ${statCard("Quizzes", d.quizzes.length)}
    </div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Recent submissions</h2>
          <button type="button" class="btn btn-sm btn-ghost" data-action="nav" data-view="submissions">View all</button>
        </div>
        ${recent.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Student</th><th>Quiz</th><th>Score</th><th>Submitted</th></tr></thead>
              <tbody>
                ${recent.map(item => `
                  <tr>
                    <td><strong>${esc(item.studentName)}</strong><span class="cell-sub">${esc(item.studentUsername)}</span></td>
                    <td>${esc(item.quizTitle)}</td>
                    <td><strong>${esc(item.pct)}%</strong><span class="cell-sub">${esc(item.score)}/${esc(item.total)}</span></td>
                    <td class="nowrap">${esc(fmtDate(item.submittedAt))}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>` : emptyState("No submissions yet", "Student attempts will appear here after they submit.")}
      </section>
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Hardest question</h2></div>
          <div class="panel-body">
            ${hardest ? `
              <p class="small"><strong>${esc(hardest.quizTitle)}</strong></p>
              <p class="question-text mt-035">${esc(hardest.text)}</p>
              <p class="form-note mt-05">${esc(hardest.accuracy)}% correct across ${esc(hardest.attempts)} answer${hardest.attempts === 1 ? "" : "s"}.</p>` : emptyState("Not enough data yet", "Once students answer questions, the toughest one will appear here.")}
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Your open quizzes</h2></div>
          <div class="panel-body">
            ${d.quizzes.filter(quiz => quiz.isOpen).length ? `
              <div class="stack">
                ${d.quizzes.filter(quiz => quiz.isOpen).slice(0, 4).map(quiz => `
                  <div class="quiz-card">
                    <div class="quiz-card-head">
                      <h3>${esc(quiz.title)}</h3>
                      <span class="row-actions">
                        ${badge("Open", "ok")}
                        ${quiz.shuffleQuestions ? badge("Shuffled", "brand") : ""}
                      </span>
                    </div>
                    <p class="quiz-meta"><span>${esc(quiz.subjectName || subjectName(quiz.subjectId))}</span><span>${esc(quiz.className)}</span><span>${esc(quiz.questionCount)} questions</span><span>${esc(quiz.minutes)} min</span></p>
                    <div class="quiz-actions">
                      <button type="button" class="btn btn-sm" data-action="view-quiz-results" data-id="${quiz.id}">Results</button>
                      <button type="button" class="btn btn-sm btn-ghost" data-action="toggle-quiz" data-id="${quiz.id}">Close quiz</button>
                    </div>
                  </div>`).join("")}
              </div>` : emptyState("No open quizzes", "Open a quiz when you are ready for students to attempt it.")}
          </div>
        </section>
      </div>
    </div>`;
}

function renderTeacherQuestions() {
  const d = state.data;
  const groups = groupQuestionsBySubject(d.questions);
  return `
    ${pageHead("Question bank", "Questions", "Every quiz receives a copy of its questions, so the bank stays stable after publishing.")}
    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Bulk upload questions</h2>
        <span class="pill">CSV · XLSX · JSON · TXT/MD</span>
      </div>
      <div class="panel-body">
        <form class="form" data-form="import-questions">
          <div class="form-row">
            <div class="field">
              <label for="question-import-subject">Default subject</label>
              <select id="question-import-subject" name="subjectId" required>
                ${availableSubjects().map(subject => `<option value="${subject.id}">${esc(subject.name)}</option>`).join("")}
              </select>
              <p class="form-note">Rows with a subject column must use one of your assigned subject names or numeric IDs. Blank subjects use this default.</p>
            </div>
            <div class="field">
              <label for="question-import-file">Question file</label>
              <input id="question-import-file" name="file" type="file" accept=".csv,.tsv,.xlsx,.json,.txt,.md" required>
              <p class="form-note">Up to 500 questions and 5 MB per upload.</p>
            </div>
          </div>
          <details class="notice">
            <summary class="field-label">Format guide</summary>
            <ul class="option-lines mt-06">
              <li class="option-line"><span><strong>CSV/XLSX:</strong> columns are question, optionA, optionB, optionC, optionD, answer, solution, subject (optional), diagram (optional).</span></li>
              <li class="option-line"><span><strong>JSON:</strong> an array of objects, or <code>{ "questions": [...] }</code>, with question, options, answer and solution.</span></li>
              <li class="option-line"><span><strong>TXT/MD:</strong> repeated blocks starting with <code>Question:</code>, followed by A/B/C/D lines, <code>Answer:</code> and <code>Solution:</code>.</span></li>
              <li class="option-line"><span>Answer may be A-D, 1-4, or the exact correct option text.</span></li>
              <li class="option-line"><span>Every question needs four different options and a worked solution of at least 8 words. Missing or weak explanations are rejected.</span></li>
              <li class="option-line"><span>Questions already in the same subject are skipped. Subjects are never created by an upload.</span></li>
            </ul>
          </details>
          <p class="form-note">Templates:
            <a href="/api/teacher/questions/template.csv">CSV</a> ·
            <a href="/api/teacher/questions/template.xlsx">XLSX</a> ·
            <a href="/api/teacher/questions/template.json">JSON</a> ·
            <a href="/api/teacher/questions/template.txt">TXT</a> ·
            <a href="/api/teacher/questions/template.md">MD</a>
          </p>
          <p class="form-error" data-form-error role="alert"></p>
          <div><button type="submit" class="btn btn-primary">Upload questions</button></div>
        </form>
      </div>
    </section>
    <section class="panel mt-1">
      <div class="panel-head"><h2 class="panel-title">Add a question</h2></div>
      <div class="panel-body">
        <form class="form" data-form="add-question">
          <div class="field">
            <label for="question-subject">Subject</label>
            <select id="question-subject" name="subjectId" required>
              ${availableSubjects().map(subject => `<option value="${subject.id}">${esc(subject.name)}</option>`).join("")}
            </select>
            <p class="form-note">You can only add questions to subjects assigned to you by the administrator.</p>
          </div>
          <div class="field">
            <label for="question-text">Question</label>
            <textarea id="question-text" name="questionText" maxlength="4000" required placeholder="Write the question clearly."></textarea>
          </div>
          <div class="form-grid two">
            ${[0, 1, 2, 3].map(index => `
              <div class="field">
                <label for="option-${index}">Option ${letter(index)}</label>
                <input id="option-${index}" name="option${index}" type="text" maxlength="500" required>
              </div>`).join("")}
          </div>
          <div class="form-row">
            <div class="field">
              <label for="correct-index">Correct option</label>
              <select id="correct-index" name="correctIndex" required>
                ${[0, 1, 2, 3].map(index => `<option value="${index}">Option ${letter(index)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <span class="field-label">Note</span>
              <p class="form-note">Correct answers are never sent to students before an exam is submitted.</p>
            </div>
          </div>
          <div class="field">
            <label for="solution-text">Worked solution</label>
            <textarea id="solution-text" name="solution" maxlength="8000" required placeholder="Explain how to arrive at the correct answer."></textarea>
          </div>
          <p class="form-error" data-form-error role="alert"></p>
          <div><button type="submit" class="btn btn-primary">Add question</button></div>
        </form>
      </div>
    </section>
    <section class="panel mt-1">
      <div class="panel-head">
        <h2 class="panel-title">${esc(d.questions.length)} question${d.questions.length === 1 ? "" : "s"} in ${esc(groups.length)} group${groups.length === 1 ? "" : "s"}</h2>
      </div>
      ${d.questions.length ? groups.map(group => `
        <section class="question-group">
          <div class="question-group-head">
            <h3>${esc(group.subject)}</h3>
            ${badge(`${group.questions.length} question${group.questions.length === 1 ? "" : "s"}`)}
          </div>
          ${group.questions.map(question => `
            <article class="question-preview">
              <div class="question-preview-head">
                <div>
                  <h3>${esc(question.text)}</h3>
                  <span class="cell-sub">Added ${esc(fmtDate(question.createdAt))}</span>
                </div>
                <button type="button" class="btn btn-sm btn-danger" data-action="delete-question" data-id="${question.id}">Delete</button>
              </div>
              ${diagramHtml(question.diagramSvg)}
              <ul class="option-lines">
                ${question.options.map((option, index) => `
                  <li class="option-line ${index === question.correctIndex ? "correct" : ""}">
                    <strong>${letter(index)}</strong><span>${esc(option)}</span>
                  </li>`).join("")}
              </ul>
              <div class="solution-box"><strong>Worked solution</strong>${esc(question.solution)}</div>
            </article>`).join("")}
        </section>`).join("") : emptyState("No questions yet", "Add a question above to start building your bank.")}
    </section>`;
}

function renderTeacherQuizzes() {
  const d = state.data;
  const defaultMinutes = d.settings.defaultQuizMinutes;
  const groups = groupQuestionsBySubject(d.questions);
  return `
    ${pageHead("Assessments", "Quizzes", "Publishing copies the selected questions into the quiz and opens it to the class.")}
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">Create a quiz</h2></div>
      <div class="panel-body">
        ${d.questions.length ? `
          <form class="form" data-form="create-quiz">
            <div class="form-row">
              <div class="field">
                <label for="quiz-title">Quiz title</label>
                <input id="quiz-title" name="title" type="text" maxlength="160" required>
              </div>
              <div class="field">
                <label for="quiz-class">Class</label>
                <select id="quiz-class" name="classId" required>
                  ${d.classes.map(cls => `<option value="${cls.id}">${esc(cls.name)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label for="quiz-subject">Subject</label>
                <select id="quiz-subject" name="subjectId" required>
                  ${availableSubjects().map(subject => `<option value="${subject.id}">${esc(subject.name)}</option>`).join("")}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="field">
                <label for="quiz-minutes">Duration (minutes)</label>
                <input id="quiz-minutes" name="minutes" type="number" min="${esc(d.settings.minQuizMinutes)}" max="${esc(d.settings.maxQuizMinutes)}" value="${esc(defaultMinutes)}" required>
              </div>
              <div class="field">
                <span class="field-label">Availability</span>
                <p class="form-note">Allowed: ${esc(d.settings.minQuizMinutes)}–${esc(d.settings.maxQuizMinutes)} minutes and ${esc(d.settings.minQuestions)}–${esc(d.settings.maxQuestions)} questions.${d.settings.requireApproval ? " An administrator must approve this quiz before students see it." : " The quiz opens immediately."}</p>
              </div>
            </div>
            <div class="field">
              <label class="check-item">
                <input type="checkbox" name="shuffleQuestions">
                <span>
                  <strong>Shuffle question order for each student</strong>
                  <small>Students see the same questions in a different order, making copying harder.</small>
                </span>
              </label>
            </div>
            <div class="field">
              <div class="field-label-row">
                <span class="field-label">Questions</span>
                <button type="button" class="link-btn" data-action="toggle-all-questions">Select all</button>
              </div>
              <div class="checkbox-groups">
                ${groups.map(group => `
                  <section class="check-group" data-subject-id="${group.questions[0] && group.questions[0].subjectId || ""}">
                    <div class="check-group-head">
                      <strong>${esc(group.subject)}</strong>
                      <span class="cell-sub">${esc(group.questions.length)} question${group.questions.length === 1 ? "" : "s"}</span>
                    </div>
                    <div class="checkbox-grid">
                      ${group.questions.map(question => `
                        <label class="check-item">
                          <input type="checkbox" name="questionIds" value="${question.id}">
                          <span>
                            <strong>${esc(question.text)}</strong>
                            <small>${esc(question.options.length)} options</small>
                          </span>
                        </label>`).join("")}
                    </div>
                  </section>`).join("")}
              </div>
            </div>
            <p class="form-error" data-form-error role="alert"></p>
            <div><button type="submit" class="btn btn-primary">Create quiz</button></div>
          </form>` : `
          <div class="empty">
            <span class="empty-mark">?</span>
            <h3>Add questions first</h3>
            <p>A quiz needs at least one question from your bank.</p>
            <button type="button" class="btn btn-primary" data-action="nav" data-view="questions">Go to question bank</button>
          </div>`}
      </div>
    </section>
    <section class="panel mt-1">
      <div class="panel-head"><h2 class="panel-title">${esc(d.quizzes.length)} quiz${d.quizzes.length === 1 ? "" : "zes"}</h2></div>
      ${d.quizzes.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Quiz</th><th>Subject</th><th>Class</th><th>Questions</th><th>Duration</th><th>Order</th><th>Approval</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              ${d.quizzes.map(quiz => `
                <tr>
                  <td><strong>${esc(quiz.title)}</strong></td>
                  <td>${esc(quiz.subjectName || subjectName(quiz.subjectId))}</td>
                  <td>${esc(quiz.className)}</td>
                  <td>${esc(quiz.questionCount)}</td>
                  <td>${esc(quiz.minutes)} min</td>
                  <td>${quiz.shuffleQuestions ? badge("Shuffled", "brand") : badge("Fixed", "neutral")}</td>
                  <td>${quiz.approved ? badge("Approved", "ok") : badge("Pending", "warn")}</td>
                  <td>${quiz.isOpen ? badge("Open", "ok") : badge("Closed", "neutral")}</td>
                  <td class="nowrap">${esc(fmtDate(quiz.createdAt))}</td>
                  <td>
                    <div class="row-actions">
                      <button type="button" class="btn btn-sm" data-action="view-quiz-results" data-id="${quiz.id}">Results</button>
                      <button type="button" class="btn btn-sm btn-ghost" data-action="toggle-quiz" data-id="${quiz.id}">${quiz.isOpen ? "Close" : "Open"}</button>
                      <button type="button" class="btn btn-sm btn-ghost" data-action="toggle-shuffle" data-id="${quiz.id}">${quiz.shuffleQuestions ? "Fixed order" : "Shuffle"}</button>
                      <button type="button" class="btn btn-sm btn-danger" data-action="archive-quiz" data-id="${quiz.id}">Archive</button>
                    </div>
                  </td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>` : emptyState("No quizzes yet", "Create a quiz from the form above.")}
    </section>`;
}

function renderTeacherStudents() {
  const students = state.data.students || [];
  const classes = state.data.classes || [];
  const grouped = classes.map(cls => ({
    cls,
    students: students.filter(student => Number(student.classId) === Number(cls.id))
  }));
  const unassigned = students.filter(student => !student.classId);
  return `
    ${pageHead("Roster", "Students", "Move a student between classes. Results stay attached to their attempts.",
      `<a class="btn" href="/api/teacher/students/template.xlsx">Student Excel template</a>`)}
    <div class="grid-2">
      ${grouped.map(group => `
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">${esc(group.cls.name)}</h2>
            ${badge(`${group.students.length} student${group.students.length === 1 ? "" : "s"}`)}
          </div>
          ${group.students.length ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>Student</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  ${group.students.map(student => `
                    <tr>
                      <td><strong>${esc(student.name)}</strong><span class="cell-sub">${esc(student.username)}</span></td>
                      <td>${student.active ? badge("Active", "ok") : badge("Suspended", "danger")}</td>
                      <td><button type="button" class="btn btn-sm btn-ghost" data-action="open-move-student" data-id="${student.id}">Move class</button></td>
                    </tr>`).join("")}
                </tbody>
              </table>
            </div>` : emptyState("No students", "Students assigned to this class will appear here.")}
        </section>`).join("")}
      ${unassigned.length ? `
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Unassigned</h2></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Student</th><th>Actions</th></tr></thead>
              <tbody>
                ${unassigned.map(student => `
                  <tr>
                    <td><strong>${esc(student.name)}</strong></td>
                    <td><button type="button" class="btn btn-sm btn-ghost" data-action="open-move-student" data-id="${student.id}">Assign class</button></td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </section>` : ""}
    </div>`;
}

function renderTeacherResults() {
  const d = state.data;
  if (!state.results || !state.resultsQuizId) {
    return `
      ${pageHead("Performance", "Results", "Choose a quiz to inspect class performance.")}
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Your quizzes</h2></div>
        <div class="panel-body">
          ${d.quizzes.length ? `
            <div class="quiz-grid">
              ${d.quizzes.map(quiz => `
                <article class="quiz-card">
                  <div class="quiz-card-head">
                    <h3>${esc(quiz.title)}</h3>
                    ${quiz.isOpen ? badge("Open", "ok") : badge("Closed", "neutral")}
                  </div>
                  <p class="quiz-meta"><span>${esc(quiz.className)}</span><span>${esc(quiz.questionCount)} questions</span><span>${esc(quiz.minutes)} min</span></p>
                  <div class="quiz-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-action="view-quiz-results" data-id="${quiz.id}">View results</button>
                  </div>
                </article>`).join("")}
            </div>` : emptyState("No quizzes yet", "Create a quiz before reviewing results.")}
          <p class="form-note mt-1">Archived quizzes are hidden from this list. Their submissions remain available under Submissions.</p>
        </div>
      </section>`;
  }

  const result = state.results;
  const quiz = result.quiz;
  const attempted = result.students.filter(student => student.bestPct !== null);
  return `
    ${pageHead("Performance", quiz.title, `${quiz.className} · ${quiz.minutes} minute quiz · ${quiz.isOpen ? "Open" : "Closed"}`,
      `<button type="button" class="btn" data-action="nav" data-view="quizzes">Back to quizzes</button>
       <a class="btn btn-primary" href="/api/teacher/quizzes/${Number(quiz.id)}/results.csv">Download CSV</a>`)}
    <div class="stat-grid">
      ${statCard("Assigned", result.kpis.assigned)}
      ${statCard("Completed", result.kpis.completed)}
      ${statCard("Average", `${result.kpis.average}%`, "Best attempt per student")}
      ${statCard("Highest", `${result.kpis.highest}%`)}
      ${statCard("Lowest", `${result.kpis.lowest}%`)}
    </div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Students</h2></div>
        ${result.students.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Student</th><th>Index number</th><th>Attempts</th><th>Best</th><th>Last attempt</th><th></th></tr></thead>
              <tbody>
                ${result.students.map(student => `
                  <tr>
                    <td><strong>${esc(student.name)}</strong></td>
                    <td>${esc(student.username)}</td>
                    <td>${esc(student.attempts)}</td>
                    <td>${student.bestPct === null
                      ? `<span class="muted">—</span>`
                      : `<strong>${esc(student.bestPct)}%</strong><span class="cell-sub">${esc(student.bestScore)}/${esc(student.bestTotal)} · ${esc(student.bestMode)}</span>`}</td>
                    <td class="nowrap">${esc(fmtDate(student.lastAttemptAt))}</td>
                    <td>${student.bestSubmissionId
                      ? `<button type="button" class="btn btn-sm btn-ghost" data-action="inspect-submission" data-id="${student.bestSubmissionId}">Inspect</button>`
                      : `<span class="muted small">${esc(student.status)}</span>`}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>` : emptyState("No students in this class", "Assign students to the class before reviewing results.")}
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Question accuracy</h2></div>
        <div class="panel-body">
          ${result.accuracy.length ? `
            <div class="accuracy-list">
              ${result.accuracy.map(item => `
                <div class="accuracy-item">
                  <div class="accuracy-head">
                    <span><strong>Q${esc(item.position + 1)}.</strong> ${esc(item.text)}</span>
                    <span>${esc(item.accuracy)}%</span>
                  </div>
                  <progress max="100" value="${Number(item.accuracy)}"></progress>
                  <span class="form-note">${esc(subjectOf(item))} &middot; ${esc(item.correct)} correct of ${esc(item.attempts)} answer${item.attempts === 1 ? "" : "s"}</span>
                </div>`).join("")}
            </div>` : emptyState("No answers yet", "Accuracy appears after students submit attempts.")}
          ${attempted.length ? "" : `<p class="form-note mt-08">No student has submitted this quiz yet.</p>`}
        </div>
      </section>
    </div>`;
}

function renderTeacherSubmissions() {
  const submissions = state.data.submissions;
  return `
    ${pageHead("Evidence", "Submissions", "Every submission is stored separately and can be inspected in detail.")}
    <section class="panel">
      ${submissions.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Student</th><th>Quiz</th><th>Mode</th><th>Score</th><th>Submitted</th><th></th></tr></thead>
            <tbody>
              ${submissions.map(item => `
                <tr>
                  <td>
                    <strong>${esc(item.studentName)}</strong>
                    <span class="cell-sub">${esc(item.studentUsername)} · ${esc(item.className)}</span>
                  </td>
                  <td>${esc(item.quizTitle)}</td>
                  <td>${badge(item.mode, item.mode === "Exam" ? "warn" : "brand")}</td>
                  <td><strong>${esc(item.pct)}%</strong><span class="cell-sub">${esc(item.score)}/${esc(item.total)}</span></td>
                  <td class="nowrap">${esc(fmtDate(item.submittedAt))}</td>
                  <td><button type="button" class="btn btn-sm btn-ghost" data-action="inspect-submission" data-id="${item.id}">Inspect</button></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>` : emptyState("No submissions yet", "Student results will appear here after they submit.")}
    </section>`;
}

function renderTeacherAnnouncements() {
  const announcements = state.data.announcements;
  return `
    ${pageHead("Communication", "Announcements", "Short notices appear on every student dashboard.")}
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">Post an announcement</h2></div>
      <div class="panel-body">
        <form class="form" data-form="post-announcement">
          <div class="field">
            <label for="announcement-text">Message</label>
            <textarea id="announcement-text" name="text" maxlength="2000" required placeholder="e.g. Bring a calculator to tomorrow's lesson."></textarea>
          </div>
          <p class="form-error" data-form-error role="alert"></p>
          <div><button type="submit" class="btn btn-primary">Post announcement</button></div>
        </form>
      </div>
    </section>
    <section class="panel mt-1">
      <div class="panel-head"><h2 class="panel-title">${esc(announcements.length)} announcement${announcements.length === 1 ? "" : "s"}</h2></div>
      ${announcements.length ? announcements.map(item => `
        <article class="question-preview">
          <div class="question-preview-head">
            <div>
              <h3>${esc(item.authorName)}</h3>
              <span class="cell-sub">${esc(fmtDate(item.createdAt))}</span>
            </div>
            ${item.authorId === state.user.id
              ? `<button type="button" class="btn btn-sm btn-danger" data-action="delete-announcement" data-id="${item.id}">Delete</button>`
              : ""}
          </div>
          <p class="small pre-line">${esc(item.text)}</p>
        </article>`).join("") : emptyState("No announcements yet", "Post a message for students using the form above.")}
    </section>`;
}

/* Student */

function renderStudentView() {
  if (state.view === "results") return renderStudentResults();
  return renderStudentDashboard();
}

function renderStudentDashboard() {
  const d = state.data;
  return `
    ${pageHead("Student", `Hello, ${state.user.name}`, d.class ? `${d.class.name} · Your private assessment dashboard.` : "Your private assessment dashboard.",
      `<button type="button" class="btn" data-action="nav" data-view="results">My results</button>`)}
    <div class="stat-grid">
      ${statCard("Class", d.class ? d.class.name : "Unassigned")}
      ${statCard("Open quizzes", d.stats.available)}
      ${statCard("Quizzes taken", d.stats.quizzesTaken)}
      ${statCard("Average", `${d.stats.average}%`, "Best attempt per quiz")}
      ${statCard("Passed", d.stats.passed, `Best score of ${esc(d.settings.passMark)}% or more`)}
    </div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">How attempts work</h2></div>
        <div class="panel-body stack">
          <div class="notice"><strong>Practice</strong> is untimed and${d.settings.showSolutions ? " shows the correct answer and worked solution immediately after each question" : " does not reveal answers until your administrator enables worked solutions"}.</div>
          <div class="notice warn"><strong>Exam</strong> is timed and never reveals correctness until you submit. Once you choose an answer, it cannot be changed.</div>
          <p class="form-note">Starting the same mode again resumes an unfinished attempt. ${!d.settings.allowRetakes
            ? "Retakes are disabled; each quiz can be submitted once."
            : d.settings.maxAttempts > 0
              ? `You may submit up to ${esc(d.settings.maxAttempts)} attempt${d.settings.maxAttempts === 1 ? "" : "s"} per quiz.`
              : "You may submit multiple practice or exam attempts."}</p>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Announcements</h2></div>
        <div class="panel-body">
          ${d.announcements.length ? `
            <div class="stack">
              ${d.announcements.map(item => `
                <article>
                  <p class="small pre-line"><strong>${esc(item.authorName)}</strong> · ${esc(fmtDate(item.createdAt))}</p>
                  <p class="small mt-025 pre-line">${esc(item.text)}</p>
                </article>`).join("")}
            </div>` : emptyState("No announcements", "Your teachers have not posted any notices yet.")}
        </div>
      </section>
    </div>
    <div class="page-head mt-16">
      <div>
        <span class="eyebrow">Your class</span>
        <h2 class="page-title page-title-sm">Quizzes</h2>
      </div>
    </div>
    ${d.quizzes.length ? `
      <div class="quiz-grid">
        ${d.quizzes.map(quiz => `
          <article class="quiz-card">
            <div class="quiz-card-head">
              <h3>${esc(quiz.title)}</h3>
              ${quiz.isOpen ? badge("Open", "ok") : badge("Closed", "neutral")}
            </div>
            <div class="quiz-meta">
              <span>${esc(quiz.questionCount)} question${quiz.questionCount === 1 ? "" : "s"}</span>
              <span>${esc(quiz.minutes)} min</span>
              <span>${esc(quiz.attempts)} submitted attempt${quiz.attempts === 1 ? "" : "s"}</span>
            </div>
            ${quiz.bestPct === null
              ? `<p class="muted small">No submitted attempt yet.</p>`
              : `<p class="quiz-score"><span>Best score</span><strong>${esc(quiz.bestPct)}%</strong><span class="muted">last ${esc(fmtDate(quiz.lastSubmittedAt))}</span></p>`}
            <div class="quiz-actions">
              ${quiz.isOpen ? `
                <button type="button" class="btn btn-primary btn-sm" data-action="start-quiz" data-id="${quiz.id}" data-mode="Practice">Practice</button>
                <button type="button" class="btn btn-sm" data-action="start-quiz" data-id="${quiz.id}" data-mode="Exam">Start exam</button>` : `<span class="muted small">This quiz is closed.</span>`}
            </div>
          </article>`).join("")}
      </div>` : emptyState("No quizzes yet", "When your teacher publishes a quiz for your class, it will appear here.")}`;
}

function renderStudentResults() {
  const d = state.data;
  return `
    ${pageHead("Progress", "My results", d.settings.showSolutions
      ? "Scores are stored per submission. Open any result to review the worked solutions."
      : "Scores are stored per submission. Worked solutions are hidden by your administrator.")}
    <div class="stat-grid">
      ${statCard("Quizzes taken", d.stats.quizzesTaken)}
      ${statCard("Average", `${d.stats.average}%`)}
      ${statCard("Passed", d.stats.passed, `Best score of ${esc(d.settings.passMark)}% or more`)}
    </div>
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">Submission history</h2></div>
      ${d.submissions.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Quiz</th><th>Mode</th><th>Score</th><th>Submitted</th><th></th></tr></thead>
            <tbody>
              ${d.submissions.map(item => `
                <tr>
                  <td><strong>${esc(item.quizTitle)}</strong></td>
                  <td>${badge(item.mode, item.mode === "Exam" ? "warn" : "brand")}</td>
                  <td><strong>${esc(item.pct)}%</strong><span class="cell-sub">${esc(item.score)}/${esc(item.total)}</span></td>
                  <td class="nowrap">${esc(fmtDate(item.submittedAt))}</td>
                  <td><button type="button" class="btn btn-sm btn-ghost" data-action="inspect-submission" data-id="${item.id}">Review</button></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>` : emptyState("No results yet", "Complete a practice or exam attempt to see your results here.")}
    </section>`;
}

/* Quiz attempt */

function beginAttempt(attempt) {
  clearTimer();
  state.attempt = attempt;
  state.currentIndex = 0;
  state.submitting = false;
  state.deadline = attempt.secondsRemaining === null || attempt.secondsRemaining === undefined
    ? null
    : Date.now() + Number(attempt.secondsRemaining) * 1000;
  startTimer();
  renderAttempt();
  window.scrollTo({ top: 0 });
}

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function startTimer() {
  clearTimer();
  if (!state.attempt || state.deadline === null) {
    updateTimerDisplay();
    return;
  }

  state.timer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    updateTimerDisplay(remaining);
    if (remaining <= 0) {
      clearTimer();
      toast("Time is up. Submitting your attempt.", "warn");
      submitAttempt(true).catch(error => toast(error.message, "error"));
    }
  }, 1000);

  updateTimerDisplay();
}

function updateTimerDisplay(remaining) {
  const timerEl = document.getElementById("attempt-timer");
  const progressEl = document.getElementById("attempt-progress");
  if (!timerEl || !state.attempt) return;

  let seconds = remaining;
  if (seconds === undefined) {
    seconds = state.deadline === null ? null : Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
  }
  if (seconds === null) {
    timerEl.textContent = "Untimed";
    timerEl.classList.remove("urgent");
    return;
  }

  timerEl.textContent = formatClock(seconds);
  timerEl.classList.toggle("urgent", seconds <= 60);

  if (progressEl) {
    const max = Number(state.attempt.secondsRemaining) || 1;
    progressEl.max = max;
    progressEl.value = Math.min(max, seconds);
  }
}

function renderAttempt() {
  const attempt = state.attempt;
  if (!attempt) return;

  if (state.currentIndex < 0) state.currentIndex = 0;
  if (state.currentIndex >= attempt.questions.length) state.currentIndex = attempt.questions.length - 1;

  const question = attempt.questions[state.currentIndex];
  const answer = attempt.answers.find(item => item.position === question.position);
  const practice = attempt.mode === "Practice";
  const total = attempt.questions.length;
  const last = state.currentIndex === total - 1;

  const options = question.options.map((option, index) => {
    let classes = "option-btn";
    if (answer && answer.chosenIndex === index) classes += " chosen";
    if (practice && answer) {
      if (index === answer.correctIndex) classes += " correct";
      else if (answer.chosenIndex === index) classes += " wrong";
    }
    if (answer) classes += " locked";

    return `
      <button type="button" class="${classes}" data-action="answer" data-position="${question.position}" data-index="${index}" ${answer ? "disabled" : ""}>
        <span class="option-letter">${letter(index)}</span>
        <span>${esc(option)}</span>
      </button>`;
  }).join("");

  let feedback = "";
  if (practice && answer) {
    feedback = `
      <div class="feedback ${answer.isCorrect ? "ok" : "bad"}">
        <strong>${answer.isCorrect ? "Correct" : "Not quite"}</strong>
        <div>Correct answer: ${letter(answer.correctIndex)}. ${esc(question.options[answer.correctIndex] || "")}</div>
        <div class="solution"><strong>Worked solution</strong><br>${esc(answer.solution || "")}</div>
      </div>`;
  } else if (practice) {
    feedback = `<div class="notice">Practice mode gives instant feedback after you answer.</div>`;
  } else if (answer) {
    feedback = `<div class="notice">Answer locked. Exam answers cannot be changed.</div>`;
  } else {
    feedback = `<div class="notice warn">Choose one option. Exam correctness stays hidden until you submit.</div>`;
  }

  const palette = attempt.questions.map((item, index) => {
    const isAnswered = attempt.answers.some(entry => entry.position === item.position);
    const classes = ["palette-btn", isAnswered ? "answered" : "", index === state.currentIndex ? "current" : ""].filter(Boolean).join(" ");
    return `<button type="button" class="${classes}" data-action="goto-question" data-index="${index}">${index + 1}</button>`;
  }).join("");

  const timer = practice
    ? `<div class="runner-timer"><span>Mode</span><div class="timer-value">Practice</div></div>`
    : `<div class="runner-timer"><span>Time remaining</span><div class="timer-value" id="attempt-timer">--:--</div><progress id="attempt-progress" max="${Number(attempt.secondsRemaining) || 1}" value="${Number(attempt.secondsRemaining) || 0}"></progress></div>`;

  appEl.innerHTML = `
    <div class="runner-shell">
      <header class="runner-head">
        <div class="runner-head-inner">
          <div class="runner-brand">
            <span class="brand-mark">GBAT</span>
            <div>
              <strong>${esc(attempt.quiz.title)}</strong>
              <span>${esc(attempt.quiz.className)} · ${esc(attempt.mode)} mode</span>
            </div>
          </div>
          <div class="runner-tools">
            ${timer}
            <button type="button" class="btn btn-ghost" data-action="exit-attempt">Exit</button>
            <button type="button" class="btn btn-primary" data-action="submit-attempt" ${state.submitting ? "disabled" : ""}>${state.submitting ? "Submitting…" : "Submit"}</button>
          </div>
        </div>
      </header>
      <div class="runner-layout">
        <aside class="palette">
          <div class="palette-head">
            <strong>Questions</strong>
            <span>${esc(attempt.answers.length)} of ${esc(total)} answered</span>
          </div>
          <div class="palette-grid">${palette}</div>
        </aside>
        <main class="runner-main">
          <section class="question-card">
            <div class="question-top">
              <div class="meta">
                <span class="pill">Question ${esc(state.currentIndex + 1)} of ${esc(total)}</span>
                <span class="pill">${esc(subjectOf(question))}</span>
                <span>${esc(question.options.length)} options</span>
              </div>
              ${badge(attempt.mode, practice ? "brand" : "warn")}
            </div>
            <p class="question-text">${esc(question.text)}</p>
            ${diagramHtml(question.diagramSvg)}
            <div class="option-grid">${options}</div>
            <div class="feedback-wrap">${feedback}</div>
            <div class="runner-actions">
              <div class="runner-actions-group">
                <button type="button" class="btn" data-action="prev-question" ${state.currentIndex === 0 ? "disabled" : ""}>Previous</button>
                <button type="button" class="btn" data-action="next-question" ${last ? "disabled" : ""}>Next</button>
              </div>
              <div class="runner-actions-group">
                <button type="button" class="btn btn-ghost" data-action="exit-attempt">Save &amp; exit</button>
                <button type="button" class="btn btn-primary" data-action="submit-attempt" ${state.submitting ? "disabled" : ""}>${state.submitting ? "Submitting…" : "Submit attempt"}</button>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>`;

  updateTimerDisplay();
}

async function startQuiz(quizId, mode) {
  const attempt = await api(`/student/quizzes/${quizId}/start`, {
    method: "POST",
    body: { mode }
  });
  beginAttempt(attempt);
}

async function answerQuestion(position, chosenIndex) {
  const attempt = state.attempt;
  if (!attempt) return;
  if (attempt.answers.some(item => item.position === position)) return;

  try {
    const result = await api(`/student/attempts/${attempt.attemptId}/answer`, {
      method: "POST",
      body: { position, chosenIndex }
    });
    const entry = { position, chosenIndex, ...(result.feedback || {}) };
    attempt.answers.push(entry);
    renderAttempt();
  } catch (error) {
    if (error.status === 410) {
      toast(error.message, "warn");
      clearTimer();
      state.attempt = null;
      state.view = "dashboard";
      await refresh();
      return;
    }
    if (error.status === 409) {
      toast(error.message, "warn");
      return;
    }
    throw error;
  }
}

async function submitAttempt(auto) {
  const attempt = state.attempt;
  if (!attempt || state.submitting) return;

  const unanswered = attempt.questions.length - attempt.answers.length;
  if (!auto && unanswered > 0) {
    const confirmed = window.confirm(`${unanswered} question${unanswered === 1 ? "" : "s"} still unanswered. Submit anyway?`);
    if (!confirmed) return;
  }

  state.submitting = true;
  renderAttempt();

  try {
    const result = await api(`/student/attempts/${attempt.attemptId}/submit`, {
      method: "POST",
      body: {}
    });
    clearTimer();
    state.attempt = null;
    state.submitting = false;
    state.view = "dashboard";
    toast(`Attempt submitted: ${result.score}/${result.total} (${result.pct}%).`, "success");
    await loadData();
    render();
    await openSubmission(result.submissionId);
  } catch (error) {
    state.submitting = false;
    if (error.status === 410) {
      toast(error.message, "warn");
      clearTimer();
      state.attempt = null;
      state.view = "dashboard";
      await refresh();
      return;
    }
    renderAttempt();
    throw error;
  }
}

async function exitAttempt() {
  if (!state.attempt) return;
  const confirmed = window.confirm("Leave this attempt? Saved answers stay on the server, and an exam timer keeps running.");
  if (!confirmed) return;
  clearTimer();
  state.attempt = null;
  state.view = "dashboard";
  await refresh();
}

/* Modal content */

async function openSubmission(submissionId) {
  try {
    const data = await api(`/submissions/${Number(submissionId)}`);
    openModal(submissionHtml(data.submission));
  } catch (error) {
    toast(error.message, "error");
  }
}

function submissionHtml(submission) {
  const questions = submission.questions.map(question => {
    const answersVisible = question.correctIndex !== undefined;
    const options = question.options.map((option, index) => {
      let classes = "option-line";
      if (answersVisible && index === question.correctIndex) classes += " correct";
      else if (question.chosenIndex === index) classes += answersVisible ? " wrong" : " selected";
      return `<li class="${classes}"><strong>${letter(index)}</strong><span>${esc(option)}</span></li>`;
    }).join("");
    const answerLine = answersVisible
      ? `Your answer: ${question.chosenIndex === null ? "Not answered" : `${letter(question.chosenIndex)}. ${esc(question.options[question.chosenIndex])}`} · Correct answer: ${letter(question.correctIndex)}. ${esc(question.options[question.correctIndex])}`
      : `Your answer: ${question.chosenIndex === null ? "Not answered" : `${letter(question.chosenIndex)}. ${esc(question.options[question.chosenIndex])}`}`;

    return `
      <article class="review-card">
        <div class="review-head">
          <span class="pill">Question ${esc(question.position + 1)}</span>
          <span class="pill">${esc(subjectOf(question))}</span>
          ${answersVisible ? (question.isCorrect ? badge("Correct", "ok") : badge("Incorrect", "danger")) : ""}
        </div>
        <p class="question-text">${esc(question.text)}</p>
        ${diagramHtml(question.diagramSvg)}
        <ul class="option-list">${options}</ul>
        <p class="cell-sub">${esc(answerLine)}</p>
        ${answersVisible && question.solution ? `<div class="solution-box mt-055"><strong>Worked solution</strong>${esc(question.solution)}</div>` : ""}
      </article>`;
  }).join("");

  return `
    <div class="modal-head">
      <div>
        <h2 id="modal-title">${esc(submission.quizTitle)}</h2>
        <p>${esc(submission.studentName)} · ${esc(submission.className)} · ${esc(fmtDate(submission.submittedAt))}</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="result-banner">
        <div class="result-score">
          <strong>${esc(submission.pct)}%</strong>
          <span class="muted">${esc(submission.score)} of ${esc(submission.total)} correct</span>
        </div>
        <div class="toolbar">${badge(submission.mode, submission.mode === "Exam" ? "warn" : "brand")}</div>
      </div>
      <div class="review-list">${questions || emptyState("No questions", "This submission has no stored answers.")}</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-primary" data-action="close-modal">Close</button>
    </div>`;
}

function openTempPassword(user, password, title) {
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">${esc(title)}</h2>
        <p>${esc(user.name)} · ${esc(user.username)}</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="notice warn">Share this password privately. It is shown only once, and the user must change it at their next sign-in.</div>
      <div class="field mt-09">
        <span class="field-label">Temporary password</span>
        <code class="code-display">${esc(password)}</code>
      </div>
      <p class="form-note mt-06">Previous sessions for this account have been ended where applicable.</p>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn" data-action="copy-text" data-text="${esc(password)}">Copy password</button>
      <button type="button" class="btn btn-primary" data-action="close-modal">Done</button>
    </div>`);
}

function openImportResult(result) {
  state.importCredentials = result.created || [];
  const createdRows = state.importCredentials.length ? `
    <div class="table-wrap mt-09">
      <table>
        <thead><tr><th>Name</th><th>Class</th><th>Username</th><th>Temporary password</th></tr></thead>
        <tbody>
          ${state.importCredentials.map(item => `
            <tr>
              <td><strong>${esc(item.name)}</strong></td>
              <td>${esc(item.className)}</td>
              <td>${esc(item.username)}</td>
              <td><code>${esc(item.temporaryPassword)}</code></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : "";

  const issues = [
    ...(result.skipped || []).map(item => `Row ${item.rowNumber}: ${item.name} - ${item.reason}`),
    ...(result.failed || []).map(item => `Row ${item.rowNumber}: ${item.name || "Unknown"} - ${item.reason}`)
  ];

  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Student import complete</h2>
        <p>${esc(result.summary.created)} created, ${esc(result.summary.skipped)} skipped, ${esc(result.summary.failed)} failed.</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">Close</button>
    </div>
    <div class="modal-body">
      ${state.importCredentials.length ? `
        <div class="notice warn">Share these credentials privately. Passwords are shown only now, and each student must change theirs at first sign-in.</div>
        ${createdRows}` : `<div class="notice">No new students were created.</div>`}
      ${issues.length ? `
        <div class="field mt-09">
          <span class="field-label">Rows that need attention</span>
          <ul class="option-lines">
            ${issues.map(item => `<li class="option-line"><span>${esc(item)}</span></li>`).join("")}
          </ul>
        </div>` : ""}
    </div>
    <div class="modal-actions">
      ${state.importCredentials.length ? `<button type="button" class="btn" data-action="download-import-credentials">Download CSV</button>` : ""}
      <button type="button" class="btn btn-primary" data-action="close-modal">Done</button>
    </div>`);
}

function openQuestionImportResult(result) {
  const summary = result.summary || {
    total: (result.created || []).length + (result.skipped || []).length + (result.failed || []).length,
    created: (result.created || []).length,
    skipped: (result.skipped || []).length,
    failed: (result.failed || []).length
  };
  const created = result.created || [];
  const shownCreated = created.slice(0, 12);
  const issues = [
    ...(result.skipped || []).map(item => `Row ${item.rowNumber}: ${item.question} - ${item.reason}`),
    ...(result.failed || []).map(item => `Row ${item.rowNumber}: ${item.question || "Unknown"} - ${item.reason}`)
  ];
  const shownIssues = issues.slice(0, 20);

  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Question import complete</h2>
        <p>${esc(summary.created)} created, ${esc(summary.skipped)} skipped, ${esc(summary.failed)} failed from ${esc(summary.total)} item(s).</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">Close</button>
    </div>
    <div class="modal-body">
      ${shownCreated.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Row</th><th>Question</th><th>Subject</th></tr></thead>
            <tbody>
              ${shownCreated.map(item => `
                <tr>
                  <td>${esc(item.rowNumber)}</td>
                  <td><strong>${esc(item.question)}</strong></td>
                  <td>${esc(item.subject)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        ${created.length > shownCreated.length ? `<p class="form-note mt-06">Showing the first ${shownCreated.length} of ${created.length} imported questions.</p>` : ""}` : `
        <div class="notice">No new questions were imported.</div>`}
      ${shownIssues.length ? `
        <div class="field mt-09">
          <span class="field-label">Rows that need attention</span>
          <ul class="option-lines">
            ${shownIssues.map(item => `<li class="option-line"><span>${esc(item)}</span></li>`).join("")}
          </ul>
        </div>
        ${issues.length > shownIssues.length ? `<p class="form-note mt-06">Showing the first ${shownIssues.length} of ${issues.length} issues.</p>` : ""}` : ""}
      <p class="form-note mt-09">Rejected rows are never saved. Fix the file and upload it again if you need to add those questions.</p>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-primary" data-action="close-modal">Done</button>
    </div>`);
}

function downloadImportCredentials() {
  if (!state.importCredentials.length) return;
  const rows = [
    ["Name", "Class", "Username", "Temporary password"],
    ...state.importCredentials.map(item => [
      item.name,
      item.className,
      item.username,
      item.temporaryPassword
    ])
  ];
  const csv = rows
    .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "student-credentials.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openCreateUser() {
  const classes = state.data.classes;
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Add an account</h2>
        <p>A unique temporary password will be generated automatically.</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form class="form" data-form="create-user">
        <div class="form-row">
          <div class="field">
            <label for="user-name">Full name</label>
            <input id="user-name" name="name" type="text" maxlength="120" required>
          </div>
          <div class="field">
            <label for="user-username">Username / index number</label>
            <input id="user-username" name="username" type="text" maxlength="80" autocomplete="off" required>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="user-role">Role</label>
            <select id="user-role" name="role" required>
              <option value="student">Student</option>
              <option value="teacher">Teacher</option>
            </select>
          </div>
          <div class="field">
            <label for="user-class">Class</label>
            <select id="user-class" name="classId">
              <option value="">Select a class</option>
              ${classes.map(cls => `<option value="${cls.id}">${esc(cls.name)}</option>`).join("")}
            </select>
            <span class="field-hint">Required for students. Ignored for teachers.</span>
          </div>
        </div>
        <div class="field" data-teacher-subjects>
          <span class="field-label">Subjects</span>
          <div class="check-grid">
            ${availableSubjects().map(subject => `
              <label class="check-item">${checkbox(subject.id, false)} <span><strong>${esc(subject.name)}</strong></span></label>
            `).join("") || `<p class="form-note">Create a subject first.</p>`}
          </div>
          <span class="field-hint">Choose one or more subjects for teacher accounts.</span>
        </div>
        <p class="form-note">Usernames may use letters, numbers, dots, dashes and underscores. For students, this is usually their index number.</p>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="modal-actions modal-actions-flat">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Create account</button>
        </div>
      </form>
    </div>`);
}

function openRenameClass(classId) {
  const target = state.data.classes.find(cls => cls.id === classId);
  if (!target) return;
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Rename class</h2>
        <p>${esc(target.name)}</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form class="form" data-form="rename-class">
        <input type="hidden" name="id" value="${target.id}">
        <div class="field">
          <label for="class-name">Class name</label>
          <input id="class-name" name="name" type="text" maxlength="80" value="${esc(target.name)}" required>
        </div>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="modal-actions modal-actions-flat">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save name</button>
        </div>
      </form>
    </div>`);
}

function openRenameUser(userId) {
  const target = state.data.users.find(user => user.id === userId);
  if (!target) return;
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Edit name</h2>
        <p>${esc(target.username)}</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form class="form" data-form="rename-user">
        <input type="hidden" name="id" value="${target.id}">
        <div class="field">
          <label for="user-name">Full name</label>
          <input id="user-name" name="name" type="text" maxlength="120" value="${esc(target.name)}" required>
        </div>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="modal-actions modal-actions-flat">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save name</button>
        </div>
      </form>
    </div>`);
}

function openMoveUser(userId) {
  const target = state.data.users.find(user => user.id === userId);
  if (!target) return;
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Move student</h2>
        <p>${esc(target.name)} · currently ${esc(target.className || "unassigned")}</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form class="form" data-form="move-user">
        <input type="hidden" name="id" value="${target.id}">
        <div class="field">
          <label for="move-class">Class</label>
          <select id="move-class" name="classId" required>
            ${state.data.classes.map(cls => `<option value="${cls.id}" ${cls.id === target.classId ? "selected" : ""}>${esc(cls.name)}</option>`).join("")}
          </select>
        </div>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="modal-actions modal-actions-flat">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Move student</button>
        </div>
      </form>
    </div>`);
}

function openCreateSubject() {
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Add a subject</h2>
        <p>Subjects keep question banks separate.</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form class="form" data-form="create-subject">
        <div class="field">
          <label for="subject-name">Subject name</label>
          <input id="subject-name" name="name" type="text" maxlength="80" required placeholder="e.g. Mathematics">
        </div>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="modal-actions modal-actions-flat">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Add subject</button>
        </div>
      </form>
    </div>`);
}

function openRenameSubject(subjectId) {
  const target = availableSubjects().find(subject => Number(subject.id) === Number(subjectId));
  if (!target) return;
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Rename subject</h2>
        <p>Existing questions and quizzes keep their subject ID.</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form class="form" data-form="rename-subject">
        <input type="hidden" name="id" value="${target.id}">
        <div class="field">
          <label for="subject-name">Subject name</label>
          <input id="subject-name" name="name" type="text" maxlength="80" value="${esc(target.name)}" required>
        </div>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="modal-actions modal-actions-flat">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save name</button>
        </div>
      </form>
    </div>`);
}

function openAssignSubjects(userId) {
  const target = state.data.users.find(user => Number(user.id) === Number(userId));
  if (!target) return;
  const assigned = (target.subjectIds || []).map(Number);
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Assign subjects</h2>
        <p>${esc(target.name)} · ${esc(target.username)}</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form class="form" data-form="assign-subjects">
        <input type="hidden" name="id" value="${target.id}">
        <div class="field">
          <span class="field-label">Subjects this teacher can manage</span>
          <div class="check-grid">
            ${availableSubjects().map(subject => `
              <label class="check-item">${checkbox(subject.id, assigned.includes(Number(subject.id)))}
                <span><strong>${esc(subject.name)}</strong></span>
              </label>`).join("")}
          </div>
        </div>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="modal-actions modal-actions-flat">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save subjects</button>
        </div>
      </form>
    </div>`);
}

function openMoveStudent(studentId) {
  const target = (state.data.students || []).find(student => Number(student.id) === Number(studentId));
  if (!target) return;
  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Move student</h2>
        <p>${esc(target.name)} · currently ${esc(target.className || "unassigned")}</p>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form class="form" data-form="move-student">
        <input type="hidden" name="id" value="${target.id}">
        <div class="field">
          <label for="student-move-class">Class</label>
          <select id="student-move-class" name="classId" required>
            ${state.data.classes.map(cls => `<option value="${cls.id}" ${cls.id === target.classId ? "selected" : ""}>${esc(cls.name)}</option>`).join("")}
          </select>
        </div>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="modal-actions modal-actions-flat">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Move student</button>
        </div>
      </form>
    </div>`);
}

/* Actions */

async function runAction(button) {
  const action = button.dataset.action;
  const id = Number(button.dataset.id);
  const d = state.data;

  switch (action) {
    case "nav":
      navTo(button.dataset.view);
      return;
    case "logout":
      await logout();
      return;
    case "open-password":
      state.screen = "password";
      state.passwordForced = false;
      render();
      return;
    case "cancel-password":
      if (!state.passwordForced) {
        state.screen = "app";
        render();
      }
      return;
    case "toggle-password": {
      const input = document.getElementById(button.dataset.target);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? "Hide" : "Show";
      return;
    }
    case "open-create-user":
      openCreateUser();
      return;
    case "download-import-credentials":
      downloadImportCredentials();
      return;
    case "toggle-all-questions": {
      const boxes = [...document.querySelectorAll('form[data-form="create-quiz"] .check-group:not([hidden]) input[name="questionIds"]')];
      if (!boxes.length) return;
      const selectAll = !boxes.every(box => box.checked);
      boxes.forEach(box => {
        box.checked = selectAll;
      });
      button.textContent = selectAll ? "Clear all" : "Select all";
      return;
    }
    case "open-rename-class":
      openRenameClass(id);
      return;
    case "open-rename-user":
      openRenameUser(id);
      return;
    case "open-move-user":
      openMoveUser(id);
      return;
    case "open-create-subject":
      openCreateSubject();
      return;
    case "open-rename-subject":
      openRenameSubject(id);
      return;
    case "open-assign-subjects":
      openAssignSubjects(id);
      return;
    case "open-move-student":
      openMoveStudent(id);
      return;
    case "delete-subject": {
      const target = availableSubjects().find(subject => Number(subject.id) === Number(id));
      if (!target) return;
      if (!window.confirm(`Delete the subject "${target.name}"? Subjects with questions or quizzes cannot be deleted.`)) return;
      await api(`/admin/subjects/${id}`, { method: "DELETE" });
      await refresh();
      toast("Subject deleted.", "success");
      return;
    }
    case "approve-quiz":
    case "unapprove-quiz": {
      const approved = action === "approve-quiz";
      await api(`/admin/quizzes/${id}`, { method: "PATCH", body: { approved } });
      await refresh();
      toast(approved ? "Quiz approved." : "Quiz returned to the teacher.", "success");
      return;
    }
    case "admin-toggle-quiz": {
      const target = (d.quizzes || []).find(quiz => Number(quiz.id) === Number(id));
      if (!target) return;
      await api(`/admin/quizzes/${id}`, { method: "PATCH", body: { isOpen: !target.isOpen } });
      await refresh();
      toast(`Quiz ${target.isOpen ? "closed" : "opened"}.`, "success");
      return;
    }
    case "delete-class": {
      const target = d.classes.find(cls => cls.id === id);
      if (!target) return;
      if (!window.confirm(`Delete the class "${target.name}"? This is blocked if students or quizzes remain.`)) return;
      await api(`/admin/classes/${id}`, { method: "DELETE" });
      await refresh();
      toast("Class deleted.", "success");
      return;
    }
    case "reset-password": {
      const target = d.users.find(user => user.id === id);
      if (!target) return;
      if (!window.confirm(`Reset the password for ${target.name}? Their current sessions will end.`)) return;
      const result = await api(`/admin/users/${id}/reset-password`, { method: "POST", body: {} });
      await refresh();
      openTempPassword(target, result.temporaryPassword, "Password reset");
      return;
    }
    case "toggle-user": {
      const target = d.users.find(user => user.id === id);
      if (!target) return;
      const nextActive = !target.active;
      if (!window.confirm(`${nextActive ? "Activate" : "Suspend"} ${target.name}?`)) return;
      await api(`/admin/users/${id}`, { method: "PATCH", body: { active: nextActive } });
      await refresh();
      toast(`Account ${nextActive ? "activated" : "suspended"}.`, "success");
      return;
    }
    case "delete-user": {
      const target = d.users.find(user => user.id === id);
      if (!target) return;
      if (!window.confirm(`Permanently delete ${target.name} (${target.username})? Accounts with attempts, questions or quizzes cannot be deleted.`)) return;
      await api(`/admin/users/${id}`, { method: "DELETE" });
      await refresh();
      toast("Account deleted.", "success");
      return;
    }
    case "delete-question": {
      if (!window.confirm("Delete this question from your bank? Quizzes already created keep their own copy.")) return;
      await api(`/teacher/questions/${id}`, { method: "DELETE" });
      await refresh();
      toast("Question deleted.", "success");
      return;
    }
    case "toggle-quiz": {
      const target = d.quizzes.find(quiz => quiz.id === id);
      if (!target) return;
      await api(`/teacher/quizzes/${id}`, { method: "PATCH", body: { isOpen: !target.isOpen } });
      await refresh();
      toast(`Quiz ${target.isOpen ? "closed" : "opened"}.`, "success");
      return;
    }
    case "toggle-shuffle": {
      const target = d.quizzes.find(quiz => quiz.id === id);
      if (!target) return;
      await api(`/teacher/quizzes/${id}`, {
        method: "PATCH",
        body: { shuffleQuestions: !target.shuffleQuestions }
      });
      await refresh();
      toast(`Question shuffling ${target.shuffleQuestions ? "disabled" : "enabled"}.`, "success");
      return;
    }
    case "archive-quiz": {
      const target = d.quizzes.find(quiz => quiz.id === id);
      if (!target) return;
      if (!window.confirm(`Archive "${target.title}"? Students will no longer see it, but submissions are kept.`)) return;
      await api(`/teacher/quizzes/${id}`, { method: "DELETE" });
      await refresh();
      toast("Quiz archived. Submissions remain available.", "success");
      return;
    }
    case "view-quiz-results": {
      const results = await api(`/teacher/quizzes/${id}/results`);
      state.results = results;
      state.resultsQuizId = id;
      state.view = "results";
      state.screen = "app";
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    case "delete-announcement": {
      if (!window.confirm("Delete this announcement?")) return;
      await api(`/teacher/announcements/${id}`, { method: "DELETE" });
      await refresh();
      toast("Announcement deleted.", "success");
      return;
    }
    case "inspect-submission":
      await openSubmission(id);
      return;
    case "start-quiz":
      await startQuiz(id, button.dataset.mode);
      return;
    case "goto-question":
      state.currentIndex = Number(button.dataset.index);
      renderAttempt();
      return;
    case "prev-question":
      if (state.currentIndex > 0) state.currentIndex -= 1;
      renderAttempt();
      return;
    case "next-question":
      if (state.attempt && state.currentIndex < state.attempt.questions.length - 1) state.currentIndex += 1;
      renderAttempt();
      return;
    case "answer":
      await answerQuestion(Number(button.dataset.position), Number(button.dataset.index));
      return;
    case "submit-attempt":
      await submitAttempt(false);
      return;
    case "exit-attempt":
      await exitAttempt();
      return;
    case "close-modal":
      closeModal();
      return;
    case "copy-text": {
      const text = button.dataset.text || "";
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied to clipboard.", "success");
      } catch {
        toast("Could not copy automatically. Select the password and copy it manually.", "warn");
      }
      return;
    }
    default:
      return;
  }
}

async function logout() {
  closeModal();
  clearTimer();
  try {
    await api("/auth/logout", { method: "POST", ignoreAuth: true });
  } catch {
    // The local session is cleared even if the server request fails.
  }
  showLogin("You have signed out.");
  toast("Signed out.", "success");
}

/* Forms */

function clearFormError(form) {
  const slot = form.querySelector("[data-form-error]");
  if (slot) slot.textContent = "";
}

function showFormError(form, message) {
  const slot = form.querySelector("[data-form-error]");
  if (slot) slot.textContent = message;
  else toast(message, "error");
}

async function runForm(form, task) {
  const button = form.querySelector('button[type="submit"]');
  const label = button ? button.textContent : "";
  clearFormError(form);
  if (button) {
    button.disabled = true;
    button.textContent = "Working…";
  }
  try {
    await task();
  } catch (error) {
    showFormError(form, error.message);
  } finally {
    if (button && document.body.contains(button)) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

async function handleSubmit(form) {
  const formType = form.dataset.form;

  if (formType === "login") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const result = await api("/auth/login", {
        method: "POST",
        ignoreAuth: true,
        body: {
          username: String(data.get("username") || "").trim(),
          password: String(data.get("password") || "")
        }
      });
      await afterLogin(result.user);
      toast(`Signed in as ${result.user.name}.`, "success");
    });
    return;
  }

  if (formType === "change-password") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const currentPassword = String(data.get("currentPassword") || "");
      const newPassword = String(data.get("newPassword") || "");
      const confirmation = String(data.get("confirmPassword") || "");
      if (newPassword !== confirmation) throw new Error("The new passwords do not match.");

      const result = await api("/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword }
      });
      state.user = result.user;
      state.user.mustChangePassword = false;
      state.passwordForced = false;
      state.screen = "app";
      state.view = defaultView(state.user.role);
      await loadData();
      render();
      toast("Password updated.", "success");
    });
    return;
  }

  if (formType === "create-class") {
    await runForm(form, async () => {
      const data = new FormData(form);
      await api("/admin/classes", {
        method: "POST",
        body: { name: String(data.get("name") || "").trim() }
      });
      await refresh();
      toast("Class created.", "success");
    });
    return;
  }

  if (formType === "rename-class") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const id = Number(data.get("id"));
      await api(`/admin/classes/${id}`, {
        method: "PATCH",
        body: { name: String(data.get("name") || "").trim() }
      });
      closeModal();
      await refresh();
      toast("Class renamed.", "success");
    });
    return;
  }

  if (formType === "import-students") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const file = data.get("file");
      if (!(file instanceof File) || !file.size) throw new Error("Choose an Excel file to upload.");
      const upload = new FormData();
      upload.append("file", file, file.name);
      const result = await api("/admin/students/import", { method: "POST", formData: upload });
      await refresh();
      openImportResult(result);
    });
    return;
  }

  if (formType === "create-user") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const role = String(data.get("role") || "");
      const body = {
        name: String(data.get("name") || "").trim(),
        username: String(data.get("username") || "").trim(),
        role
      };
      if (role === "student") {
        const classId = Number(data.get("classId"));
        if (!classId) throw new Error("Select a class for the student.");
        body.classId = classId;
      } else {
        const subjectIds = data.getAll("subjectIds").map(value => Number(value));
        if (!subjectIds.length) throw new Error("Assign at least one subject to the teacher.");
        body.subjectIds = subjectIds;
      }
      const result = await api("/admin/users", { method: "POST", body });
      closeModal();
      await refresh();
      openTempPassword(result.user, result.temporaryPassword, "Account created");
    });
    return;
  }

  if (formType === "rename-user") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const id = Number(data.get("id"));
      const name = String(data.get("name") || "").trim();
      if (name.length < 2) throw new Error("Enter a name of at least 2 characters.");
      await api(`/admin/users/${id}`, { method: "PATCH", body: { name } });
      closeModal();
      await refresh();
      toast("Name updated.", "success");
    });
    return;
  }

  if (formType === "move-user") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const id = Number(data.get("id"));
      const classId = Number(data.get("classId"));
      if (!classId) throw new Error("Select a class.");
      await api(`/admin/users/${id}`, { method: "PATCH", body: { classId } });
      closeModal();
      await refresh();
      toast("Student moved.", "success");
    });
    return;
  }

  if (formType === "create-subject") {
    await runForm(form, async () => {
      const data = new FormData(form);
      await api("/admin/subjects", {
        method: "POST",
        body: { name: String(data.get("name") || "").trim() }
      });
      closeModal();
      await refresh();
      toast("Subject added.", "success");
    });
    return;
  }

  if (formType === "rename-subject") {
    await runForm(form, async () => {
      const data = new FormData(form);
      await api(`/admin/subjects/${Number(data.get("id"))}`, {
        method: "PATCH",
        body: { name: String(data.get("name") || "").trim() }
      });
      closeModal();
      await refresh();
      toast("Subject renamed.", "success");
    });
    return;
  }

  if (formType === "assign-subjects") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const subjectIds = data.getAll("subjectIds").map(value => Number(value));
      if (!subjectIds.length) throw new Error("Assign at least one subject.");
      await api(`/admin/users/${Number(data.get("id"))}`, {
        method: "PATCH",
        body: { subjectIds }
      });
      closeModal();
      await refresh();
      toast("Teacher subjects updated.", "success");
    });
    return;
  }

  if (formType === "move-student") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const classId = Number(data.get("classId"));
      if (!classId) throw new Error("Select a class.");
      await api(`/teacher/students/${Number(data.get("id"))}`, {
        method: "PATCH",
        body: { classId }
      });
      closeModal();
      await refresh();
      toast("Student moved.", "success");
    });
    return;
  }

  if (formType === "settings") {
    await runForm(form, async () => {
      const data = new FormData(form);
      await api("/admin/settings", {
        method: "PUT",
        body: {
          defaultQuizMinutes: Number(data.get("defaultQuizMinutes")),
          minQuizMinutes: Number(data.get("minQuizMinutes")),
          maxQuizMinutes: Number(data.get("maxQuizMinutes")),
          minQuestions: Number(data.get("minQuestions")),
          maxQuestions: Number(data.get("maxQuestions")),
          passMark: Number(data.get("passMark")),
          maxAttempts: Number(data.get("maxAttempts")),
          requireApproval: data.has("requireApproval"),
          showSolutions: data.has("showSolutions"),
          allowRetakes: data.has("allowRetakes")
        }
      });
      await refresh();
      toast("Settings saved.", "success");
    });
    return;
  }

  if (formType === "import-questions") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const file = data.get("file");
      if (!(file instanceof File) || !file.size) throw new Error("Choose a question file to upload.");
      const upload = new FormData();
      upload.append("file", file, file.name);
      upload.append("subjectId", String(data.get("subjectId") || ""));
      const result = await api("/teacher/questions/import", { method: "POST", formData: upload });
      form.reset();
      await refresh();
      openQuestionImportResult(result);
    });
    return;
  }

  if (formType === "add-question") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const options = [0, 1, 2, 3].map(index => String(data.get(`option${index}`) || "").trim());
      const body = {
        questionText: String(data.get("questionText") || "").trim(),
        subjectId: Number(data.get("subjectId")),
        options,
        correctIndex: Number(data.get("correctIndex")),
        solution: String(data.get("solution") || "").trim()
      };
      await api("/teacher/questions", { method: "POST", body });
      await refresh();
      toast("Question added.", "success");
    });
    return;
  }

  if (formType === "create-quiz") {
    await runForm(form, async () => {
      const data = new FormData(form);
      const questionIds = data.getAll("questionIds").map(value => Number(value));
      if (!questionIds.length) throw new Error("Select at least one question.");
      await api("/teacher/quizzes", {
        method: "POST",
        body: {
          title: String(data.get("title") || "").trim(),
          classId: Number(data.get("classId")),
          subjectId: Number(data.get("subjectId")),
          minutes: Number(data.get("minutes")),
          shuffleQuestions: Boolean(data.get("shuffleQuestions")),
          questionIds
        }
      });
      await refresh();
      toast(state.data.settings.requireApproval
        ? "Quiz created and sent for approval."
        : "Quiz created and opened.", "success");
    });
    return;
  }

  if (formType === "post-announcement") {
    await runForm(form, async () => {
      const data = new FormData(form);
      await api("/teacher/announcements", {
        method: "POST",
        body: { text: String(data.get("text") || "").trim() }
      });
      await refresh();
      toast("Announcement posted.", "success");
    });
  }
}

/* Events */

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (!appEl.contains(button) && !modalEl.contains(button)) return;
  event.preventDefault();

  try {
    await runAction(button);
  } catch (error) {
    toast(error.message, "error");
  }
});

document.addEventListener("change", event => {
  const select = event.target.closest('select[name="subjectId"], select[name="role"]');
  if (!select) return;
  applyFormVisibility();
});

document.addEventListener("submit", async event => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  await handleSubmit(form);
});

modalEl.addEventListener("click", event => {
  if (event.target === modalEl) closeModal();
});

window.addEventListener("beforeunload", event => {
  if (!state.attempt) return;
  event.preventDefault();
  event.returnValue = "";
});

async function init() {
  try {
    const data = await api("/auth/me", { ignoreAuth: true });
    state.user = data.user;
    if (data.user.mustChangePassword) {
      showPassword(true);
      return;
    }
    state.screen = "app";
    state.view = defaultView(data.user.role);
    await loadData();
    render();
  } catch (error) {
    showLogin(error.status === 401 ? "" : error.message);
  }
}

init();
