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
import { TestComposerScopePath, TestThreadRouteScopePath } from "@/test/maitai-scope-harness";
import { createCommandKeymapState } from "../../../../../shared/command-keybindings";
import type { PersistedAtomEvent, PersistedAtomMutation } from "../../../../../shared/ipc-api";
import type { ThreadFooterModel } from "../../thread-stage-types";
import { ThreadComposer } from "./local-conversation-thread-composer";
import { LocalConversationFooter } from "../local-conversation-footer";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
} from "../local-conversation-thread-scroll-controller";
import { RightPanelComposerPresentationProvider } from "../right-panel-composer-presentation";
import {
  composerDraftIntents,
  requestComposerFocus,
  useComposerDraftIntent,
} from "@/lib/composer-draft-intents";
import {
  isComposerDictationShortcutRelease,
  isComposerDictationShortcutTargetBlocked,
} from "./use-composer-dictation";

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

  test.each(["send", "queue", "steer", "replace"] as const)(
    "%s preserves typed drafts through rerenders and rejection, then clears an accepted retry",
    async (route) => {
      const model = composerModel(route !== "send");
      if (route === "replace" && model.composerIntent) {
        model.composerIntent.queuedFollowUpEdit = { followUpId: "queued", ledgerRevision: 3 };
      }
      const submit = vi
        .fn()
        .mockRejectedValueOnce(new Error("Try again"))
        .mockResolvedValue(route === "replace" ? true : undefined);
      const actions = buildComposerActions({
        onSendPrompt: route === "send" ? submit : vi.fn(),
        onEnqueueQueuedFollowUp: route === "queue" ? submit : vi.fn(),
        onSteerPrompt: route === "steer" ? submit : vi.fn(),
        ...(route === "replace" ? { onReplaceQueuedFollowUp: submit } : {}),
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
      else if (route === "replace")
        expect(submit.mock.calls[1]?.slice(0, 4)).toEqual([model.threadId, "queued", 3, draft]);
      else
        expect(submit.mock.calls[1]?.[0]).toMatchObject({
          prompt: draft,
          expectedTurnId: "active-turn",
        });
      await waitFor(() =>
        expect(view.getByLabelText("Ask for follow-up changes").textContent).toBe(""),
      );
      expect(document.activeElement).toBe(view.getByLabelText("Ask for follow-up changes"));
      await act(async () => {
        await userEvent.keyboard("Next");
      });
      expect(view.getByLabelText("Ask for follow-up changes").textContent).toBe("Next");
    },
  );

  test("waits for a visible composer and gives a newer request priority at the same timestamp", async () => {
    const chat = { kind: "session", sessionId: "delayed-focus-browser" } as const;
    const model = composerModel(false);
    const actions = buildComposerActions();
    function Surface({ shown, dialog }: { shown: boolean; dialog?: boolean }) {
      const intent = useComposerDraftIntent(chat);
      return (
        <>
          <RightPanelComposerPresentationProvider visible={shown}>
            <div inert={!shown}>
              <ThreadComposer
                model={{ ...model, composerChatKey: chat, composerIntent: intent }}
                actions={actions}
              />
            </div>
          </RightPanelComposerPresentationProvider>
          {dialog ? <div role="dialog" aria-label="Confirmation" /> : null}
        </>
      );
    }
    const tree = (shown: boolean, dialog = false) => (
      <AppProviders>
        <TestComposerScopePath>
          <Surface shown={shown} dialog={dialog} />
        </TestComposerScopePath>
      </AppProviders>
    );
    const view = render(tree(false));
    const first = { prompt: "Earlier", focusNonce: 100 };
    const latest = { prompt: "Latest", focusNonce: 100 };
    await act(async () => {
      composerDraftIntents.set(chat, first);
    });
    const editor = await view.findByLabelText("Do anything");
    expect(document.activeElement).not.toBe(editor);
    expect(composerDraftIntents.read(chat)).toBe(first);
    await act(async () => {
      composerDraftIntents.set(chat, latest);
      view.rerender(tree(true, true));
    });
    expect(editor.textContent).toBe("Latest");
    expect(composerDraftIntents.read(chat)).toBe(latest);
    await act(async () => {
      view.rerender(tree(true));
    });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(composerDraftIntents.read(chat)).toBeNull();
  });

  test("discards delayed focus after the person types in a different field", async () => {
    const chat = { kind: "session", sessionId: "abandoned-focus-browser" } as const;
    const model = composerModel(false);
    const actions = buildComposerActions();
    function Surface({ shown }: { shown: boolean }) {
      const intent = useComposerDraftIntent(chat);
      return (
        <>
          <input aria-label="Other field" />
          <RightPanelComposerPresentationProvider visible={shown}>
            <div inert={!shown}>
              <ThreadComposer
                model={{ ...model, composerChatKey: chat, composerIntent: intent }}
                actions={actions}
              />
            </div>
          </RightPanelComposerPresentationProvider>
        </>
      );
    }
    const tree = (shown: boolean) => (
      <AppProviders>
        <TestComposerScopePath>
          <Surface shown={shown} />
        </TestComposerScopePath>
      </AppProviders>
    );
    const view = render(tree(false));
    await act(async () => {
      requestComposerFocus(chat);
      await userEvent.click(view.getByLabelText("Other field"));
      await userEvent.keyboard("My edit");
    });
    await act(async () => {
      view.rerender(tree(true));
    });
    await waitFor(() => expect(composerDraftIntents.read(chat)).toBeNull());
    expect(document.activeElement).toBe(view.getByLabelText("Other field"));
  });

  test("preserves the caret across dock changes and releases an idle docked composer into the Conversation", async () => {
    const chat = { kind: "session", sessionId: "dock-focus-browser" } as const;
    const model = composerModel(false);
    const actions = buildComposerActions();
    const target = document.createElement("div");
    target.style.height = "360px";
    document.body.append(target);
    function Surface({ floating }: { floating: boolean }) {
      const intent = useComposerDraftIntent(chat);
      return (
        <LocalConversationThreadScrollLayout
          footer={
            <LocalConversationFooter
              model={{ ...model, composerChatKey: chat, composerIntent: intent }}
              actions={actions}
              rightPanelComposerOverlay={{ enabled: floating, target }}
            />
          }
        >
          <p>Previous message</p>
        </LocalConversationThreadScrollLayout>
      );
    }
    const tree = (floating: boolean) => (
      <AppProviders>
        <TestThreadRouteScopePath>
          <EnsureLocalConversationThreadScrollController>
            <Surface floating={floating} />
          </EnsureLocalConversationThreadScrollController>
        </TestThreadRouteScopePath>
      </AppProviders>
    );
    const view = render(tree(false));
    try {
      const docked = await view.findByLabelText("Ask for follow-up changes");
      await act(async () => {
        await userEvent.click(docked);
        await userEvent.keyboard("ab{ArrowLeft}");
      });
      await act(async () => {
        view.rerender(tree(true));
      });
      const overlay = await view.findByLabelText("Do anything");
      await waitFor(() => expect(document.activeElement).toBe(overlay));
      await act(async () => {
        await userEvent.keyboard("X");
        view.rerender(tree(false));
      });
      const restored = await view.findByLabelText("Ask for follow-up changes");
      await waitFor(() => expect(document.activeElement).toBe(restored));
      expect(restored.textContent).toBe("aXb");
      await act(async () => {
        await userEvent.keyboard("{Escape}");
      });
      expect(document.activeElement).toBe(restored);
      await act(async () => {
        await userEvent.keyboard("{ArrowRight}{Backspace}{Backspace}{Backspace}");
      });
      await waitFor(() => expect(restored.textContent).toBe(""));
      await act(async () => {
        await userEvent.keyboard("{Escape}");
      });
      expect(document.activeElement).toBe(view.getByRole("region", { name: "Conversation" }));
    } finally {
      view.unmount();
      target.remove();
    }
  });

  test("dictation hold ends on either release and belongs only to the eligible composer", async () => {
    const down = new KeyboardEvent("keydown", { key: "m", code: "KeyM", ctrlKey: true });
    const keyUp = new KeyboardEvent("keyup", { key: "m", code: "KeyM", ctrlKey: true });
    const modifierUp = new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft" });
    const unrelatedUp = new KeyboardEvent("keyup", { key: "a", code: "KeyA", ctrlKey: true });
    expect(isComposerDictationShortcutRelease(down, keyUp)).toBe(true);
    expect(isComposerDictationShortcutRelease(down, modifierUp)).toBe(true);
    expect(isComposerDictationShortcutRelease(down, unrelatedUp)).toBe(false);

    const view = render(
      <AppProviders>
        <input aria-label="Page editor" />
        <button data-codex-terminal="">Terminal</button>
        <TestComposerScopePath>
          <ThreadComposer model={composerModel(false)} actions={buildComposerActions()} />
        </TestComposerScopePath>
      </AppProviders>,
    );
    const editor = await view.findByLabelText("Ask for follow-up changes");
    const outside = view.getByLabelText("Page editor");
    const terminal = view.getByRole("button", { name: "Terminal" });
    await act(async () => {
      editor.focus();
    });
    expect(isComposerDictationShortcutTargetBlocked(editor, editor)).toBe(false);
    await act(async () => outside.focus());
    expect(isComposerDictationShortcutTargetBlocked(outside, editor)).toBe(true);
    await act(async () => terminal.focus());
    expect(isComposerDictationShortcutTargetBlocked(terminal, editor)).toBe(true);
    await act(async () => terminal.blur());
    expect(isComposerDictationShortcutTargetBlocked(document.body, editor)).toBe(false);
  });
});
