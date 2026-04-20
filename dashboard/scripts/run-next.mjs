import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next", { paths: [projectRoot] });

const child = spawn(process.execPath, [nextBin, ...args], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
