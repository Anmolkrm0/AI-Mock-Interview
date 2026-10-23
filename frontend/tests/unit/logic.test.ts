import { describe, expect, it } from "vitest";

import { highlightQuotes } from "@/lib/highlight";
import { planRecording } from "@/lib/media/recording-budget";
import { safeNextPath, setupSchema, signUpSchema, validateDocumentFile, validateJobText } from "@/lib/validation";

const MB = 1024 * 1024;

describe("form validation", () => {
  it("requires matching, reasonably strong passwords on sign-up", () => {
    const base = { name: "A", email: "a@b.co", password: "abcdefg1", confirm: "abcdefg1" };
    expect(signUpSchema.safeParse(base).success).toBe(true);
    expect(signUpSchema.safeParse({ ...base, confirm: "different1" }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...base, password: "short1", confirm: "short1" }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...base, password: "lettersonly", confirm: "lettersonly" }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
  });

  it("accepts only PDF/DOCX files under 5 MB", () => {
    const file = (name: string, size: number) => new File([new Uint8Array(size)], name);
    expect(validateDocumentFile(file("cv.pdf", 1000))).toBeNull();
    expect(validateDocumentFile(file("cv.DOCX", 1000))).toBeNull();
    expect(validateDocumentFile(file("cv.doc", 1000))).toMatch(/PDF or Word/);
    expect(validateDocumentFile(file("cv.pdf", 0))).toMatch(/empty/);
    expect(validateDocumentFile(file("cv.pdf", 6 * MB))).toMatch(/5 MB/);
  });

  it("requires a full job description", () => {
    expect(validateJobText("")).toMatch(/Paste/);
    expect(validateJobText("short")).toMatch(/at least/);
    expect(validateJobText("x".repeat(300))).toBeNull();
  });

  it("validates duration, rigor and consent", () => {
    const ok = { jobRole: "Analyst", duration: 20, rigor: "standard", recordingMode: "audio", consent: true };
    expect(setupSchema.safeParse(ok).success).toBe(true);
    for (const d of [10, 20, 30, 45]) expect(setupSchema.safeParse({ ...ok, duration: d }).success).toBe(true);
    expect(setupSchema.safeParse({ ...ok, duration: 15 }).success).toBe(false);
    expect(setupSchema.safeParse({ ...ok, rigor: "extreme" }).success).toBe(false);
    expect(setupSchema.safeParse({ ...ok, consent: false }).success).toBe(false);
    expect(setupSchema.safeParse({ ...ok, jobRole: " " }).success).toBe(false);
  });

  it("only allows same-site redirects after login", () => {
    expect(safeNextPath("/interview/setup")).toBe("/interview/setup");
    expect(safeNextPath("https://evil.example")).toBe("/dashboard");
    expect(safeNextPath("//evil.example")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });
});

describe("recording budget", () => {
  it("fits every duration within the 50 MB cap", () => {
    for (const minutes of [10, 20, 30, 45]) {
      const video = planRecording("video", minutes, 50 * MB);
      const audio = planRecording("audio", minutes, 50 * MB);
      expect(audio.fits).toBe(true);
      expect(audio.estimatedBytes).toBeLessThan(50 * MB);
      if (video.fits) expect(video.estimatedBytes).toBeLessThan(50 * MB);
    }
  });

  it("lowers video quality for long interviews", () => {
    expect(planRecording("video", 10, 50 * MB).quality).toBe("good");
    expect(["reduced", "low"]).toContain(planRecording("video", 45, 50 * MB).quality);
    expect(planRecording("video", 45, 50 * MB).videoBitsPerSecond).toBeLessThan(
      planRecording("video", 10, 50 * MB).videoBitsPerSecond,
    );
  });

  it("reports video that cannot fit a small cap", () => {
    expect(planRecording("video", 45, 20 * MB).fits).toBe(false);
    expect(planRecording("none", 45, 50 * MB).estimatedBytes).toBe(0);
  });
});

describe("evidence highlighting", () => {
  it("marks quotes case-insensitively and merges overlaps", () => {
    const segs = highlightQuotes("I added a Redis cache and p95 dropped.", [
      "added a redis cache",
      "redis cache and p95",
    ]);
    expect(segs.filter((s) => s.marked).map((s) => s.text)).toEqual(["added a Redis cache and p95"]);
    expect(segs.map((s) => s.text).join("")).toBe("I added a Redis cache and p95 dropped.");
  });

  it("leaves text untouched when a quote is absent", () => {
    expect(highlightQuotes("Plain answer.", ["not there"])).toEqual([{ text: "Plain answer.", marked: false }]);
  });
});
