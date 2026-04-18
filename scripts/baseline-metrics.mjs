import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execSync } from "node:child_process";

const repoRoot = process.cwd();
const srcDir = path.join(repoRoot, "src");

function walk(dirPath, collector) {
  for (const entry of readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, collector);
      continue;
    }
    collector(fullPath);
  }
}

const tsFiles = [];
walk(srcDir, (filePath) => {
  if (filePath.endsWith(".ts")) tsFiles.push(filePath);
});

const totalSourceLines = tsFiles.reduce((sum, filePath) => {
  const lineCount = readFileSync(filePath, "utf8").split(/\r?\n/).length;
  return sum + lineCount;
}, 0);

const memoryServicePath = path.join(srcDir, "services", "memory.ts");
const memoryServiceLineCount = readFileSync(memoryServicePath, "utf8").split(/\r?\n/).length;

const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const dependencyCount = Object.keys(packageJson.dependencies ?? {}).length;

const typecheckStart = performance.now();
execSync("npm run build -- --noEmit", { stdio: "pipe" });
const typecheckMs = Math.round(performance.now() - typecheckStart);

const payload = {
  generatedAt: new Date().toISOString(),
  metrics: {
    sourceTypeScriptFileCount: tsFiles.length,
    sourceTypeScriptLineCount: totalSourceLines,
    dependencyCount,
    memoryServiceLineCount,
    typecheckNoEmitWallTimeMs: typecheckMs,
  },
};

console.log(JSON.stringify(payload, null, 2));
