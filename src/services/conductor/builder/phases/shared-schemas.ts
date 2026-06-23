import { z } from "zod";

export const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
});

export const interactivePromptSchema = z.object({
  question: z.string().min(1),
  options: z.array(optionSchema).min(2).max(8),
  recommendedOptionIds: z.array(z.string().min(1)).max(8).default([]),
  allowMultiple: z.boolean().default(false),
  allowOther: z.boolean().default(true),
});

export const resolveIntentInputSchema = z.object({
  outcome: z.string().min(1).describe("What the user wants the loop to achieve, in one sentence"),
  cadence: z.string().min(1).default("As needed"),
  approvalModel: z.string().min(1).default("Operator approval before external mutations"),
  runtimeInputs: z.array(z.string().min(1)).max(8).default([]),
  resolvedIntent: z.string().min(1).describe("Plain-language draft: When X happens -> do A, B, C -> output Y"),
  assumptions: z.array(z.string().min(1)).default([]).describe("Only business assumptions. Do not list apps, connectors, AI providers, classification models, or internal Tallei execution details."),
});

export const getAvailableToolsInputSchema = z.object({
  outcome: z.string().min(1).describe("Resolved loop outcome in one sentence"),
  cadence: z.string().min(1).default("As needed"),
  approvalModel: z.string().min(1).default("Operator approval before external mutations"),
  selectedToolkits: z.array(z.string().min(1)).min(1).describe("Exact Composio toolkit slugs from appSelection output"),
  capabilityQueries: z.array(z.string().min(1)).max(8).default([]),
  assumptions: z.array(z.string().min(1)).default([]).describe("Only business assumptions. Do not list apps, connectors, AI providers, classification models, or internal Tallei execution details."),
});
