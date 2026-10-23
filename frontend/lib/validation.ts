import { z } from "zod";

export const signInSchema = z.object({
  email: z.string().trim().min(1, "Enter your email").email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

export const signUpSchema = z
  .object({
    name: z.string().trim().min(1, "Enter your name").max(80, "Use 80 characters or fewer"),
    email: z.string().trim().min(1, "Enter your email").email("Enter a valid email address"),
    password: z
      .string()
      .min(8, "Use at least 8 characters")
      .regex(/[A-Za-z]/, "Include at least one letter")
      .regex(/[0-9]/, "Include at least one number"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

export type SignInValues = z.infer<typeof signInSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_DOCS = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export function validateDocumentFile(file: File): string | null {
  const name = file.name.toLowerCase();
  const ext = Object.keys(ACCEPTED_DOCS).find((e) => name.endsWith(e));
  if (!ext) return "Upload a PDF or Word (.docx) file.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "This file is larger than 5 MB. Upload a smaller file.";
  return null;
}

export const MIN_JD_CHARS = 200;
export const MAX_JD_CHARS = 30_000;

export function validateJobText(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "Paste the job description or upload it as a file.";
  if (t.length < MIN_JD_CHARS) return `Paste the full job description (at least ${MIN_JD_CHARS} characters).`;
  if (t.length > MAX_JD_CHARS) return "That's longer than 30,000 characters. Trim it to the role description.";
  return null;
}

export const setupSchema = z.object({
  jobRole: z.string().trim().min(2, "Choose or enter a job role").max(200),
  duration: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(45)]),
  rigor: z.enum(["standard", "target_bar", "stress_test"]),
  recordingMode: z.enum(["video", "audio", "none"]),
  consent: z.literal(true, { error: "Confirm you understand how the interview works" }),
});

export type SetupValues = z.infer<typeof setupSchema>;

/** Only allow same-site relative redirects after login. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/dashboard";
  return next;
}
