import { z } from "zod";
import {
  unavailableWorkbenchSubmission,
  WorkbenchSubmitPresentationSchema,
  type WorkbenchSubmitPresentation,
} from "./workbench";

const identity = z.string().min(1).max(512);

export const CodexTurnPresentationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), threadId: identity }),
  z.strictObject({ kind: z.literal("session"), sessionId: identity, launchId: identity }),
  z.strictObject({
    kind: z.literal("side_chat"),
    parentThreadId: identity,
    clientUserMessageId: identity,
  }),
]);
export type CodexTurnPresentationTarget = z.infer<typeof CodexTurnPresentationTargetSchema>;

export const CodexTurnPresentationCaptureInputSchema = z.strictObject({
  target: CodexTurnPresentationTargetSchema,
  presentation: WorkbenchSubmitPresentationSchema.catch(unavailableWorkbenchSubmission),
});
export type CodexTurnPresentationCaptureInput = {
  readonly target: CodexTurnPresentationTarget;
  readonly presentation: WorkbenchSubmitPresentation;
};
