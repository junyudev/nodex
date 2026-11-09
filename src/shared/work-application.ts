import type { AgentSelection } from "./work-graph";
import { z } from "zod";
const identity = z.string().trim().min(1).max(512);
export const startWorkInputSchema = z.strictObject({
  operationId: identity.optional(),
  pageId: identity,
  selection: z
    .strictObject({
      instanceId: identity,
      model: identity,
      effort: z.string().trim().min(1).max(128).nullable(),
    })
    .optional(),
  again: z.boolean().optional(),
  turnEpisode: identity.optional(),
});
export interface StartWorkInput {
  readonly operationId?: string;
  readonly pageId: string;
  readonly selection?: AgentSelection;
  readonly again?: boolean;
  readonly turnEpisode?: string;
}
export interface StartWorkResult {
  readonly pageId: string;
  readonly sessionId: string;
  readonly launchId: string;
}

export const acceptWorkInputSchema = z.strictObject({
  operationId: identity,
  pageId: identity,
  turnEpisode: identity.optional(),
});
export type AcceptWorkInput = z.infer<typeof acceptWorkInputSchema>;

export const executionHoldScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("page"), page_id: identity }),
  z.strictObject({ kind: z.literal("project"), project_id: identity }),
  z.strictObject({ kind: z.literal("space") }),
]);
export type ExecutionHoldScope =
  import("@nodex/core-protocol").components["schemas"]["ExecutionHoldScope"];
export type ExecutionHold = import("@nodex/core-protocol").components["schemas"]["ExecutionHold"];
export type ExecutionHoldTarget =
  import("@nodex/core-protocol").components["schemas"]["ExecutionHoldTarget"];
export const setExecutionHoldInputSchema = z.strictObject({
  operationId: identity,
  scope: executionHoldScopeSchema,
  paused: z.boolean(),
});
export type SetExecutionHoldInput = z.infer<typeof setExecutionHoldInputSchema>;

export const sameExecutionHoldScope = (a: ExecutionHoldScope, b: ExecutionHoldScope) =>
  a.kind === b.kind &&
  (a.kind === "space" ||
    (a.kind === "page" && b.kind === "page" && a.page_id === b.page_id) ||
    (a.kind === "project" && b.kind === "project" && a.project_id === b.project_id));
