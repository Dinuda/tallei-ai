const { defineConfig } = require("@playwright/test");
const { config: loadDotenv } = require("dotenv");
const path = require("path");

const dashboardRoot = __dirname;
const repoRoot = path.resolve(dashboardRoot, "..");

loadDotenv({ path: path.join(repoRoot, ".env") });
loadDotenv({ path: path.join(dashboardRoot, ".env.local"), override: true });

process.env.TALLEI_DB__URL = process.env.TALLEI_DB__URL ?? process.env.DATABASE_URL ?? "";
process.env.TALLEI_HTTP__INTERNAL_API_SECRET = process.env.TALLEI_HTTP__INTERNAL_API_SECRET ?? process.env.INTERNAL_API_SECRET ?? "";
process.env.TALLEI_AUTH__JWT_SECRET = process.env.TALLEI_AUTH__JWT_SECRET ?? process.env.JWT_SECRET ?? "";
process.env.TALLEI_DB__AUTO_MIGRATE_ON_BOOT = "true";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3001";
const backendURL = process.env.BACKEND_URL ?? "http://127.0.0.1:3000";

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  webServer: [
    {
      command: "npm run dev",
      cwd: repoRoot,
      url: `${backendURL}/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev",
      cwd: dashboardRoot,
      url: `${baseURL}/login`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
