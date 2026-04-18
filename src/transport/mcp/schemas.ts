import { z } from "zod";

export const PlatformSchema = z.enum(["claude", "chatgpt", "gemini", "other"]);
