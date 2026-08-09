import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "rendererAccessibility.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5181",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npm run test:a11y:server",
      url: "http://127.0.0.1:3015/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
    {
      command: "npm run test:a11y:renderer",
      url: "http://127.0.0.1:5181",
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
