import { useLayoutEffect, useState } from "react";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "streamdown/styles.css";
import { renderWithMaitai } from "@/test/thread-maitai";
import { installWindowApi } from "@/test/browser-globals";
import { buildComposerShellFixture } from "@/test/composer-shell-fixture";
import { buildComposerActions } from "@/test/composer-actions-fixture";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import { LocalConversationComposerShell } from "./composer/local-conversation-composer-shell";
import {
  COMPOSER_PROMPT_DRAFTS_STORAGE_KEY,
  deserializeComposerPromptDraft,
} from "./composer/composer-draft-state";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import type { ThreadStageActions } from "../thread-stage-types";
import type { CodexComposerIntent } from "../../../../shared/types";
import { fixture } from "./conversation-markdown-targets.test-fixtures";

describe("task suggestion Composer handoff", () => {
  test("replaces the actual draft and focuses its editor without starting a turn", async () => {
    clearPersistedAtomStoreForTests();
    const persisted = new Map<string, unknown>();
    let revision = 0;
    const listeners = new Set<(value: unknown) => void>();
    const base = buildComposerShellFixture();
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === "persisted-atom:sync-request")
        return { revision, values: Object.fromEntries(persisted) };
      if (channel === "persisted-atom:update") {
        const update = args[0] as { key: string; value: unknown; mutationId: string };
        persisted.set(update.key, update.value);
        const event = { ...update, revision: ++revision, originRendererId: "task-test" };
        for (const listener of listeners) listener(event);
        return event;
      }
      if (channel === "branch-metadata")
        return { currentBranch: "main", defaultBranch: "main", branches: ["main"] };
      throw new Error(`Unsupported Task fixture request: ${channel}`);
    });
    installWindowApi({
      invoke,
      on: (channel: string, listener: (value: unknown) => void) => {
        if (channel !== "persisted-atom:updated") return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    const send = vi.fn(async () => {});
    const actions = buildComposerActions({
      onSendPrompt: send,
      onEnqueueQueuedFollowUp: send,
      onSteerPrompt: send,
    });
    const handoffs: Parameters<NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>>[0][] =
      [];
    const native: { current: ReturnType<typeof fixture> | null } = { current: null };
    function Workflow() {
      const [intent, setIntent] = useState<CodexComposerIntent | null>(null);
      const [, rerender] = useState(0);
      const [message] = useState(() =>
        fixture(
          '::task-stub[Raw **prompt**]{title="Try it"}\n\n::task-stub{title="Empty"}',
          "local",
          "inline",
          {
            projectId: "source-project",
            onStartNewChatWithPrompt: async (input) => {
              if (input.isSourceCurrent?.() === false) return;
              handoffs.push(input);
              setIntent((previous) => ({
                prompt: input.prompt,
                clearText: input.prompt === "",
                focusNonce: (previous?.focusNonce ?? 0) + 1,
              }));
            },
          },
        ),
      );
      useLayoutEffect(() => {
        native.current = message;
      }, [message]);
      return (
        <>
          {message.rows([])}
          <button onClick={() => rerender((current) => current + 1)}>Other action</button>
          <LocalConversationComposerShell
            model={{
              ...base,
              projectId: "source-project",
              threadId: null,
              conversation: null,
              activeTurn: null,
              isThreadRunning: false,
              isNewThreadTab: true,
              composerScopeIdentity: "task-draft",
              newThreadTarget: {
                projectId: "source-project",
                projectName: "Source",
                sessionId: "draft",
              },
              newThreadComposerIntent: intent,
              composerShell: {
                ...base.composerShell,
                activeRequest: null,
                backgroundRequest: null,
                queuedFollowUpRows: [],
                pendingSteerRows: [],
                backgroundAgentRows: [],
                showComposer: true,
                showRequestCards: false,
              },
            }}
            actions={actions}
            errorMessage={null}
            onErrorMessage={(error) => {
              if (error) throw new Error(error);
            }}
          />
        </>
      );
    }
    const view = renderWithMaitai(<Workflow />, { wrapper: LocalConversationTestQueryProvider });
    try {
      await act(async () => {
        native.current?.connect();
        await Promise.resolve();
      });
      const [use, empty] = await view.findAllByRole("button", { name: "Use suggestion" });
      const editor = await waitFor(() => {
        const value = view.container.querySelector<HTMLElement>(
          '[data-codex-composer="true"][contenteditable="true"]',
        );
        if (!value) throw new Error("Composer is not hydrated");
        return value;
      });
      await act(async () => {
        await userEvent.click(use!);
        await Promise.resolve();
      });
      await waitFor(() => expect(editor.textContent).toBe("Raw **prompt**"));
      expect(handoffs[0]?.projectId).toBe("source-project");
      await waitFor(() => expect(document.activeElement).toBe(editor));
      expect(
        window.getSelection()?.anchorNode && editor.contains(window.getSelection()!.anchorNode),
      ).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(
        invoke.mock.calls.filter(([channel]) =>
          /(?:turn:start|turn:steer|queue.*enqueue|thread:start)/.test(channel),
        ),
      ).toEqual([]);
      const draft = persisted.get(COMPOSER_PROMPT_DRAFTS_STORAGE_KEY);
      if (!draft || typeof draft !== "object") throw new Error("Missing persistent draft");
      expect(
        Object.values(draft).flatMap((value) =>
          typeof value === "string" ? [deserializeComposerPromptDraft(value).text] : [],
        ),
      ).toContain("Raw **prompt**");
      const other = view.getByRole("button", { name: "Other action" });
      await act(async () => {
        await userEvent.click(other);
        await Promise.resolve();
      });
      expect(document.activeElement).toBe(other);
      expect(
        view.container.querySelector('[data-codex-composer="true"][contenteditable="true"]'),
      ).toBe(editor);
      await act(async () => {
        await userEvent.click(empty!);
        await Promise.resolve();
      });
      await waitFor(() => expect(editor.textContent).toBe(""));
      await waitFor(() => expect(document.activeElement).toBe(editor));
      expect(handoffs[1]?.prompt).toBe("");
      await waitFor(() => expect(persisted.get(COMPOSER_PROMPT_DRAFTS_STORAGE_KEY)).toEqual({}));
      expect(send).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      native.current?.dispose();
      clearPersistedAtomStoreForTests();
    }
  });
});
