import { act, render, waitFor, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { expect, test, vi, describe, afterEach, beforeEach } from "vite-plus/test";
import { SubagentAvatar } from "../shared/subagent-avatar";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./composer-prompt-editor";
import "../../../../globals.css";
import { IntelligenceSelectorTrigger } from "@/components/shared/agent-runtime/intelligence-selector-trigger";
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

describe("composer subagent mention", () => {
  test("restored subagent mentions follow the same identity and document theme as Thread avatars", async () => {
    const root = document.documentElement;
    const originalTheme = root.getAttribute("data-theme");
    const originalClass = root.className;
    root.dataset.theme = "light";
    // The canonical theme attribute, rather than a separate CSS class, selects artwork.
    root.classList.add("dark");
    const value = "Ask [@Scout](agent://child-thread)";
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const onChange = vi.fn();
    const view = render(
      <>
        <SubagentAvatar seed="child-thread" data-testid="thread-avatar" />
        <ComposerPromptEditor
          ref={editorRef}
          value={value}
          placeholder="Ask"
          disabled={false}
          onChange={onChange}
          onKeyDown={() => false}
        />
      </>,
    );
    const visibleMentionImages = () =>
      [...view.container.querySelectorAll<HTMLImageElement>("[data-composer-mention] img")].filter(
        (image) => getComputedStyle(image).display !== "none",
      );
    const threadAvatar = view.getByTestId("thread-avatar") as HTMLImageElement;
    try {
      await waitFor(() => {
        expect(visibleMentionImages()).toHaveLength(1);
        expect(visibleMentionImages()[0]?.src).toBe(threadAvatar.src);
        expect(visibleMentionImages()[0]?.getBoundingClientRect().width).toBe(14);
        expect(visibleMentionImages()[0]?.getBoundingClientRect().height).toBe(14);
      });
      const lightSource = threadAvatar.src;
      await act(async () => {
        root.classList.remove("dark");
        root.dataset.theme = "dark";
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(visibleMentionImages()).toHaveLength(1);
        expect(visibleMentionImages()[0]?.src).toBe(threadAvatar.src);
        expect(threadAvatar.src).not.toBe(lightSource);
      });
      expect(editorRef.current?.getPersistedText()).toBe(value);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      if (originalTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", originalTheme);
      root.className = originalClass;
    }
  });
});

describe("IntelligenceSelectorTrigger layout", () => {
  test("fits the Composer control row without adding scrollable height", async () => {
    const view = render(
      <div className="relative h-7 w-80 overflow-y-auto" data-testid="composer-control-row">
        <IntelligenceSelectorTrigger
          modelLabel="GPT-5.6-Sol"
          reasoningLabel="Extra High"
          indicators={[]}
          title="OpenAI · GPT-5.6-Sol · Extra High"
        />
      </div>,
    );

    const trigger = await view.findByRole("button", { name: "Select model" });
    const controlRow = view.getByTestId("composer-control-row");
    expect(trigger.scrollHeight).toBeLessThanOrEqual(trigger.clientHeight);
    expect(controlRow.scrollHeight).toBe(controlRow.clientHeight);
  });

  test("draws the Fast icon inside the room reserved before the label", async () => {
    const view = render(
      <IntelligenceSelectorTrigger
        modelLabel="GPT-5.6-Sol"
        reasoningLabel="Extra High"
        indicators={["fast"]}
        title="OpenAI · GPT-5.6-Sol · Extra High"
      />,
    );

    await waitFor(() => {
      const slot = view.container.querySelector<HTMLElement>("[data-fast-mode-slot=true]");
      const label = view.container.querySelector<HTMLElement>("[data-fast-mode-indicator=true]");
      const icon = label?.querySelector<SVGSVGElement>("svg");
      if (!slot || !label || !icon) throw new Error("Expected the Fast selector geometry.");

      const slotRect = slot.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      expect(slotRect.width).toBeCloseTo(18, 1);
      expect(iconRect.left).toBeGreaterThanOrEqual(slotRect.left - 0.5);
      expect(iconRect.right).toBeLessThanOrEqual(label.getBoundingClientRect().left + 0.5);
    });
  });
});

describe("local conversation thread composer", () => {
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
});
