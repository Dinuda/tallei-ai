import { z } from "zod";

import { inputSurfaceSchema, inputRequirementWhenSchema } from "./input-surfaces.js";

const operatorCommandSchema = z.enum([
  "submit_input",
  "approve",
  "revise",
  "reject",
  "verify_connection",
]);

type OperatorCommand = z.infer<typeof operatorCommandSchema>;

const operatorInteractionKindSchema = z.enum([
  "collect_input",
  "review_artifact",
  "confirm_action",
  "connect_connector",
]);

export type OperatorInteractionKind = z.infer<typeof operatorInteractionKindSchema>;

export const operatorInteractionCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("submit_input"), values: z.record(z.unknown()) }),
  z.object({ command: z.literal("approve"), value: z.record(z.unknown()).default({}) }),
  z.object({ command: z.literal("revise"), value: z.record(z.unknown()).default({}) }),
  z.object({ command: z.literal("reject"), value: z.record(z.unknown()).default({}) }),
  z.object({ command: z.literal("verify_connection"), value: z.record(z.unknown()).default({}) }),
]);

type OperatorInteractionCommand = z.infer<typeof operatorInteractionCommandSchema>;

const operatorActionSchema = z.object({
  id: z.string().min(1),
  command: operatorCommandSchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  disabledReason: z.string().min(1).optional(),
});

export type OperatorAction = z.infer<typeof operatorActionSchema>;

const collectInputPlanSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("collect_input"),
  requiredValueKey: z.string().min(1),
  consumingNodeId: z.string().min(1),
  surface: inputSurfaceSchema,
  timing: inputRequirementWhenSchema,
  valueType: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
  label: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
});

const reviewArtifactPlanSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("review_artifact"),
  producerNodeId: z.string().min(1),
  artifactId: z.string().min(1),
  rendererRef: z.string().min(1).nullable(),
  editable: z.boolean(),
  allowedCommands: z.array(z.enum(["approve", "revise", "reject"])).min(1),
});

const confirmActionPlanSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("confirm_action"),
  actionNodeId: z.string().min(1),
  contractRef: z.string().min(1),
  effect: z.enum(["write_external", "irreversible_external", "uncertain"]),
  approvalRequired: z.literal(true),
});

const connectConnectorPlanSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("connect_connector"),
  actionNodeId: z.string().min(1),
  contractRef: z.string().min(1),
});

const operatorInteractionPlanItemSchema = z.discriminatedUnion("kind", [
  collectInputPlanSchema,
  reviewArtifactPlanSchema,
  confirmActionPlanSchema,
  connectConnectorPlanSchema,
]);

export type OperatorInteractionPlanItem = z.infer<typeof operatorInteractionPlanItemSchema>;

export const operatorInteractionPlanSchema = z.object({
  version: z.literal("v1"),
  interactions: z.array(operatorInteractionPlanItemSchema),
});

export type OperatorInteractionPlan = z.infer<typeof operatorInteractionPlanSchema>;

export const activeOperatorInteractionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("collect_input"),
    interactionIds: z.array(z.string().min(1)).min(1),
    items: z.array(collectInputPlanSchema.extend({
      satisfied: z.boolean(),
      validationError: z.string().min(1).optional(),
    })).min(1),
  }),
  z.object({
    kind: z.literal("review_artifact"),
    interactionId: z.string().min(1),
    artifactId: z.string().min(1),
    rendererRef: z.string().min(1).nullable(),
    editable: z.boolean(),
    producerNodeId: z.string().min(1),
    outputText: z.string(),
  }),
  z.object({
    kind: z.literal("confirm_action"),
    interactionId: z.string().min(1),
    actionNodeId: z.string().min(1),
    contractRef: z.string().min(1),
    effect: z.enum(["write_external", "irreversible_external", "uncertain"]),
    sanitizedPayload: z.record(z.unknown()),
    payloadHash: z.string().min(1),
    validation: z.object({
      valid: z.boolean(),
      errors: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  }),
  z.object({
    kind: z.literal("connect_connector"),
    interactionId: z.string().min(1),
    actionNodeId: z.string().min(1),
    contractRef: z.string().min(1),
    toolkit: z.string().min(1),
    actionSlug: z.string().min(1),
    connected: z.boolean(),
  }),
]);

export type ActiveOperatorInteraction = z.infer<typeof activeOperatorInteractionSchema>;

export function findOperatorInteraction<TKind extends OperatorInteractionPlanItem["kind"]>(
  plan: OperatorInteractionPlan | undefined,
  kind: TKind,
  predicate: (item: Extract<OperatorInteractionPlanItem, { kind: TKind }>) => boolean,
): Extract<OperatorInteractionPlanItem, { kind: TKind }> | undefined {
  return plan?.interactions.find((item): item is Extract<OperatorInteractionPlanItem, { kind: TKind }> =>
    item.kind === kind && predicate(item as Extract<OperatorInteractionPlanItem, { kind: TKind }>));
}
