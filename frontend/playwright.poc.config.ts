import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /(?:browser-prototype|native-solver)\.spec\.ts/,
  timeout: 90000,
  workers: 1,
  outputDir: "../data/diagnostics/browser-poc/test-results",
  use: { baseURL: process.env.POC_BASE_URL ?? "http://127.0.0.1:5174", channel: process.platform === "win32" ? "chrome" : undefined, headless: true },
});
