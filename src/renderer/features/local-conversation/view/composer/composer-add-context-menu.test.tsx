import { describe, expect, test } from "vite-plus/test";
import { buildComposerSubagentMentionCandidates } from "./composer-add-context-menu";
import { rankComposerContextSuggestionCandidates } from "./composer-context-suggestions";

type MentionRow = Parameters<typeof buildComposerSubagentMentionCandidates>[1][number];

function row(conversationId: string, overrides: Partial<MentionRow> = {}): MentionRow {
  return {
    conversationId,
    parentConversationId: "root",
    canInteract: true,
    displayName: "Scout",
    agentRole: "explorer",
    ...overrides,
  };
}

describe("subagent mention provider", () => {
  test("offers only named interactive immediate children in directory order", () => {
    const rows = [
      row("older-child", { displayName: " @ Scout " }),
      row("readonly-child", { canInteract: false }),
      row("grandchild", { parentConversationId: "older-child" }),
      row("other-root", { parentConversationId: "other" }),
      row("unnamed", { displayName: "  " }),
      row("bare-at", { displayName: " @ " }),
      row("newer-child", { displayName: "Reviewer" }),
    ];
    const candidates = buildComposerSubagentMentionCandidates("root", rows);
    expect(candidates.map((candidate) => candidate.value)).toEqual([
      {
        kind: "agent",
        name: "scout",
        displayName: "Scout",
        conversationId: "older-child",
        path: "agent://older-child",
      },
      {
        kind: "agent",
        name: "reviewer",
        displayName: "Reviewer",
        conversationId: "newer-child",
        path: "agent://newer-child",
      },
    ]);
    expect(buildComposerSubagentMentionCandidates(null, rows)).toEqual([]);
    expect(
      buildComposerSubagentMentionCandidates("older-child", rows).map((candidate) => candidate.id),
    ).toEqual(["agent:grandchild"]);
  });

  test("offers candidates for an empty at query and filters by display name or role", () => {
    const candidates = buildComposerSubagentMentionCandidates("root", [
      row("scout"),
      row("reviewer", { displayName: "Reviewer", agentRole: "auditor" }),
    ]);
    const search = (query: string) =>
      rankComposerContextSuggestionCandidates({ candidates, query }).map(
        (candidate) => candidate.id,
      );
    expect(search("")).toEqual(["agent:scout", "agent:reviewer"]);
    expect(search("SCOUT")).toEqual(["agent:scout"]);
    expect(search("auditor")).toEqual(["agent:reviewer"]);
    expect(search("missing")).toEqual([]);
  });
});
