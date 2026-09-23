import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Unset by default: Playwright resolves its own managed Chromium (`playwright
// install chromium`), which is what CI and a normal dev machine do. Some
// sandboxes pre-install a Chromium build under a fixed path instead of
// letting Playwright manage the download; set this env var to point at it
// there rather than hardcoding a path that would be meaningless elsewhere.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

/**
 * Chromium-only e2e config (#11): drives SculptSDK's Playwright adapter
 * against the local static fixtures in packages/fixtures. No external
 * network access, no decision provider — the fixtures server binds to
 * localhost only.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {}
      }
    }
  ],
  webServer: {
    command: "node packages/fixtures/server.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
    timeout: 30_000
  }
});
