import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";

import { config } from "../../config/index.js";

const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

export function sanitizeImportFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "upload.bin";
  const cleaned = base.replace(/[^\w.\-()+ ]+/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "upload.bin";
}

export function getImportStorageRoot(): string {
  const configured = config.importStorageDir.trim();
  return configured.length > 0 ? configured : join(os.tmpdir(), "tallei-imports");
}

export function userImportDir(userId: string): string {
  return join(getImportStorageRoot(), sanitizePathSegment(userId));
}

export async function ensureUserImportDir(userId: string): Promise<string> {
  const dir = userImportDir(userId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function buildStorageRef(userId: string, originalFilename: string): string {
  const id = randomUUID().replace(/-/g, "");
  const safeName = sanitizeImportFilename(originalFilename);
  return join(sanitizePathSegment(userId), `${id}_${safeName}`);
}

export function resolveStoragePath(storageRef: string): string {
  const normalized = storageRef.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.startsWith("/")) {
    throw new Error("Invalid import storage reference.");
  }
  return join(getImportStorageRoot(), normalized);
}

export async function persistUploadedImportFile(
  userId: string,
  tempPath: string,
  originalFilename: string
): Promise<{ storageRef: string; absolutePath: string }> {
  await ensureUserImportDir(userId);
  const storageRef = buildStorageRef(userId, originalFilename);
  const absolutePath = resolveStoragePath(storageRef);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  const { rename } = await import("node:fs/promises");
  await rename(tempPath, absolutePath);
  return { storageRef, absolutePath };
}

export async function deleteImportArtifact(storageRef: string | null | undefined): Promise<void> {
  if (!storageRef) return;
  try {
    const absolutePath = resolveStoragePath(storageRef);
    await unlink(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      console.warn("[chatgpt-import-storage] failed to delete artifact:", storageRef, error);
    }
  }
}

export async function sweepOrphanedImportArtifacts(
  maxAgeMs: number = DEFAULT_ORPHAN_TTL_MS
): Promise<number> {
  const root = getImportStorageRoot();
  const cutoff = Date.now() - Math.max(60_000, maxAgeMs);
  let removed = 0;

  async function walk(dir: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (info.mtimeMs < cutoff) {
        try {
          await unlink(fullPath);
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
  }

  await walk(root);
  return removed;
}

export async function copyStreamToImportFile(
  userId: string,
  sourceStream: NodeJS.ReadableStream,
  originalFilename: string
): Promise<{ storageRef: string; absolutePath: string }> {
  await ensureUserImportDir(userId);
  const storageRef = buildStorageRef(userId, originalFilename);
  const absolutePath = resolveStoragePath(storageRef);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await pipeline(sourceStream, createWriteStream(absolutePath));
  return { storageRef, absolutePath };
}

export function openImportArtifactStream(storageRef: string): NodeJS.ReadableStream {
  const absolutePath = resolveStoragePath(storageRef);
  return createReadStream(absolutePath);
}
