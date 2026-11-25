import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { composerDraftIntents } from "@/lib/composer-draft-intents";
import { useWorkbenchSessionCommands } from "@/lib/use-workbench-session-commands";
import type { WorkbenchSessionPresentation } from "@/lib/workbench-session-presentation";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import { deferred } from "./agent-instance-settings.test-fixtures";
import { makeSessionSceneFixture } from "./workbench-testkit/session-scene-fixture";
import { makeAttachedSession, makeSession } from "./workbench-testkit/workbench-shell-fixtures";

vi.mock("@/lib/use-agent-runtime-session-launch", () => ({
  useAgentRuntimeSessionLaunch: () => async () => {
    throw new Error("A draft must not start a Run");
  },
}));

type CommandInput = Parameters<typeof useWorkbenchSessionCommands>[0];
type CatalogPorts = Pick<CommandInput["catalog"], "readCurrent" | "ensureDefaultDraft">;

beforeEach(() => {
  installWindowApi({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderCommands(catalog: CatalogPorts) {
  const source = makeAttachedSession({ id: "source", threadId: "source-root", tabs: [] });
  let selectedSession = source.id;
  const input = {
    activeSession: source,
    knownSessions: [source],
    catalog,
    controller: { pendingProcessOutputOpen: null, durable: { patchPanel: () => {} } },
    lifecycle: {},
    panelOpeners: {},
    selectSession(session: Parameters<CommandInput["selectSession"]>[0]) {
      selectedSession = session.id;
    },
    setSettingsPath: () => {},
    setAutomationsPath: () => {},
  };
  // These commands use the Catalog, selection, draft view, and route state ports.
  const { result } = renderHook(
    () => useWorkbenchSessionCommands(input as unknown as CommandInput),
    {
      wrapper: TestQueryProvider,
    },
  );
  return { commands: result.current, selectedSession: () => selectedSession };
}

function draftPresentation(id: string): WorkbenchSessionPresentation {
  const draft = makeSession({ id, projectId: "alpha", tabs: [] });
  return { domain: draft, scene: makeSessionSceneFixture(draft) };
}

test("a Thread from another Session cannot take over the selected chat", async () => {
  const source = makeAttachedSession({ id: "source", threadId: "source-root", tabs: [] });
  vi.spyOn(agentRuntimeRuntime, "inspect").mockResolvedValueOnce({
    rootThreadId: "other-root",
  } as Awaited<ReturnType<typeof agentRuntimeRuntime.inspect>>);
  const { commands, selectedSession } = renderCommands({
    readCurrent: async () => source,
    ensureDefaultDraft: async () => {
      throw new Error("Opening a Thread must not allocate a draft");
    },
  });

  await act(async () => {
    await expect(
      commands.openAttachedThreadSession?.("other-root", { runtimeSessionId: source.id }),
    ).rejects.toThrow("Conversation identity changed");
  });
  expect(selectedSession()).toBe(source.id);
});

test("a task suggestion opens the owning Project's draft with its authored prompt", async () => {
  const draft = draftPresentation("new-draft");
  const { commands, selectedSession } = renderCommands({
    readCurrent: async () => null,
    ensureDefaultDraft: async (projectId) => {
      expect(projectId).toBe("alpha");
      return draft;
    },
  });
  const chat = { kind: "session", sessionId: draft.domain.id } as const;
  try {
    await act(async () => {
      await commands.startNewChatWithPrompt({ projectId: "alpha", prompt: "Review the changes" });
    });
    expect(selectedSession()).toBe(draft.domain.id);
    expect(composerDraftIntents.read(chat)?.prompt).toBe("Review the changes");
  } finally {
    const intent = composerDraftIntents.read(chat);
    if (intent) composerDraftIntents.consume(chat, intent.focusNonce);
  }
});

test("a suggestion that retires during draft allocation leaves selection and authored text alone", async () => {
  const draft = draftPresentation("allocated-draft");
  const receipt = deferred<WorkbenchSessionPresentation>();
  const ensureDefaultDraft = vi.fn(() => receipt.promise);
  const { commands, selectedSession } = renderCommands({
    readCurrent: async () => null,
    ensureDefaultDraft,
  });
  const chat = { kind: "session", sessionId: draft.domain.id } as const;
  const existing = { prompt: "My draft", focusNonce: 1 };
  composerDraftIntents.set(chat, existing);
  let current = true;
  try {
    await act(async () => {
      const pending = commands.startNewChatWithPrompt({
        projectId: "alpha",
        prompt: "Discarded suggestion",
        isSourceCurrent: () => current,
      });
      expect(ensureDefaultDraft).toHaveBeenCalledOnce();
      current = false;
      receipt.resolve(draft);
      await pending;
    });
    expect(selectedSession()).toBe("source");
    expect(composerDraftIntents.read(chat)).toBe(existing);
  } finally {
    const intent = composerDraftIntents.read(chat);
    if (intent) composerDraftIntents.consume(chat, intent.focusNonce);
  }
});
