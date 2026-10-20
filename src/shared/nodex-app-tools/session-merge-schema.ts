import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

export const sessionMergeSchema = z.strictObject({
  sessionId: z.string().trim().min(1).max(512),
  operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
});
export const sessionMergeTool: Tool = {
  name: "merge_session_back",
  description:
    "Bring a finished fork Session's work back into the Session it was forked from. The fork's latest reply must have finished and the source must not be running one; the calling Session cannot merge itself. The source Session's next message carries the fork's work since it branched; nothing starts until a message is sent there, so send one only when continuing that Session is authorized. Returns the source sessionId. Reuse operationId with identical arguments for retries.",
  inputSchema: z.toJSONSchema(sessionMergeSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
