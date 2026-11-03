import type { ComponentProps } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  buildComposerSubagentMentionCandidates,
  ComposerAddContextMenu,
} from "./composer-add-context-menu";
import { rankComposerContextSuggestionCandidates } from "./composer-context-suggestions";

const { activatePlugin, readAppshotTarget } = vi.hoisted(() => ({
  activatePlugin: vi.fn(),
  readAppshotTarget: vi.fn(async () => ({ available: false })),
}));
vi.mock("../../composer-context-operations", () => ({
  composerContextOperations: { activatePlugin, readAppshotTarget },
}));
vi.mock("./use-composer-page-suggestions", () => ({
  useComposerPageSuggestions: () => ({ items: [], loading: false }),
}));
vi.mock("@/lib/use-file-search", () => ({
  useFileSearch: () => ({ matches: [], loading: false }),
}));
vi.mock("@/lib/chat-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-search")>()),
  useChatSearch: () => ({ matches: [], settled: true }),
  useChatMessageSearch: () => ({ matches: [], pending: false }),
}));

type MentionRow = Parameters<typeof buildComposerSubagentMentionCandidates>[1][number];

function row(conversationId: string, overrides: Partial<MentionRow> = {}): MentionRow {
  return {
    conversationId,
    identityThreadId: conversationId,
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
      row("task-observation", { identityThreadId: null }),
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

test.each(["activation", "capabilities"] as const)(
  "Record a skill waits for plugin activation and capability refresh, and retries a failed %s",
  async (failure) => {
    activatePlugin.mockReset();
    activatePlugin.mockResolvedValue(undefined);
    if (failure === "activation") activatePlugin.mockRejectedValueOnce(new Error("Unavailable"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    if (failure === "capabilities") refresh.mockRejectedValueOnce(new Error("Refresh failed"));
    const start = vi.fn();
    const props: ComponentProps<typeof ComposerAddContextMenu> = {
      suggestion: {
        active: true,
        activation: "synthetic",
        anchorPos: null,
        dismissedMatch: null,
        kind: "at-mention",
        query: "",
        range: null,
        source: null,
        trigger: "+",
      },
      plugins: [
        {
          id: "record@official",
          name: "record-and-replay",
          displayName: "Record",
          description: null,
          defaultPrompt: "Record this workflow",
          installed: false,
          enabled: false,
          path: "plugin://record@official",
          iconUrl: null,
          iconUrlDark: null,
          brandColor: null,
        },
      ],
      skills: [],
      apps: [],
      fileSearchScope: null,
      pluginCwds: ["/repo"],
      projectId: "project",
      projectSelector: null,
      goalAvailable: false,
      planModeAvailable: false,
      planModeActive: false,
      onClose: vi.fn(),
      onDismiss: vi.fn(),
      onPickFiles: vi.fn(async () => {}),
      onActivateGoal: vi.fn(),
      onTogglePlanMode: vi.fn(),
      onCaptureAppshot: vi.fn(async () => {}),
      onProjectChange: vi.fn(),
      onPrefillPrompt: vi.fn(),
      onInsertMention: vi.fn(),
      onCompleteQuery: vi.fn(),
      onStartNewChatWithPrompt: start,
      onCapabilitiesChanged: refresh,
    };
    const view = render(<ComposerAddContextMenu {...props} />);
    try {
      await waitFor(() => expect(readAppshotTarget).toHaveBeenCalled());
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Record a skill" }));
        await Promise.resolve();
      });
      expect(start).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Record a skill" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(start).toHaveBeenCalledExactlyOnceWith({
          projectId: "project",
          prompt: "[@Record](plugin://record@official) Record this workflow",
        }),
      );
      expect(activatePlugin).toHaveBeenLastCalledWith("record@official", "local", ["/repo"]);
      expect(refresh).toHaveBeenCalledTimes(failure === "activation" ? 1 : 2);
    } finally {
      view.unmount();
    }
  },
);
