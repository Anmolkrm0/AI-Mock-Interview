import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a REAL stack (frontend + backend + a dedicated
 * Supabase test project + real Gemini). They are opt-in because they spend AI
 * quota. The browser uses Chromium's fake microphone/camera; answers are typed,
 * so the run does not depend on speech.
 *
 *   E2E_BASE_URL=http://localhost:3000 E2E_EMAIL=... E2E_PASSWORD=... npm run test:e2e
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 8 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    permissions: ["microphone", "camera"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
