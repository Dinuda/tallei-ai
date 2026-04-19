import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { config } from "../../config/index.js";

interface CipherEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  kmsKeyId: string;
  iv: string;
  tag: string;
  data: string;
}

function resolveMasterKey(): Buffer {
  const raw = config.memoryMasterKey;

  if (!raw) {
    throw new Error("MEMORY_MASTER_KEY is required. Generate one with: openssl rand -hex 32");
  }

  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  const base64 = raw.startsWith("base64:") ? raw.slice("base64:".length) : raw;
  const decoded = Buffer.from(base64, "base64");
  if (decoded.length === 32) return decoded;

  throw new Error("MEMORY_MASTER_KEY must be a 32-byte key encoded as hex or base64");
}

export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function encryptMemoryContent(plaintext: string): string {
  const key = resolveMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: CipherEnvelope = {
    v: 1,
    alg: "aes-256-gcm",
    kmsKeyId: config.kmsKeyId,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };

  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export function decryptMemoryContent(ciphertext: string): string {
  const key = resolveMasterKey();
  const raw = Buffer.from(ciphertext, "base64").toString("utf8");
  const envelope = JSON.parse(raw) as CipherEnvelope;

  if (envelope.v !== 1 || envelope.alg !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted memory envelope format");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
