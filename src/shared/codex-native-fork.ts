import type { ThreadForkParams } from "@nodex/codex-app-server-protocol/v2";
import type { CodexComposerIntent, CodexThreadSummary, ProjectSession } from "./types";

/** Durable admission metadata; the receiving manager owns the returned native document. */
export interface CodexNativeForkPreparation {
  receiptId: string;
  hostId: string;
  generation: number;
  request: ThreadForkParams;
  sourceTitle: string | null;
}
export interface CodexNativeForkAcceptance {
  threadId: string;
  summary: CodexThreadSummary;
  session: ProjectSession;
  composerIntent: CodexComposerIntent;
}
