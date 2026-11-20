"use strict";

/**
 * Teacher question importer.
 *
 * Every record is validated before it reaches Firestore: four distinct
 * options, a resolvable correct answer, an assigned subject, and a written
 * worked solution. Subjects are never created or assigned here — the teacher
 * may only use subjects the administrator has already given them.
 */

const ExcelJS = require("exceljs");
const { insertDoc, listWhereIn } = require("./fdb");
const { subjectIdsOf, subjectMap } = require("./subjects");
const { logActivity } = require("./utils");
const { sanitizeSvg } = require("./svg");
const { questionCreateSchema } = require("./validation");

const MAX_IMPORT_ROWS = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const LETTERS = ["A", "B", "C", "D"];

const TEMPLATE_HEADERS = [
  "question",
  "optionA",
  "optionB",
  "optionC",
  "optionD",
  "answer",
  "solution",
  "subject",
  "diagram"
];

const TEMPLATE_SAMPLE = [
  "What is 6 times 7?",
  "40",
  "42",
  "44",
  "48",
  "B",
  "Multiply 6 by 7 to get 42, so option B is the correct choice here.",
  "",
  ""
];

const HEADER_ALIASES = {
  question: ["question", "questiontext", "q", "text", "prompt"],
  optionA: ["optiona", "option1", "a", "choicea", "choice1"],
  optionB: ["optionb", "option2", "b", "choiceb", "choice2"],
  optionC: ["optionc", "option3", "c", "choicec", "choice3"],
  optionD: ["optiond", "option4", "d", "choiced", "choice4"],
  answer: ["answer", "correct", "correctanswer", "correctoption", "ans", "key"],
  correctIndex: ["correctindex"],
  solution: ["solution", "explanation", "workedsolution", "steps", "workings", "reason"],
  subject: ["subject", "subjectname", "subjectid"],
  diagram: ["diagram", "svg", "image"]
};

const DEFAULT_HEADER_MAP = {
  question: 0,
  optionA: 1,
  optionB: 2,
  optionC: 3,
  optionD: 4,
  answer: 5,
  solution: 6,
  subject: 7,
  diagram: 8
};

const PLACEHOLDER_SOLUTIONS = new Set([
  "n/a",
  "na",
  "none",
  "no explanation",
  "no explanation provided",
  "see above",
  "same as above",
  "correct answer",
  "the answer is given",
  "tbd"
]);

class QuestionImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "QuestionImportError";
    this.status = status;
  }
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map(part => part.text || "").join("").trim();
    }
    if (value.text !== undefined && value.text !== null) return String(value.text).trim();
    if (value.result !== undefined && value.result !== null) return String(value.result).trim();
    if (value.hyperlink) return String(value.hyperlink).trim();
  }
  return String(value).replace(/\r\n?/g, "\n").trim();
}

function normalizeHeader(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeWhitespace(value) {
  return cleanText(value).replace(/\s+/g, " ");
}

function normalizedQuestion(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function csvCell(value) {
  const text = cleanText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 5).join("\n");
  let best = ",";
  let bestCount = 0;
  for (const delimiter of [",", "\t", ";", "|"]) {
    const count = sample.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function findHeaderMap(cells) {
  const headers = cells.map(normalizeHeader);
  const map = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = headers.findIndex(header => aliases.includes(header));
    if (index >= 0) map[field] = index;
  }
  const optionCount = ["optionA", "optionB", "optionC", "optionD"]
    .filter(field => map[field] !== undefined).length;
  return map.question !== undefined && map.answer !== undefined && optionCount >= 2 ? map : null;
}

function recordsFromRows(numberedRows) {
  const rows = numberedRows.filter(item => item.cells.some(cell => cleanText(cell)));
  if (!rows.length) throw new QuestionImportError("The file is empty.");

  let headerMap = null;
  let startIndex = 0;
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const found = findHeaderMap(rows[index].cells);
    if (found) {
      headerMap = found;
      startIndex = index + 1;
      break;
    }
  }
  if (!headerMap) headerMap = DEFAULT_HEADER_MAP;

  const body = rows.slice(startIndex);
  if (body.length > MAX_IMPORT_ROWS) {
    throw new QuestionImportError(`Import at most ${MAX_IMPORT_ROWS} questions at a time.`);
  }

  return body.map(item => {
    const get = field => headerMap[field] === undefined ? "" : cleanText(item.cells[headerMap[field]]);
    return {
      rowNumber: item.rowNumber,
      question: get("question"),
      subject: get("subject"),
      options: [get("optionA"), get("optionB"), get("optionC"), get("optionD")],
      answer: get("answer"),
      correctIndex: get("correctIndex"),
      solution: get("solution"),
      diagram: get("diagram")
    };
  });
}

function numberedRowsFromText(text, delimiter) {
  return parseDelimited(text, delimiter).map((cells, index) => ({
    rowNumber: index + 1,
    cells
  }));
}

async function readWorkbookRows(buffer) {
  if (!buffer || !buffer.length) throw new QuestionImportError("The uploaded Excel file is empty.");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new QuestionImportError("Could not read that file. Upload a valid .xlsx workbook.");
  }

  const sheet = workbook.getWorksheet("Questions") || workbook.worksheets[0];
  if (!sheet) throw new QuestionImportError("The workbook does not contain a worksheet.");

  const rows = [];
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const width = Math.min(Math.max(row.cellCount, TEMPLATE_HEADERS.length), 20);
    const cells = [];
    for (let column = 1; column <= width; column += 1) {
      cells.push(cleanText(row.getCell(column).value));
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

function firstDefined(item, keys) {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null) return item[key];
  }
  return "";
}

function normalizeJsonOptions(value, item) {
  let options = value;
  if (typeof options === "string") options = options.split(/[|\n]/);
  if (options && typeof options === "object" && !Array.isArray(options)) {
    options = [
      firstDefined(options, ["A", "a", "optionA", "optiona", "1"]),
      firstDefined(options, ["B", "b", "optionB", "optionb", "2"]),
      firstDefined(options, ["C", "c", "optionC", "optionc", "3"]),
      firstDefined(options, ["D", "d", "optionD", "optiond", "4"])
    ];
  }
  if (!Array.isArray(options)) {
    options = [
      firstDefined(item, ["optionA", "optiona", "a", "A", "choiceA"]),
      firstDefined(item, ["optionB", "optionb", "b", "B", "choiceB"]),
      firstDefined(item, ["optionC", "optionc", "c", "C", "choiceC"]),
      firstDefined(item, ["optionD", "optiond", "d", "D", "choiceD"])
    ];
  }
  return options.map(cleanText);
}

function recordsFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new QuestionImportError("The JSON file could not be read. Check for missing commas or brackets.");
  }

  let list;
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.questions)) list = data.questions;
  else if (data && typeof data === "object") list = [data];
  else throw new QuestionImportError("JSON must contain an array of questions.");

  if (list.length > MAX_IMPORT_ROWS) {
    throw new QuestionImportError(`Import at most ${MAX_IMPORT_ROWS} questions at a time.`);
  }

  return list.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        rowNumber: index + 1,
        question: "",
        subject: "",
        options: [],
        answer: "",
        correctIndex: "",
        solution: "",
        diagram: "",
        invalidItem: true
      };
    }
    return {
      rowNumber: index + 1,
      question: cleanText(firstDefined(item, ["question", "questionText", "question_text", "q", "text", "prompt"])),
      subject: cleanText(firstDefined(item, ["subject", "subjectName", "subject_name", "subjectId", "subject_id"])),
      options: normalizeJsonOptions(firstDefined(item, ["options", "optionList", "choices"]), item),
      answer: cleanText(firstDefined(item, ["answer", "ans", "correct", "correctAnswer", "correct_answer", "correctOption", "key"])),
      correctIndex: firstDefined(item, ["correctIndex", "correct_index"]),
      solution: cleanText(firstDefined(item, ["solution", "sol", "explanation", "workedSolution", "worked_solution", "steps", "workings", "reason"])),
      diagram: cleanText(firstDefined(item, ["diagram", "svg", "image"]))
    };
  });
}

function recordsFromTextBlocks(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let current = null;
  let currentLabel = "";

  const questionPattern = /^\s*(?:#{1,6}\s*)?question(?:\s+\d+)?\s*:\s*(.*)$/i;
  const labelPattern = /^\s*(?:[-*]\s*)?(subject|answer|correct answer|solution|explanation|worked solution|diagram|svg|image)\s*:\s*(.*)$/i;
  const optionPattern = /^\s*(?:[-*]\s+)?(?:\(([A-Da-d])\)|([A-Da-d])[\).:\-])\s*(.*)$/;

  const newBlock = question => ({
    question,
    subject: "",
    options: ["", "", "", ""],
    answer: "",
    correctIndex: "",
    solutionLines: [],
    diagram: ""
  });

  for (const line of lines) {
    const questionMatch = line.match(questionPattern);
    if (questionMatch) {
      if (current) blocks.push(current);
      current = newBlock(questionMatch[1] || "");
      currentLabel = "";
      continue;
    }
    if (!current) continue;

    if (!line.trim()) {
      if (currentLabel === "solution") current.solutionLines.push("");
      continue;
    }

    const labelMatch = line.match(labelPattern);
    if (labelMatch) {
      const key = normalizeHeader(labelMatch[1]);
      const value = labelMatch[2] || "";
      if (key === "subject") {
        current.subject = value;
        currentLabel = "subject";
      } else if (key === "answer" || key === "correctanswer") {
        current.answer = value;
        currentLabel = "answer";
      } else if (["solution", "explanation", "workedsolution"].includes(key)) {
        current.solutionLines = [value];
        currentLabel = "solution";
      } else {
        current.diagram = value;
        currentLabel = "diagram";
      }
      continue;
    }

    if (currentLabel === "solution") {
      current.solutionLines.push(line.trim());
      continue;
    }
    if (currentLabel === "diagram") {
      current.diagram += `${current.diagram ? "\n" : ""}${line.trim()}`;
      continue;
    }

    const optionMatch = line.match(optionPattern);
    if (optionMatch) {
      const letter = (optionMatch[1] || optionMatch[2]).toUpperCase();
      const index = LETTERS.indexOf(letter);
      if (index >= 0) current.options[index] = optionMatch[3] || "";
      currentLabel = "";
      continue;
    }

    if (!current.subject && !current.answer && current.options.every(option => !option)) {
      current.question += ` ${line.trim()}`;
    }
  }

  if (current) blocks.push(current);
  if (!blocks.length) {
    throw new QuestionImportError('No questions found. Start each item with "Question: ...".');
  }
  if (blocks.length > MAX_IMPORT_ROWS) {
    throw new QuestionImportError(`Import at most ${MAX_IMPORT_ROWS} questions at a time.`);
  }

  return blocks.map((block, index) => ({
    rowNumber: index + 1,
    question: cleanText(block.question),
    subject: cleanText(block.subject),
    options: block.options.map(cleanText),
    answer: cleanText(block.answer),
    correctIndex: "",
    solution: cleanText(block.solutionLines.join("\n")),
    diagram: cleanText(block.diagram)
  }));
}

async function parseQuestionFile(buffer, originalName) {
  if (!buffer || !buffer.length) throw new QuestionImportError("Choose a question file to upload.");
  if (buffer.length > MAX_FILE_BYTES) {
    throw new QuestionImportError("The uploaded file is too large. Use a file under 5 MB.");
  }

  const extension = String(originalName || "").toLowerCase().split(".").pop();
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  if (extension === "csv" || extension === "tsv") {
    const delimiter = extension === "tsv" ? "\t" : detectDelimiter(text);
    return recordsFromRows(numberedRowsFromText(text, delimiter));
  }
  if (extension === "xlsx") return recordsFromRows(await readWorkbookRows(buffer));
  if (extension === "json") return recordsFromJson(text);
  if (extension === "txt" || extension === "md") return recordsFromTextBlocks(text);

  throw new QuestionImportError(
    "Unsupported file type. Use a CSV, TSV, XLSX, JSON, TXT or MD file."
  );
}

function answerIndex(value, options, zeroBased = false) {
  if (value === null || value === undefined) return -1;
  const raw = String(value).trim();
  if (!raw) return -1;

  const normalizedOptions = options.map(normalizeWhitespace);
  if (!zeroBased) {
    const exact = normalizedOptions.findIndex(option => option && option === normalizeWhitespace(raw));
    if (exact >= 0) return exact;
  }

  if (/^\d{1,2}$/.test(raw)) {
    const number = Number(raw);
    if (zeroBased) return number >= 0 && number <= 3 ? number : -1;
    return number >= 1 && number <= 4 ? number - 1 : -1;
  }

  const named = raw.match(/^(?:option|choice)\s*([A-Da-d1-4])$/i);
  if (named) {
    const token = named[1].toUpperCase();
    if (/^[1-4]$/.test(token)) return Number(token) - 1;
    return LETTERS.indexOf(token);
  }

  const letterMatch = raw.match(/^(?:\(([A-Da-d])\)\s*[\).:\-]?\s*.*|([A-Da-d])[\).:\-]\s*.*|([A-Da-d]))$/i);
  if (letterMatch) {
    return LETTERS.indexOf((letterMatch[1] || letterMatch[2] || letterMatch[3]).toUpperCase());
  }

  return -1;
}

function validateSolution(value) {
  const solution = normalizeWhitespace(value);
  if (!solution) return "A worked solution is required.";
  if (solution.length < 30) return "Write a worked solution of at least 30 characters.";
  const wordCount = solution.split(/\s+/).filter(Boolean).length;
  if (wordCount < 8) return "Write a worked solution of at least 8 words.";
  if (PLACEHOLDER_SOLUTIONS.has(solution.toLowerCase())) {
    return "Write a real worked solution explaining the reasoning.";
  }
  return null;
}

function validateRecord(record, resolveSubject) {
  if (record.invalidItem) {
    return { error: "Each JSON item must be a question object." };
  }

  const questionText = normalizeWhitespace(record.question);
  const options = (record.options || []).map(normalizeWhitespace);
  if (!questionText) return { error: "Question text is required." };
  if (options.length !== 4 || options.some(option => !option)) {
    return { error: "Exactly four non-empty options are required." };
  }
  if (new Set(options.map(option => option.toLowerCase())).size !== 4) {
    return { error: "The four options must be different from each other." };
  }

  let subjectId;
  try {
    subjectId = resolveSubject(record.subject);
  } catch (error) {
    return { error: error.message };
  }

  const hasCorrectIndex = record.correctIndex !== "" && record.correctIndex !== undefined;
  const correctIndex = answerIndex(
    hasCorrectIndex ? record.correctIndex : record.answer,
    options,
    hasCorrectIndex
  );
  if (correctIndex < 0) {
    return { error: "The correct answer must be A-D, 1-4, or the exact option text." };
  }

  const solution = normalizeWhitespace(record.solution);
  const solutionError = validateSolution(solution);
  if (solutionError) return { error: solutionError };

  let diagram = null;
  if (cleanText(record.diagram)) {
    diagram = sanitizeSvg(record.diagram);
    if (!diagram) return { error: "The optional diagram contains unsupported markup." };
  }

  const parsed = questionCreateSchema.safeParse({
    questionText,
    subjectId,
    options,
    correctIndex,
    solution
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0] ? parsed.error.issues[0].message : "Invalid question." };
  }

  return {
    value: {
      questionText: parsed.data.questionText,
      subjectId: Number(subjectId),
      options: parsed.data.options,
      correctIndex: parsed.data.correctIndex,
      solution: parsed.data.solution,
      diagram
    }
  };
}

async function importQuestionsFromBuffer(buffer, originalName, { actor, defaultSubjectId } = {}) {
  const records = await parseQuestionFile(buffer, originalName);
  const allowed = subjectIdsOf(actor);
  if (!allowed.length) {
    throw new QuestionImportError("Your account has no subjects assigned.", 403);
  }

  const fallbackId = defaultSubjectId ? Number(defaultSubjectId) : null;
  if (fallbackId && !allowed.includes(fallbackId)) {
    throw new QuestionImportError("That subject is not assigned to your account.", 403);
  }

  const names = await subjectMap();
  const nameToId = new Map(
    [...names.entries()].map(([id, name]) => [normalizeWhitespace(name).toLowerCase(), Number(id)])
  );

  function resolveSubject(value) {
    const raw = cleanText(value);
    if (!raw) {
      if (!fallbackId) {
        throw new QuestionImportError("Choose a default subject or include a subject in every row.");
      }
      return fallbackId;
    }
    let id = null;
    if (/^\d+$/.test(raw)) id = Number(raw);
    else id = nameToId.get(normalizeWhitespace(raw).toLowerCase()) || null;
    if (!id || !allowed.includes(id)) {
      throw new QuestionImportError(`Subject "${raw}" is not assigned to your account.`);
    }
    return id;
  }

  const existing = await listWhereIn("questions", "subject_id", allowed);
  const seen = new Set(existing.map(question =>
    `${Number(question.subject_id)}|${normalizedQuestion(question.question_text)}`
  ));

  const created = [];
  const skipped = [];
  const failed = [];

  for (const record of records) {
    const preview = normalizeWhitespace(record.question).slice(0, 160) || "Unknown question";
    const checked = validateRecord(record, resolveSubject);
    if (checked.error) {
      failed.push({ rowNumber: record.rowNumber, question: preview, reason: checked.error });
      continue;
    }

    const value = checked.value;
    const key = `${value.subjectId}|${normalizedQuestion(value.questionText)}`;
    if (seen.has(key)) {
      skipped.push({ rowNumber: record.rowNumber, question: value.questionText, reason: "This question already exists in that subject." });
      continue;
    }
    seen.add(key);

    const questionId = await insertDoc("questions", {
      question_text: value.questionText,
      options: value.options,
      correct_index: value.correctIndex,
      solution: value.solution,
      subject_id: value.subjectId,
      subject: names.get(value.subjectId) || "General",
      diagram_svg: value.diagram,
      created_by: actor.id,
      created_at: new Date(),
      updated_at: new Date()
    });

    created.push({
      rowNumber: record.rowNumber,
      questionId,
      question: value.questionText,
      subjectId: value.subjectId,
      subject: names.get(value.subjectId) || "General"
    });
  }

  if (created.length) {
    const extension = String(originalName || "file").toLowerCase().split(".").pop();
    await logActivity(actor, `Imported ${created.length} question(s) from ${extension.toUpperCase()}`);
  }

  return {
    created,
    skipped,
    failed,
    summary: {
      total: records.length,
      created: created.length,
      skipped: skipped.length,
      failed: failed.length
    }
  };
}

const TEXT_TEMPLATE = `Learners Connect question import template (TXT/MD)

Start each question with "Question: ...". Blank lines are allowed. Use A., B.,
C. and D. for the four options, then Answer: and Solution:. The subject line is
optional when you choose a default subject in the portal. An answer may be A-D,
1-4, or the exact option text. The solution must explain the reasoning in at
least 8 words.

## Question 1
Question: What is 6 times 7?
Subject:
A. 40
B. 42
C. 44
D. 48
Answer: B
Solution: Multiply 6 by 7 to get 42, so option B is the correct choice here.

## Question 2
Question: Which gas do plants absorb during photosynthesis?
Subject:
A. Oxygen
B. Nitrogen
C. Carbon dioxide
D. Hydrogen
Answer: C
Solution: Plants take in carbon dioxide from the air and use it with sunlight to make glucose during photosynthesis.
`;

function buildCsvTemplate() {
  const csv = [TEMPLATE_HEADERS, TEMPLATE_SAMPLE]
    .map(row => row.map(csvCell).join(","))
    .join("\r\n");
  return Buffer.from(`${csv}\r\n`, "utf8");
}

function buildJsonTemplate() {
  const payload = {
    questions: [
      {
        question: TEMPLATE_SAMPLE[0],
        subject: "",
        options: TEMPLATE_SAMPLE.slice(1, 5),
        answer: TEMPLATE_SAMPLE[5],
        solution: TEMPLATE_SAMPLE[6]
      }
    ]
  };
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function buildXlsxTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Learners Connect";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Questions", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  const widths = [52, 24, 24, 24, 24, 16, 72, 26, 30];
  sheet.columns = TEMPLATE_HEADERS.map((header, index) => ({
    header,
    key: `column${index}`,
    width: widths[index]
  }));
  sheet.addRow(TEMPLATE_SAMPLE);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1D5C46" }
  };
  sheet.autoFilter = "A1:I1";

  const notes = workbook.addWorksheet("Instructions");
  notes.columns = [{ width: 110 }];
  const lines = [
    ["Learners Connect question import template", { bold: true, size: 14 }],
    ["", {}],
    ["1. Put one question on each row of the Questions sheet.", {}],
    ["2. question, optionA, optionB, optionC, optionD, answer and solution are required.", {}],
    ["3. The answer may be A-D, 1-4, or the exact text of the correct option.", {}],
    ["4. The solution must explain the reasoning in at least 8 words.", {}],
    ["5. Subject is optional. Use an assigned subject name or numeric id, or leave it blank to use the selected default.", {}],
    ["6. Diagram is optional and must be sanitized SVG. Leave it blank if not needed.", {}],
    ["7. Import at most 500 questions and keep the file under 5 MB.", {}],
    ["", {}],
    ["Questions with missing answers, missing explanations, duplicate options or duplicate question text are rejected.", {}]
  ];
  for (const [text, font] of lines) {
    const row = notes.addRow([text]);
    if (font.bold) row.font = font;
  }
  notes.getColumn(1).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildQuestionTemplate(format) {
  if (format === "csv") {
    return {
      buffer: buildCsvTemplate(),
      contentType: "text/csv; charset=utf-8",
      filename: "gbat-question-import-template.csv"
    };
  }
  if (format === "json") {
    return {
      buffer: buildJsonTemplate(),
      contentType: "application/json; charset=utf-8",
      filename: "gbat-question-import-template.json"
    };
  }
  if (format === "txt" || format === "md") {
    return {
      buffer: Buffer.from(TEXT_TEMPLATE, "utf8"),
      contentType: "text/plain; charset=utf-8",
      filename: `gbat-question-import-template.${format}`
    };
  }
  if (format === "xlsx") {
    return {
      buffer: await buildXlsxTemplate(),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "gbat-question-import-template.xlsx"
    };
  }
  throw new QuestionImportError("Unknown template format.");
}

module.exports = {
  MAX_IMPORT_ROWS,
  MAX_FILE_BYTES,
  TEMPLATE_HEADERS,
  QuestionImportError,
  parseQuestionFile,
  buildQuestionTemplate,
  importQuestionsFromBuffer
};
