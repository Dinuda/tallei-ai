import { z } from "zod";

export const conversationIdSchema = z.string().trim().min(1).max(200).optional();

export const openAiFileRefSchema = z.object({
  id: z.string().min(1, "file id is required"),
  name: z.string().optional(),
  mime_type: z.string().nullable().optional(),
  download_link: z.string().url("download_link must be a valid URL"),
});

export const uploadBlobBodySchema = z.object({
  openaiFileIdRefs: z.array(openAiFileRefSchema).min(1).max(10),
  conversation_id: conversationIdSchema,
  title: z.string().optional(),
});

export type OpenAiFileRef = z.infer<typeof openAiFileRefSchema>;
