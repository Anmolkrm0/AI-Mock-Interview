import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * REAL end-to-end flow. Requires a running frontend + backend wired to a
 * dedicated Supabase test project and a real Gemini key, plus a confirmed test
 * account (E2E_EMAIL / E2E_PASSWORD). Skipped otherwise.
 *
 * Microphone and camera are Chromium fakes, so answers are TYPED. This proves the
 * live session, state machine, persistence, scoring and recording replacement
 * work end to end; it does not prove speech recognition quality (check that by
 * hand, see docs/TESTING.md).
 */

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const fixtures = path.join(__dirname, "fixtures");

test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD to run end-to-end tests");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL!);
  await page.getByLabel("Password").fill(PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function runInterview(page: Page) {
  await page.goto("/interview/setup");
  await page.locator('input[type="file"]').first().setInputFiles(path.join(fixtures, "resume.docx"));
  await expect(page.getByRole("button", { name: /correct details/i }).first()).toBeVisible({ timeout: 120_000 });

  await page.getByLabel("Job description").fill(readFileSync(path.join(fixtures, "job-description.txt"), "utf8"));
  await page.getByRole("button", { name: "Read job description" }).click();
  await expect(page.getByRole("button", { name: /use a different job description/i })).toBeVisible({
    timeout: 120_000,
  });

  // Role: accept the detected default, or pick the first suggestion.
  const roleGroup = page.getByRole("group", { name: "Role" });
  await expect(roleGroup).toBeVisible();
  if (!(await roleGroup.locator("input:checked").count())) await roleGroup.locator("label").first().click();

  await page.getByText("10 minutes").click();
  await page.getByText("Standard", { exact: true }).click();
  await page.getByText("Audio only").click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Start interview" }).click();

  await expect(page).toHaveURL(/\/interview\/[^/]+\/live/, { timeout: 120_000 });
  const interviewId = page.url().split("/interview/")[1]!.split("/")[0]!;
  await page.getByText("I'm using headphones").click();
  await page.getByRole("button", { name: /join interview/i }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("timer")).toBeVisible();

  // Answer the first question by typing.
  await page.getByRole("button", { name: /type an answer/i }).click();
  await page
    .getByLabel("Your answer")
    .fill(
      "At FinPay I owned the reconciliation API. I added a Redis read-through cache and p95 latency dropped from 480 to 190 milliseconds.",
    );
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Live transcript")).toContainText("Redis read-through cache");

  // Wait for the interviewer to respond, then skip the next question.
  await page.waitForTimeout(15_000);
  await page.getByRole("button", { name: /skip question/i }).click();

  await page.getByRole("button", { name: /end interview/i }).click();
  await page.getByRole("button", { name: "End and get report" }).click();
  await expect(page).toHaveURL(new RegExp(`/interview/${interviewId}/processing`));
  await expect(page).toHaveURL(new RegExp(`/interview/${interviewId}/report`), { timeout: 4 * 60_000 });
  return interviewId;
}

test("full interview: setup, live session, report, feedback, history, recording replacement", async ({ page }) => {
  await signIn(page);
  const first = await runInterview(page);

  await expect(page.getByRole("heading", { name: "Interview report" })).toBeVisible();
  await expect(page.getByText("Answer by answer")).toBeVisible();
  await page.getByLabel(/5 out of 5/).click();
  await page.getByRole("button", { name: "Send feedback" }).click();
  await expect(page.getByRole("button", { name: "Feedback sent" })).toBeVisible();

  await page.goto("/dashboard");
  const firstRow = page.locator("tr", { has: page.locator(`a[href="/interview/${first}/report"]`) });
  await expect(firstRow).toBeVisible();
  await expect(firstRow.getByText(/latest recording/i)).toBeVisible();

  // A second recorded interview replaces the first recording but keeps its report.
  const second = await runInterview(page);
  await page.goto("/dashboard");
  await expect(
    page.locator("tr", { has: page.locator(`a[href="/interview/${second}/report"]`) }).getByText(/latest recording/i),
  ).toBeVisible();
  await expect(firstRow.getByText(/latest recording/i)).toHaveCount(0);
  await page.goto(`/interview/${first}/report`);
  await expect(page.getByRole("heading", { name: "Interview report" })).toBeVisible();
  await expect(page.getByText(/only your latest recording is kept/i))
    .toBeVisible({ timeout: 5_000 })
    .catch(async () => {
      await page.getByRole("button", { name: "Play recording" }).click();
      await expect(page.getByText(/only your latest recording is kept/i)).toBeVisible();
    });
});

test("protected pages require sign-in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
});
