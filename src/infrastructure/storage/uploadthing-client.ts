import { UTApi, UTFile } from "uploadthing/server";

import { config } from "../../config/index.js";

const BLOB_PROVIDER = "uploadthing" as const;

export interface UploadThingBlobUploadResult {
  provider: typeof BLOB_PROVIDER;
  key: string;
  url: string;
}

export class UploadThingConfigError extends Error {
  override readonly name = "UploadThingConfigError";

  constructor(message: string) {
    super(message);
  }
}

let client: UTApi | null = null;

function buildClient(): UTApi {
  if (!config.uploadthingToken) {
    throw new UploadThingConfigError(
      "UploadThing is not configured. Set TALLEI_STORAGE__UPLOADTHING_TOKEN (or UPLOADTHING_TOKEN)."
    );
  }

  if (!client) {
    client = new UTApi({
      token: config.uploadthingToken,
    });
  }
  return client;
}

export function assertUploadThingConfigured(): void {
  buildClient();
}

export async function uploadBufferToUploadThing(input: {
  buffer: Buffer;
  filename: string;
  mimeType?: string | null;
}): Promise<UploadThingBlobUploadResult> {
  const utApi = buildClient();
  const normalizedFilename = input.filename.trim() || "upload.bin";
  const file = new UTFile([Uint8Array.from(input.buffer)], normalizedFilename, {
    type: input.mimeType ?? undefined,
  });

  const uploaded = await utApi.uploadFiles(file);
  const result = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  const data = result?.data as { key?: string; ufsUrl?: string; url?: string } | undefined;
  const blobUrl = data?.ufsUrl ?? data?.url;

  if (!result || result.error || !data?.key || !blobUrl) {
    const reason = result?.error?.message ?? "Unknown UploadThing upload error";
    throw new Error(`UploadThing upload failed: ${reason}`);
  }

  return {
    provider: BLOB_PROVIDER,
    key: data.key,
    url: blobUrl,
  };
}
