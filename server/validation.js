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

const userCreateSchema = z.object({
  name: nameSchema,
  username: usernameSchema,
  role: z.enum(["student", "teacher"]),
  classId: z.coerce.number().int().positive().nullable().optional()
}).superRefine((value, ctx) => {
  if (value.role === "student" && !value.classId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["classId"], message: "Select a class for the student." });
  }
});

const userUpdateSchema = z.object({
  name: nameSchema.optional(),
  active: z.boolean().optional(),
  classId: z.coerce.number().int().positive().nullable().optional()
});

const questionCreateSchema = z.object({
  questionText: z.string().trim().min(5, "Question text is too short.").max(4000, "Question text is too long."),
  subject: z.string().trim().min(2, "Subject must be at least 2 characters.").max(120, "Subject is too long.").default("General"),
  options: z.array(z.string().trim().min(1, "Options cannot be empty.").max(500, "Option is too long.")).length(4, "Four options are required."),
  correctIndex: z.coerce.number().int().min(0).max(3),
  solution: z.string().trim().min(5, "Worked solution is too short.").max(8000, "Worked solution is too long.")
});

const quizCreateSchema = z.object({
  title: z.string().trim().min(3, "Quiz title must be at least 3 characters.").max(160, "Quiz title is too long."),
  classId: z.coerce.number().int().positive("Select a class."),
  minutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute.").max(240, "Duration cannot exceed 240 minutes."),
  shuffleQuestions: z.boolean().default(false),
  questionIds: z
    .array(z.coerce.number().int().positive())
    .min(1, "Select at least one question.")
    .max(200, "A quiz cannot contain more than 200 questions.")
    .refine(ids => new Set(ids).size === ids.length, "Duplicate questions are not allowed.")
});

const quizUpdateSchema = z.object({
  isOpen: z.boolean().optional(),
  shuffleQuestions: z.boolean().optional()
}).refine(value => value.isOpen !== undefined || value.shuffleQuestions !== undefined, {
  message: "No changes were supplied."
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

const settingsSchema = z.object({
  defaultQuizMinutes: z.coerce.number().int().min(1).max(240)
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
  userCreateSchema,
  userUpdateSchema,
  questionCreateSchema,
  quizCreateSchema,
  quizUpdateSchema,
  startAttemptSchema,
  answerSchema,
  announcementCreateSchema,
  settingsSchema
};
