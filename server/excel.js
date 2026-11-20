"use strict";

const ExcelJS = require("exceljs");

const TEMPLATE_HEADERS = ["First name", "Last name", "Class", "Username (optional)"];
const MAX_IMPORT_ROWS = 300;

class ExcelInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExcelInputError";
    this.status = 400;
  }
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("").trim();
    if (value.text !== undefined && value.text !== null) return String(value.text).trim();
    if (value.result !== undefined && value.result !== null) return String(value.result).trim();
    if (value.hyperlink) return String(value.hyperlink).trim();
    if (value.error) return "";
  }
  return String(value).trim();
}

function normalizeHeader(value) {
  return cellText(value)
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugPart(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function usernameBase(firstName, lastName, className) {
  let base = [slugPart(firstName), slugPart(lastName)].filter(Boolean).join(".");
  if (base.length < 3) {
    base = [base || "student", slugPart(className) || "class"].filter(Boolean).join(".");
  }
  return base.slice(0, 80);
}

async function buildStudentTemplate(classNames) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Learners Connect";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Students", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { header: TEMPLATE_HEADERS[0], key: "firstName", width: 24 },
    { header: TEMPLATE_HEADERS[1], key: "lastName", width: 24 },
    { header: TEMPLATE_HEADERS[2], key: "className", width: 22 },
    { header: TEMPLATE_HEADERS[3], key: "username", width: 28 }
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1D5C46" }
  };
  sheet.autoFilter = "A1:D1";

  const notes = workbook.addWorksheet("Instructions");
  notes.columns = [{ width: 100 }];
  const lines = [
    ["Learners Connect student import template", { bold: true, size: 14 }],
    ["", {}],
    ["1. Enter one student per row on the Students sheet.", {}],
    ["2. First name and Last name are required.", {}],
    ["3. Class must match a class already created in the portal.", {}],
    ["4. Username is optional. Leave it blank to generate firstname.lastname automatically.", {}],
    ["5. Each student gets a random temporary password shown only at import time.", {}],
    ["6. Every student must change their password at first sign-in.", {}],
    ["", {}],
    [`Classes available: ${classNames.length ? classNames.join(", ") : "No classes have been created yet."}`, {}],
    ["", {}],
    ["Send the completed file to the administrator for upload.", {}]
  ];
  for (const [text, font] of lines) {
    const row = notes.addRow([text]);
    if (font.bold) row.font = font;
  }
  notes.getColumn(1).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function readStudentRows(buffer) {
  if (!buffer || !buffer.length) throw new ExcelInputError("The uploaded Excel file is empty.");

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new ExcelInputError("Could not read that file. Upload a valid .xlsx Excel workbook.");
  }

  const sheet = workbook.getWorksheet("Students") || workbook.worksheets[0];
  if (!sheet) throw new ExcelInputError("The workbook does not contain a worksheet.");

  const alias = (headers, names) => headers.findIndex(header => names.includes(header));
  let headerRowNumber = 0;
  let firstNameIndex = -1;
  let lastNameIndex = -1;
  let nameIndex = -1;
  let classIndex = -1;
  let usernameIndex = -1;

  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 10); rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const headers = [];
    for (let column = 1; column <= row.cellCount; column += 1) {
      headers.push(normalizeHeader(row.getCell(column).value));
    }
    const nextFirstName = alias(headers, ["first name", "firstname", "first_name", "given name", "givenname"]);
    const nextLastName = alias(headers, ["last name", "lastname", "last_name", "surname", "family name", "familyname"]);
    const nextName = alias(headers, ["name", "full name", "student name", "student full name"]);
    const nextClass = alias(headers, ["class", "class name", "classname", "class_name"]);
    if (nextClass < 0 || (nextFirstName < 0 && nextName < 0)) continue;

    headerRowNumber = rowNumber;
    firstNameIndex = nextFirstName;
    lastNameIndex = nextLastName;
    nameIndex = nextName;
    classIndex = nextClass;
    usernameIndex = headers.findIndex(header => header === "username" || header.startsWith("username "));
    break;
  }

  if (!headerRowNumber) {
    throw new ExcelInputError(
      "Header row not found. Use columns: First name, Last name, Class, Username (optional)."
    );
  }

  const rows = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const firstName = firstNameIndex >= 0 ? cellText(row.getCell(firstNameIndex + 1).value) : "";
    const lastName = lastNameIndex >= 0 ? cellText(row.getCell(lastNameIndex + 1).value) : "";
    const fullName = nameIndex >= 0 ? cellText(row.getCell(nameIndex + 1).value) : "";
    const className = cellText(row.getCell(classIndex + 1).value);
    const username = usernameIndex >= 0 ? cellText(row.getCell(usernameIndex + 1).value) : "";

    if (!firstName && !lastName && !fullName && !className && !username) continue;

    let resolvedFirst = firstName;
    let resolvedLast = lastName;
    if (!resolvedFirst && fullName) {
      const parts = fullName.split(/\s+/).filter(Boolean);
      resolvedFirst = parts.shift() || "";
      resolvedLast = parts.join(" ");
    }

    rows.push({
      rowNumber,
      firstName: resolvedFirst,
      lastName: resolvedLast,
      name: `${resolvedFirst} ${resolvedLast}`.replace(/\s+/g, " ").trim(),
      className,
      username
    });
  }

  if (!rows.length) throw new ExcelInputError("The Excel file contains no student rows.");
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ExcelInputError(`Import at most ${MAX_IMPORT_ROWS} students at a time.`);
  }
  return rows;
}

module.exports = {
  TEMPLATE_HEADERS,
  MAX_IMPORT_ROWS,
  ExcelInputError,
  buildStudentTemplate,
  readStudentRows,
  usernameBase
};
