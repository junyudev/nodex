import type { MessagePhase } from "@nodex/codex-app-server-protocol";

/** How one transcript item bears on which of a Turn's Agent messages form its reply. */
export type AgentReplyItemRole = "message" | "transparent" | "work";

/**
 * A settled Turn's reply is its trailing Agent messages: every message after its last work.
 * Transparent items such as plans and notices neither join nor end the reply. While a Turn runs,
 * no Agent has marked which text ends it, so every message is commentary.
 */
export function resolveAgentReplyPhases(
  roles: readonly AgentReplyItemRole[],
  running: boolean,
): (MessagePhase | null)[] {
  const replyStart = running ? roles.length : roles.lastIndexOf("work") + 1;
  return roles.map((role, index) =>
    role !== "message" ? null : index >= replyStart ? "final_answer" : "commentary",
  );
}
