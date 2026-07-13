#!/usr/bin/env node
import { readdir, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const sourceRoot = join(repoRoot, "docs", "flows", "diagrams");
const outputRoot = join(repoRoot, "docs", "flows", "rendered");
const mermaidPackage = process.env.MERMAID_CLI_PACKAGE ?? "@mermaid-js/mermaid-cli";
async function walk(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mmd")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function ensureRenderableBinary() {
  try {
    await access(join(repoRoot, "node_modules"));
  } catch {
    // We can still try npx even if node_modules is absent.
  }
}

function renderFile(inputPath, outputPath) {
  const result = spawnSync(
    "npx",
    ["-y", mermaidPackage, "-i", inputPath, "-o", outputPath, "-b", "transparent"],
    {
      stdio: "inherit",
      cwd: repoRoot,
      env: {
        ...process.env,
        PUPPETEER_SKIP_DOWNLOAD: process.env.PUPPETEER_SKIP_DOWNLOAD ?? "1",
      },
    }
  );
  if (result.status !== 0) {
    throw new Error(`Failed to render ${inputPath} -> ${outputPath}`);
  }
}

async function main() {
  await ensureRenderableBinary();
  const files = await walk(sourceRoot);
  if (files.length === 0) {
    console.log(`[docs:render] No Mermaid sources found under ${relative(repoRoot, sourceRoot)}`);
    return;
  }

  await mkdir(outputRoot, { recursive: true });
  for (const inputPath of files) {
    const relativePath = relative(sourceRoot, inputPath);
    const outputPath = join(outputRoot, relativePath).replace(/\.mmd$/, ".svg");
    await mkdir(dirname(outputPath), { recursive: true });
    console.log(`[docs:render] Rendering ${basename(inputPath)} -> ${relative(repoRoot, outputPath)}`);
    renderFile(inputPath, outputPath);
  }
}

main().catch((error) => {
  console.error("[docs:render] Failed:", error);
  process.exit(1);
});
