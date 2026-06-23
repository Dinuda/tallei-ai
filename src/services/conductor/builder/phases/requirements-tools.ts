import { z } from "zod";
import { tool } from "ai";

import { renderTypeInputSchema } from "../render-type.js";
import type { BuilderToolRun } from "./types.js";
import { getAvailableToolsInputSchema, optionSchema } from "./shared-schemas.js";

export const REQUIREMENTS_RULES = [
  "You are the Setup Coordinator for Tallei.\n\nYour job is to resolve every requirement in the build contract — including which apps/services the loop should use — and for each one, make a smart decision: does this value need to be set now, or can it be collected at runtime through a Tallei channel?\n\nTALLEI CHANNELS\nChannels are Tallei's runtime input mechanism (similar to OpenClaw channels). When an agent runs, a channel can collect dynamic values from the user — names, files, context, instructions — before or during execution. Use this instead of forcing users to hardcode information they won't know until run time.\n\nDECISION RULE — for each requirement, ask:\n  \"Will this value change between runs, come from the user, or depend on context that isn't available yet?\"\n  → YES: bind it to a Tallei channel (runtime input)\n  → NO:  resolve it now (static config)\n\nPROCESS\nWork through requirements in order:\n1. appSelection — choose the apps/services the loop needs, based on the resolved intent. Ask data-location questions here, not in Intent. Recommend 1–3 likely apps when possible, but let the user choose explicitly.\n2. getAvailableTools — after appSelection is confirmed, discover exact connector actions with the selected toolkits and one capabilityQuery per external action.\n3. connectorSetup — authenticate services. Never use interactivePrompt for connector setup. Never invent triggers that weren't surfaced by connector discovery.\n4. scheduleSetup — cadence or event trigger, as discovered.\n5. knowledgeBaseSetup — if the agent needs reference material or memory.\n6. renderType with draftTemplates then artifactSetup — if the agent produces a structured output or document.\n7. requirementSetup → resolveBuildRequirement — for all remaining typed values. Skip resolveBuildRequirement for any artifact already marked artifactPersisted: true.\n\nRULES\n- One UI tool per turn. Stop after calling it.\n- App choice is a requirement/setup decision, not intent analysis.\n- When in doubt, prefer channel (runtime) over hardcoding.\n- Clearly tell the user when something will be asked at run time and what the channel prompt will say.\n- Never invent event-driven execution unless discovered triggers explicitly support it. If a trigger wasn't confirmed by connector discovery, ask.",
];

export function requirementsAnalyzerTools(run: BuilderToolRun) {
  return {
    appSelection: tool({
      description: "Show the app catalogue for explicit app selection during requirements setup. Pass 1-3 recommendedToolkitSlugs ordered by likelihood.",
      inputSchema: z.object({
        question: z.string().min(1).default("Which apps should this loop use?"),
        recommendedToolkitSlugs: z.array(z.string().min(1)).max(8).default([]),
        allowMultiple: z.boolean().default(true),
      }),
    }),
    getAvailableTools: tool({
      description: "Discover actions from user-selected apps. Call appSelection first; pass exact selectedToolkits and focused capabilityQueries.",
      inputSchema: getAvailableToolsInputSchema,
      execute: (input) => run("getAvailableTools", input),
    }),
    resolveBuildRequirement: tool({
      description: "Resolve one pending build-contract requirement with a typed value.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
        value: z.unknown(),
      }),
      execute: (input) => run("resolveBuildRequirement", input),
    }),
    connectorSetup: tool({
      description: "Inline connector checklist for a pending connector requirement.",
      inputSchema: z.object({ requirementId: z.string().min(1) }),
    }),
    scheduleSetup: tool({
      description: "Schedule chooser for trigger_schedule (minimum hourly; allowOther for custom timing).",
      inputSchema: z.object({
        requirementId: z.string().min(1),
        question: z.string().min(1).default("How often should this loop run?"),
        subtitle: z.string().optional(),
        options: z.array(z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          description: z.string().optional(),
          trigger: z.enum(["schedule", "event"]).default("schedule"),
          cron: z.string().optional(),
          timezone: z.string().optional(),
          toolkit: z.string().optional(),
          triggerSlug: z.string().optional(),
        })).min(1).max(8).optional(),
        recommendedOptionIds: z.array(z.string().min(1)).max(8).default([]),
        allowOther: z.boolean().default(true),
      }),
    }),
    knowledgeBaseSetup: tool({
      description: "Knowledge source picker for grounding requirements.",
      inputSchema: z.object({ requirementId: z.string().min(1) }),
    }),
    renderType: tool({
      description: "Pre-fill support reply email templates before artifactSetup.",
      inputSchema: renderTypeInputSchema,
      execute: (input) => renderTypeInputSchema.parse(input),
    }),
    artifactSetup: tool({
      description: "Email artifact composer for artifact_contract. Call renderType first.",
      inputSchema: z.object({
        requirementId: z.string().min(1).default("artifact_contract"),
      }),
    }),
    requirementSetup: tool({
      description: "Structured choices for generic build requirements (stable_input, etc.).",
      inputSchema: z.object({
        requirementId: z.string().min(1),
        question: z.string().min(1),
        options: z.array(optionSchema).min(2).max(8),
        recommendedOptionIds: z.array(z.string().min(1)).max(8).default([]),
        allowMultiple: z.boolean().default(false),
        allowOther: z.boolean().default(true),
      }),
    }),
  };
}
