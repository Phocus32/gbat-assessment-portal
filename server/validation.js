"use strict";

const { z } = require("zod");

const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(72, "Password must be at most 72 characters.")
  .regex(/[a-z]/, "Password must contain a lowercase letter.")
  .regex(/[A-Z]/, "Password must contain an uppercase letter.")
  .regex(/[0-9]/, "Password must contain a number.");

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters.")
  .max(80, "Username is too long.")
  .regex(/^[A-Za-z0-9._-]+$/, "Username may only contain letters, numbers, dots, dashes and underscores.");

const nameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters.")
  .max(120, "Name is too long.");

const idSchema = z.coerce.number().int().positive();

// Blank form fields are treated as "no restriction". Preserve `undefined` on
// updates so a toggle does not accidentally clear an existing schedule.
const quizDateSchema = z.preprocess(
  value => value === "" ? null : value,
  z.iso.datetime().nullable().optional()
    .transform(value => value === undefined ? undefined : value ? new Date(value) : null)
);

const loginSchema = z.object({
  username: z.string().trim().min(1, "Enter your username.").max(80),
  password: z.string().min(1, "Enter your password.").max(72)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(72),
  newPassword: passwordSchema
});

const classCreateSchema = z.object({
  name: z.string().trim().min(2, "Class name must be at least 2 characters.").max(80, "Class name is too long.")
});

const classUpdateSchema = classCreateSchema;

const subjectCreateSchema = z.object({
  name: z.string().trim().min(2, "Subject name must be at least 2 characters.").max(80, "Subject name is too long.")
});

const subjectUpdateSchema = subjectCreateSchema;

const subjectIdsSchema = z
  .array(z.coerce.number().int().positive())
  .max(40, "Too many subjects selected.");

const userCreateSchema = z.object({
  name: nameSchema,
  username: usernameSchema,
  role: z.enum(["student", "teacher"]),
  classId: z.coerce.number().int().positive().nullable().optional(),
  subjectIds: subjectIdsSchema.optional()
}).superRefine((value, ctx) => {
  if (value.role === "student" && !value.classId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["classId"], message: "Select a class for the student." });
  }
});

const userUpdateSchema = z.object({
  name: nameSchema.optional(),
  active: z.boolean().optional(),
  classId: z.coerce.number().int().positive().nullable().optional(),
  subjectIds: subjectIdsSchema.optional()
});

const questionCreateSchema = z.object({
  questionText: z.string().trim().min(5, "Question text is too short.").max(4000, "Question text is too long."),
  subjectId: z.coerce.number().int().positive("Choose a subject."),
  options: z.array(z.string().trim().min(1, "Options cannot be empty.").max(500, "Option is too long.")).length(4, "Four options are required."),
  correctIndex: z.coerce.number().int().min(0).max(3),
  solution: z.string().trim().min(5, "Worked solution is too short.").max(8000, "Worked solution is too long.")
});

const questionImportSchema = z.object({
  subjectId: z.coerce.number().int().positive().optional()
});

const quizCreateSchema = z.object({
  title: z.string().trim().min(3, "Quiz title must be at least 3 characters.").max(160, "Quiz title is too long."),
  classId: z.coerce.number().int().positive("Select a class."),
  subjectId: z.coerce.number().int().positive("Choose a subject."),
  minutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute.").max(240, "Duration cannot exceed 240 minutes."),
  shuffleQuestions: z.boolean().default(false),
  allowPractice: z.boolean().default(true),
  startAt: quizDateSchema,
  endAt: quizDateSchema,
  questionIds: z
    .array(z.coerce.number().int().positive())
    .min(1, "Select at least one question.")
    .max(200, "A quiz cannot contain more than 200 questions.")
    .refine(ids => new Set(ids).size === ids.length, "Duplicate questions are not allowed.")
}).refine(
  value => !value.startAt || !value.endAt || value.endAt.getTime() > value.startAt.getTime(),
  { message: "Quiz end time must be after the begin time.", path: ["endAt"] }
);

const quizUpdateSchema = z.object({
  isOpen: z.boolean().optional(),
  shuffleQuestions: z.boolean().optional(),
  allowPractice: z.boolean().optional(),
  startAt: quizDateSchema,
  endAt: quizDateSchema
}).refine(
  value => value.isOpen !== undefined
    || value.shuffleQuestions !== undefined
    || value.allowPractice !== undefined
    || value.startAt !== undefined
    || value.endAt !== undefined,
  { message: "No changes were supplied." }
).refine(
  value => !value.startAt || !value.endAt || value.endAt.getTime() > value.startAt.getTime(),
  { message: "Quiz end time must be after the begin time.", path: ["endAt"] }
);

const adminQuizUpdateSchema = z.object({
  approved: z.boolean().optional(),
  isOpen: z.boolean().optional(),
  allowPractice: z.boolean().optional()
}).refine(
  value => value.approved !== undefined || value.isOpen !== undefined || value.allowPractice !== undefined,
  { message: "No changes were supplied." }
);

const teacherStudentUpdateSchema = z.object({
  classId: z.coerce.number().int().positive("Select a class.")
});

const startAttemptSchema = z.object({
  mode: z.enum(["Practice", "Exam"])
});

const answerSchema = z.object({
  position: z.coerce.number().int().min(0),
  chosenIndex: z.coerce.number().int().min(0).max(3)
});

const announcementCreateSchema = z.object({
  text: z.string().trim().min(1, "Enter a message.").max(2000, "Message is too long.")
});

const complaintCreateSchema = z.object({
  subject: z.string().trim().min(3, "Subject must be at least 3 characters.").max(160, "Subject is too long."),
  message: z.string().trim().min(10, "Please describe your complaint in at least 10 characters.").max(4000, "Complaint is too long."),
  category: z.enum(["academic", "technical", "facility", "other"]).default("other")
});

const complaintReplySchema = z.object({
  message: z.string().trim().min(1, "Enter a reply.").max(4000, "Reply is too long.")
});

const complaintStatusSchema = z.object({
  status: z.enum(["open", "closed"])
});

const classMembersSchema = z.object({
  userIds: z
    .array(z.coerce.number().int().positive())
    .min(1, "Select at least one student.")
    .max(200, "Too many students selected.")
    .refine(ids => new Set(ids).size === ids.length, "Duplicate students are not allowed.")
});

const searchQuerySchema = z.object({
  q: z.string().trim().max(120, "Search term is too long.").optional().default(""),
  classId: z.coerce.number().int().positive().optional()
});

const settingsSchema = z.object({
  defaultQuizMinutes: z.coerce.number().int().min(1).max(240),
  minQuizMinutes: z.coerce.number().int().min(1).max(240),
  maxQuizMinutes: z.coerce.number().int().min(1).max(240),
  minQuestions: z.coerce.number().int().min(1).max(200),
  maxQuestions: z.coerce.number().int().min(1).max(200),
  passMark: z.coerce.number().int().min(1).max(100),
  maxAttempts: z.coerce.number().int().min(0).max(50),
  requireApproval: z.boolean(),
  showSolutions: z.boolean(),
  allowRetakes: z.boolean()
}).refine(value => value.minQuizMinutes <= value.maxQuizMinutes, {
  message: "The minimum duration cannot exceed the maximum duration.",
  path: ["minQuizMinutes"]
}).refine(value => value.minQuestions <= value.maxQuestions, {
  message: "The minimum question count cannot exceed the maximum.",
  path: ["minQuestions"]
}).refine(value =>
  value.defaultQuizMinutes >= value.minQuizMinutes && value.defaultQuizMinutes <= value.maxQuizMinutes,
{
  message: "The default duration must be between the minimum and maximum.",
  path: ["defaultQuizMinutes"]
});

module.exports = {
  passwordSchema,
  usernameSchema,
  nameSchema,
  idSchema,
  loginSchema,
  changePasswordSchema,
  classCreateSchema,
  classUpdateSchema,
  subjectCreateSchema,
  subjectUpdateSchema,
  userCreateSchema,
  userUpdateSchema,
  questionCreateSchema,
  questionImportSchema,
  quizCreateSchema,
  quizUpdateSchema,
  adminQuizUpdateSchema,
  teacherStudentUpdateSchema,
  startAttemptSchema,
  answerSchema,
  announcementCreateSchema,
  complaintCreateSchema,
  complaintReplySchema,
  complaintStatusSchema,
  classMembersSchema,
  searchQuerySchema,
  settingsSchema
};
