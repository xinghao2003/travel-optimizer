import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /\.spec\.ts$/,
  timeout: 90000,
  workers: 1,
  outputDir: "../data/diagnostics/test-results",
  use: { baseURL: process.env.BASE_URL ?? "http://127.0.0.1:5173", channel: process.platform === "win32" ? "chrome" : undefined, headless: true },
});
