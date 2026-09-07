import type {
  CodexTurnPresentationTarget,
  CodexTurnPresentationTicket,
} from "../../shared/nodex-app-tools/turn-presentation";
import type { WorkbenchSubmitPresentation } from "../../shared/nodex-app-tools/workbench";
import { invokeRendererControl } from "./renderer-command";
import { captureWorkbenchSubmitPresentation } from "./workbench-agent-bridge";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";

/** Snapshot at the user action before asynchronous target or prompt preparation. */
export const readCodexSubmissionPresentation = (
  owner: WorkbenchWindowOwner,
): WorkbenchSubmitPresentation => {
  const presentation = captureWorkbenchSubmitPresentation(owner);
  if (!presentation) throw new Error("The Workbench is still connecting; submit again shortly");
  return structuredClone(presentation);
};

/** Main stamps the sender identity; a deferred submission retains its original generation. */
export const captureCodexTurnPresentation = (
  owner: WorkbenchWindowOwner,
  target: CodexTurnPresentationTarget,
  submittedPresentation?: WorkbenchSubmitPresentation,
): Promise<CodexTurnPresentationTicket> => {
  const presentation = submittedPresentation ?? readCodexSubmissionPresentation(owner);
  return invokeRendererControl("codex:turn-presentation:capture", { target, presentation });
};
