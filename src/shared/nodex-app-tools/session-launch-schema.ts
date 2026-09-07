import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

export const createSessionSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(100_000),
  title: z.string().trim().min(1).max(512).optional(),
  target: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("project"),
      projectId: z.string().trim().min(1).max(512),
      environment: z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("local") }),
        z.strictObject({
          type: z.literal("worktree"),
          startingState: z
            .discriminatedUnion("type", [
              z.strictObject({ type: z.literal("working-tree") }),
              z.strictObject({
                type: z.literal("branch"),
                branchName: z.string().trim().min(1).max(512),
                onMissing: z.enum(["error", "create-branch"]).optional(),
              }),
            ])
            .optional(),
        }),
      ]),
    }),
    z.strictObject({
      type: z.literal("projectless"),
      directoryName: z.string().trim().min(1).max(128).optional(),
    }),
  ]),
  model: z.string().trim().min(1).max(256).optional(),
  operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
});

export const createSessionTool: Tool = {
  name: "create_session",
  description:
    "Create and start a Codex Session. Choose a Project environment explicitly: normally worktree for Git repositories and local for other Projects; use projectless for work without a Project. Use onMissing create-branch only when the user explicitly requested that exact new branch name; otherwise a missing branch is an error. Omit model unless the user requested one. Returns a stable sessionId and started, pending, or unconfirmed launch state. Reuse operationId with identical arguments for retries; replay never starts a second Thread. Project-scoped Turns can create only in their own Project.",
  inputSchema: z.toJSONSchema(createSessionSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
