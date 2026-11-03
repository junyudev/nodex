import "../../../../globals.css";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  __getNodexToastSnapshotForTests,
  __resetNodexToastStoreForTests,
} from "@/components/ui/toast";
import { AppProviders } from "@/app-providers";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import { buildComposerActions } from "@/test/composer-actions-fixture";
import { buildComposerShellFixture } from "@/test/composer-shell-fixture";
import { TestComposerScopePath } from "@/test/maitai-scope-harness";
import { createCommandKeymapState } from "../../../../../shared/command-keybindings";
import type { PersistedAtomEvent, PersistedAtomMutation } from "../../../../../shared/ipc-api";
import type { ThreadFooterModel } from "../../thread-stage-types";
import { ThreadComposer } from "./local-conversation-thread-composer";

const originalApi = window.api;
const originalWindowType = document.documentElement.dataset.codexWindowType;

beforeEach(() => {
  clearPersistedAtomStoreForTests();
  __resetNodexToastStoreForTests();
  document.documentElement.dataset.codexWindowType = "electron";
  const values: Record<string, unknown> = {};
  const listeners = new Set<(event: PersistedAtomEvent) => void>();
  let revision = 0;
  window.api = {
    on: (channel, listener) => {
      if (channel !== "persisted-atom:updated") return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invoke: async (channel, ...args) => {
      if (channel === "persisted-atom:sync-request") return { revision, values: { ...values } };
      if (channel === "persisted-atom:update") {
        const update = args[0] as PersistedAtomMutation;
        values[update.key] = update.value;
        const event = { ...update, revision: ++revision, originRendererId: "composer-browser" };
        for (const listener of listeners) listener(event);
        return event;
      }
      if (channel === "codex-command-keymap-state") return createCommandKeymapState({}, "macOS");
      if (channel === "codex:composer-appshot:target") return { available: false, target: null };
      return null;
    },
  };
});

afterEach(() => {
  window.api = originalApi;
  if (originalWindowType === undefined) delete document.documentElement.dataset.codexWindowType;
  else document.documentElement.dataset.codexWindowType = originalWindowType;
  clearPersistedAtomStoreForTests();
  __resetNodexToastStoreForTests();
});

function composerModel(running: boolean): ThreadFooterModel {
  const fixture = buildComposerShellFixture();
  if (!fixture.conversation) throw new Error("Expected an attached Composer fixture");
  return {
    ...fixture,
    conversation: {
      ...fixture.conversation,
      turns: [],
      requests: [],
      canonicalRequests: [],
      statusType: running ? "active" : "idle",
    },
    isThreadRunning: running,
    activeTurn: running
      ? {
          threadId: fixture.conversation.threadId,
          turnId: "active-turn",
          status: "inProgress",
          itemIds: [],
          items: [],
        }
      : null,
    isQueueingEnabled: true,
    dictation: { ...fixture.dictation, isEnabled: false },
    composerShell: {
      ...fixture.composerShell,
      activeRequest: null,
      backgroundRequest: null,
      showRequestCards: false,
      backgroundAgentRows: [],
    },
    composerIntent: { prompt: "Keep this draft", focusNonce: 1 },
  };
}

test.each(["send", "queue", "steer"] as const)(
  "%s preserves typed drafts through rerenders and rejection, then clears an accepted retry",
  async (route) => {
    const model = composerModel(route !== "send");
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Try again"))
      .mockResolvedValue(undefined);
    const actions = buildComposerActions({
      onSendPrompt: route === "send" ? submit : vi.fn(),
      onEnqueueQueuedFollowUp: route === "queue" ? submit : vi.fn(),
      onSteerPrompt: route === "steer" ? submit : vi.fn(),
    });
    const tree = (noticeTitle: string | null) => (
      <AppProviders>
        <TestComposerScopePath>
          <ThreadComposer
            model={{
              ...model,
              provider: {
                kind: "codex",
                label: "Codex",
                selection: "gpt-5.4",
                commands: [],
                ...model.provider,
                notice: noticeTitle
                  ? {
                      key: "connection-status",
                      title: noticeTitle,
                      tone: "warning",
                    }
                  : null,
              },
            }}
            actions={actions}
          />
        </TestComposerScopePath>
      </AppProviders>
    );
    const view = render(tree(null));
    const editor = await view.findByLabelText("Ask for follow-up changes");
    await waitFor(() => expect(editor.textContent).toBe("Keep this draft"));
    await act(async () => {
      await userEvent.click(editor);
      await userEvent.keyboard("{End} while typing");
    });
    const draft = "Keep this draft while typing";
    await waitFor(() => expect(editor.textContent).toBe(draft));
    await act(async () => {
      view.rerender(tree("Connection status changed"));
      await Promise.resolve();
    });
    expect(view.getByLabelText("Ask for follow-up changes")).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(editor.textContent).toBe(draft);

    const pressSubmit = async () => {
      await act(async () => {
        fireEvent.keyDown(editor, { key: "Enter", metaKey: route === "steer" });
        await Promise.resolve();
      });
    };
    await pressSubmit();
    await waitFor(() =>
      expect(__getNodexToastSnapshotForTests()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "plain",
            level: "danger",
            title: "Message not sent",
            description: "Try again",
          }),
        ]),
      ),
    );
    expect(editor.textContent).toBe(draft);
    await act(async () => {
      await userEvent.click(editor);
    });
    await pressSubmit();
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    if (route === "send") expect(submit.mock.calls[1]?.[0]).toBe(draft);
    else if (route === "queue")
      expect(submit.mock.calls[1]?.slice(0, 2)).toEqual([model.threadId, draft]);
    else
      expect(submit.mock.calls[1]?.[0]).toMatchObject({
        prompt: draft,
        expectedTurnId: "active-turn",
      });
    await waitFor(() =>
      expect(view.getByLabelText("Ask for follow-up changes").textContent).toBe(""),
    );
  },
);
