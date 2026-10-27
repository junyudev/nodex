import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "@/test/browser-globals";
import { render } from "@/test/dom";
import { queryKeys } from "@/lib/query-keys";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import type { ThreadFooterModel, ThreadStageActions } from "../../../thread-stage-types";
import { buildComposerSlashCommands } from "./slash-command-registry";
import { ExpandedSlashCommandDialog } from "./expanded-slash-command-dialog";

function buildModel(): ThreadFooterModel {
  return {
    threadId: "thread_1",
    isNewThreadTab: false,
    isCloudNewThreadTarget: false,
    newThreadTarget: null,
    conversation: {
      threadId: "thread_1",
      statusType: "idle",
      source: null,
    },
    body: {
      latestTurnId: "turn_1",
    },
    collaborationModes: [
      { mode: "default", label: "Default" },
      { mode: "plan", label: "Plan" },
    ],
    selectedCollaborationMode: "default",
    composerPlugins: [],
    isThreadRunning: false,
  } as unknown as ThreadFooterModel;
}

function buildNewThreadModel(overrides: Partial<ThreadFooterModel> = {}): ThreadFooterModel {
  return {
    ...buildModel(),
    threadId: null,
    isNewThreadTab: true,
    isCloudNewThreadTarget: false,
    newThreadTarget: {
      projectId: "project_1",
      projectName: "Nodex",
      sessionId: "session_1",
      runInTarget: "localProject",
    },
    conversation: null,
    body: {
      latestTurnId: null,
    },
    ...overrides,
  } as unknown as ThreadFooterModel;
}

function buildActions(): ThreadStageActions {
  return {
    onGetThreadGoal: async () => null,
    onSetThreadGoal: async () => null,
    onClearThreadGoal: async () => undefined,
    onCollaborationModeChange: () => undefined,
  } as unknown as ThreadStageActions;
}

describe("buildComposerSlashCommands", () => {
  test.each(["claude", "opencode"] as const)(
    "hides unavailable app commands and preserves native commands without replacing %s app actions",
    async (kind) => {
      const onOpenSideChat = vi.fn(async () => undefined);
      const onSendPrompt = vi.fn(async () => undefined);
      const commands = buildComposerSlashCommands({
        model: {
          ...buildModel(),
          provider: {
            kind,
            label: kind,
            selection: `${kind}:work`,
            options: [],
            select: () => {},
            commands: [
              { name: "side", description: "Native side command", inputHint: null },
              { name: "scan", description: "Scan this workspace", inputHint: null },
            ],
            error: null,
          },
        },
        actions: { ...buildActions(), onOpenSideChat, onSendPrompt },
        serviceTier: null,
        setServiceTier: () => undefined,
        openExpandedDialog: () => undefined,
        onPetToggle: () => undefined,
        activateGoalMode: () => undefined,
      });
      const view = render(
        <ExpandedSlashCommandDialog
          commands={commands}
          composerText=""
          onSelect={(command) => void command.onSelect?.({ source: "dialog" })}
          onClose={() => {}}
        />,
      );

      expect(view.queryByRole("button", { name: /^Compact\b/u })).toBeNull();
      expect(view.queryByRole("button", { name: /^Merge back\b/u })).toBeNull();
      expect(commands.filter((command) => command.id === "side")).toHaveLength(1);
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: /^Side\b/u }));
        await Promise.resolve();
      });
      expect(onOpenSideChat).toHaveBeenCalledOnce();
      expect(onSendPrompt).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: /^scan\b/u }));
        await Promise.resolve();
      });
      expect(onSendPrompt).toHaveBeenCalledExactlyOnceWith("/scan");
    },
  );

  test.each(["claude", "opencode"] as const)(
    "keeps supported common conversation commands actionable for %s",
    async (kind) => {
      const onCompactThread = vi.fn(async () => undefined);
      const onMergeForkBack = vi.fn(async () => undefined);
      const onOpenSideChat = vi.fn(async () => undefined);
      const onSendPrompt = vi.fn(async () => undefined);
      const commands = buildComposerSlashCommands({
        model: {
          ...buildModel(),
          provider: {
            kind,
            label: kind,
            selection: `${kind}:work`,
            options: [],
            select: () => {},
            commands: [],
            error: null,
          },
        },
        actions: {
          ...buildActions(),
          onCompactThread,
          onMergeForkBack,
          onOpenSideChat,
          onSendPrompt,
        },
        serviceTier: null,
        setServiceTier: () => undefined,
        openExpandedDialog: () => undefined,
        onPetToggle: () => undefined,
        activateGoalMode: () => undefined,
      });
      const view = render(
        <ExpandedSlashCommandDialog
          commands={commands}
          composerText=""
          onSelect={(command) => void command.onSelect?.({ source: "dialog" })}
          onClose={() => {}}
        />,
      );

      for (const label of [/^Compact\b/u, /^Merge back\b/u, /^Side\b/u]) {
        const command = view.getByRole("button", { name: label });
        expect(command.hasAttribute("disabled")).toBe(false);
        await act(async () => {
          fireEvent.click(command);
          await Promise.resolve();
        });
      }
      expect(onCompactThread).toHaveBeenCalledExactlyOnceWith("thread_1");
      expect(onMergeForkBack).toHaveBeenCalledOnce();
      expect(onOpenSideChat).toHaveBeenCalledOnce();
      expect(onSendPrompt).not.toHaveBeenCalled();
    },
  );

  test.each(["claude", "opencode"] as const)(
    "offers a selectable /fork menu for %s without requiring a loaded latest Turn",
    async (kind) => {
      const onForkThread = vi.fn(async (_target: "local" | "newWorktree") => undefined);
      const onSendPrompt = vi.fn(async () => undefined);
      const actions = { ...buildActions(), onForkThread, onSendPrompt };
      const commands = buildComposerSlashCommands({
        model: {
          ...buildModel(),
          body: { ...buildModel().body, latestTurnId: null },
          provider: {
            kind,
            label: kind,
            selection: `${kind}:work`,
            options: [],
            select: () => {},
            commands: [],
            error: null,
          },
        },
        actions,
        serviceTier: null,
        setServiceTier: () => undefined,
        openExpandedDialog: () => undefined,
        onPetToggle: () => undefined,
        activateGoalMode: () => undefined,
      });
      const close = vi.fn();
      const view = render(
        <ExpandedSlashCommandDialog
          commands={commands}
          composerText=""
          onSelect={(command) => void command.onSelect?.({ source: "dialog" })}
          onClose={close}
        />,
      );

      await act(async () => {
        fireEvent.change(view.getByRole("textbox", { name: "Search" }), {
          target: { value: "fork" },
        });
        await Promise.resolve();
      });
      const fork = view.getByRole("button", { name: /^Fork\b/u });
      expect(fork.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        fireEvent.click(fork);
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: /^Fork chat/u }));
        await Promise.resolve();
      });
      await waitFor(() => expect(onForkThread).toHaveBeenCalledExactlyOnceWith("local"));
      expect(close).toHaveBeenCalledOnce();
      expect(onSendPrompt).not.toHaveBeenCalled();
    },
  );

  test("routes native status and MCP commands to the live runtime inspector", async () => {
    const onOpenStatusPanel = vi.fn();
    const onSendPrompt = vi.fn();
    const model = buildModel();
    model.provider = {
      kind: "claude",
      label: "Claude",
      selection: "claude:work",
      options: [],
      select: () => {},
      commands: [{ name: "mcp", description: "Native command", inputHint: null }],
      error: null,
      diagnostics: async () => ({
        health: { status: "ready", executable: null, version: null, account: null, error: null },
        mcpServers: [],
        agents: [],
        capabilities: [],
      }),
    };
    const commands = buildComposerSlashCommands({
      model,
      actions: { ...buildActions(), onOpenStatusPanel, onSendPrompt },
      serviceTier: null,
      setServiceTier: () => {},
      openExpandedDialog: () => {},
      onPetToggle: () => {},
      activateGoalMode: () => {},
    });
    for (const name of ["status", "mcp"]) {
      const matching = commands.filter((command) => command.id === name);
      expect(matching).toHaveLength(1);
      expect(matching[0]?.Content).toBeUndefined();
      await matching[0]?.onSelect?.({ source: "dialog" });
    }
    expect(onOpenStatusPanel).toHaveBeenCalledTimes(2);
    expect(onOpenStatusPanel).toHaveBeenLastCalledWith("thread_1");
    expect(onSendPrompt).not.toHaveBeenCalled();
  });
  test("delegates Pet visibility to the native avatar overlay owner", async () => {
    let toggles = 0;
    const commands = buildComposerSlashCommands({
      model: buildModel(),
      actions: buildActions(),
      serviceTier: null,
      setServiceTier: () => undefined,
      openExpandedDialog: () => undefined,
      onPetToggle: () => {
        toggles += 1;
      },
      activateGoalMode: () => undefined,
    });
    const pet = commands.find((command) => command.id === "pet");
    if (!pet?.onSelect) throw new Error("Expected selectable Pet command");

    await pet.onSelect({ source: "dialog" });

    expect(toggles).toBe(1);
  });

  test("offers Merge back only in a fork and only once its reply has finished", async () => {
    const onMergeForkBack = vi.fn(async () => undefined);
    const build = (actions: ThreadStageActions, isThreadRunning = false) =>
      buildComposerSlashCommands({
        model: { ...buildModel(), isThreadRunning },
        actions,
        serviceTier: null,
        setServiceTier: () => undefined,
        openExpandedDialog: () => undefined,
        onPetToggle: () => undefined,
        activateGoalMode: () => undefined,
      }).find((command) => command.id === "merge");
    expect(build(buildActions())?.isVisible).toBe(false);
    const fork = { ...buildActions(), onMergeForkBack };
    expect(build(fork, true)?.isEnabled).toBe(false);
    const merge = build(fork);
    expect(merge?.isVisible).toBe(true);
    expect(merge?.isEnabled).toBe(true);
    await merge?.onSelect?.({ source: "dialog" });
    expect(onMergeForkBack).toHaveBeenCalledOnce();
  });

  test("clears the context in place of an Agent's own /clear once its reply has finished", async () => {
    const onClearContext = vi.fn(async () => undefined);
    const onSendPrompt = vi.fn(async () => undefined);
    const build = (actions: ThreadStageActions, isThreadRunning = false) =>
      buildComposerSlashCommands({
        model: {
          ...buildModel(),
          isThreadRunning,
          provider: {
            kind: "claude",
            label: "Claude",
            selection: "claude:work",
            options: [],
            select: () => {},
            commands: [
              { name: "clear", description: "Clear conversation history", inputHint: null },
            ],
            error: null,
          },
        } as unknown as ThreadFooterModel,
        actions,
        serviceTier: null,
        setServiceTier: () => undefined,
        openExpandedDialog: () => undefined,
        onPetToggle: () => undefined,
        activateGoalMode: () => undefined,
      }).filter((command) => command.id === "clear");
    const runtime = { ...buildActions(), onClearContext, onSendPrompt };
    expect(build(runtime, true)).toMatchObject([{ title: "Clear context", isEnabled: false }]);
    const [clear] = build(runtime);
    expect(clear).toMatchObject({ title: "Clear context", isVisible: true, isEnabled: true });
    await clear?.onSelect?.({ source: "dialog" });
    expect(onClearContext).toHaveBeenCalledOnce();
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  test("keeps the Composer focused when a nested panel row is pressed so its click runs", async () => {
    const onForkFromTurn = vi.fn(async () => undefined);
    const fork = buildComposerSlashCommands({
      model: buildModel(),
      actions: { ...buildActions(), onForkFromTurn },
      serviceTier: null,
      setServiceTier: () => undefined,
      openExpandedDialog: () => undefined,
      onPetToggle: () => undefined,
      activateGoalMode: () => undefined,
    }).find((command) => command.id === "fork");
    const close = vi.fn();
    const view = render(<>{fork?.Content?.({ close, back: () => undefined })}</>);
    const row = view.getByRole("button", { name: /Fork chat/u });
    // A prevented mousedown keeps focus in the Composer, which would otherwise close the menu.
    await act(async () => {
      expect(fireEvent.mouseDown(row)).toBe(false);
      fireEvent.click(row);
      await Promise.resolve();
    });
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(onForkFromTurn).toHaveBeenCalledWith({
      threadId: "thread_1",
      turnId: "turn_1",
      message: "",
    });
  });

  test("keeps capabilities in the context provider instead of duplicating plugin slash commands", () => {
    const commands = buildComposerSlashCommands({
      model: {
        ...buildModel(),
        composerPlugins: [
          {
            id: "browser@openai-bundled",
            name: "Browser",
            displayName: "Browser",
            description: "Control the in-app browser",
            defaultPrompt: null,
            installed: true,
            enabled: true,
            path: "plugin://browser@openai-bundled",
            iconUrl: null,
            iconUrlDark: null,
            brandColor: null,
          },
        ],
      },
      actions: buildActions(),
      serviceTier: null,
      setServiceTier: () => undefined,
      openExpandedDialog: () => undefined,
      onPetToggle: () => undefined,
      activateGoalMode: () => undefined,
    });

    expect(commands.some((command) => command.id.startsWith("plugin:"))).toBe(false);
  });

  test("renders MCP server rows from the paginated status response", async () => {
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel === "codex:mcp-server-statuses:list") {
          return {
            data: [
              {
                name: "docs",
                serverInfo: null,
                tools: {},
                resources: [],
                resourceTemplates: [],
                runtimeStatus: "connected",
                authStatus: "oAuth",
              },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: () => () => {},
    });
    const commands = buildComposerSlashCommands({
      model: buildModel(),
      actions: buildActions(),
      serviceTier: null,
      setServiceTier: () => undefined,
      openExpandedDialog: () => undefined,
      onPetToggle: () => undefined,
      activateGoalMode: () => undefined,
    });
    const mcpCommand = commands.find((command) => command.id === "mcp");
    if (!mcpCommand?.Content) {
      throw new Error("Expected MCP slash command content.");
    }
    const Content = mcpCommand.Content;
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.mcp.statuses(), {
      data: [
        {
          name: "docs",
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          runtimeStatus: "connected",
          authStatus: "oAuth",
        },
      ],
      nextCursor: null,
    });
    const view = render(
      <TestQueryProvider client={client}>
        <Content close={() => undefined} back={() => undefined} />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByText("docs").textContent).toBe("docs");
    });
    expect(view.getByText("OAuth connected").textContent).toBe("OAuth connected");
  });

  test("models Goal as a direct goal-mode command instead of a nested editor", async () => {
    let goalModeActivations = 0;
    let clearedInlineTrigger = false;
    const commands = buildComposerSlashCommands({
      model: buildModel(),
      actions: buildActions(),
      serviceTier: null,
      setServiceTier: () => undefined,
      openExpandedDialog: () => undefined,
      onPetToggle: () => undefined,
      activateGoalMode: () => {
        goalModeActivations += 1;
      },
    });
    const goalCommand = commands.find((command) => command.id === "goal");
    if (!goalCommand) {
      throw new Error("Expected Goal slash command.");
    }
    if (!goalCommand.onSelect || !goalCommand.onSelectFromInlineSlash) {
      throw new Error("Expected Goal slash command selection handlers.");
    }

    expect(Boolean(goalCommand.Content)).toBe(false);
    expect(goalCommand.isVisible).toBe(true);
    expect(goalCommand.requiresEmptyComposer).toBe(false);
    expect(goalCommand.triggers).toBeUndefined();

    await goalCommand.onSelect({ source: "dialog" });
    await goalCommand.onSelectFromInlineSlash({
      source: "inline",
      trigger: {
        active: true,
        trigger: "/",
        query: "goal",
        from: 0,
        to: 5,
      },
      clearTrigger: () => {
        clearedInlineTrigger = true;
      },
      replaceTrigger: () => undefined,
    });

    expect(goalModeActivations).toBe(2);
    expect(clearedInlineTrigger).toBe(true);
  });

  test("shows Goal in new-chat when a session thread can be started", async () => {
    let goalModeActivations = 0;
    const actions = {
      onStartThreadForSession: async () => undefined,
      onCollaborationModeChange: () => undefined,
    } as unknown as ThreadStageActions;
    const commands = buildComposerSlashCommands({
      model: buildNewThreadModel(),
      actions,
      serviceTier: null,
      setServiceTier: () => undefined,
      openExpandedDialog: () => undefined,
      onPetToggle: () => undefined,
      activateGoalMode: () => {
        goalModeActivations += 1;
      },
    });
    const goalCommand = commands.find((command) => command.id === "goal");
    if (!goalCommand?.onSelect) {
      throw new Error("Expected selectable Goal slash command.");
    }

    expect(goalCommand.isVisible).toBe(true);

    await goalCommand.onSelect({ source: "dialog" });

    expect(goalModeActivations).toBe(1);
  });

  test("hides Goal in new-chat when the start target cannot carry a goal draft", () => {
    const commands = buildComposerSlashCommands({
      model: buildNewThreadModel({ isCloudNewThreadTarget: true }),
      actions: {
        onStartThreadForSession: async () => undefined,
        onCollaborationModeChange: () => undefined,
      } as unknown as ThreadStageActions,
      serviceTier: null,
      setServiceTier: () => undefined,
      openExpandedDialog: () => undefined,
      onPetToggle: () => undefined,
      activateGoalMode: () => undefined,
    });
    const goalCommand = commands.find((command) => command.id === "goal");
    if (!goalCommand) {
      throw new Error("Expected Goal slash command.");
    }

    expect(goalCommand.isVisible).toBe(false);
  });

  test("a Runtime conversation hides Goal and changes its own speed for Fast", async () => {
    const onIntelligenceSelectionChange = vi.fn(async () => undefined);
    const setServiceTier = vi.fn();
    const provider = {
      kind: "codex",
      label: "Codex",
      serviceTier: null,
      controls: { goals: false },
      commands: [],
    } as unknown as NonNullable<ThreadFooterModel["provider"]>;
    const commands = buildComposerSlashCommands({
      model: buildNewThreadModel({
        provider,
        selectedModel: "gpt",
        selectedReasoningEffort: "high",
        availableModels: [],
      }),
      actions: {
        onStartThreadForSession: async () => undefined,
        onIntelligenceSelectionChange,
        onCollaborationModeChange: () => undefined,
      } as unknown as ThreadStageActions,
      serviceTier: "fast",
      setServiceTier,
      openExpandedDialog: () => undefined,
      onPetToggle: () => undefined,
      activateGoalMode: () => undefined,
    });
    expect(commands.find((command) => command.id === "goal")?.isVisible).toBe(false);
    await commands.find((command) => command.id === "fast")!.onSelect!({
      source: "dialog",
    });
    expect(onIntelligenceSelectionChange).toHaveBeenCalledWith({
      kind: "codex",
      model: "gpt",
      reasoningEffort: "high",
      serviceTier: "fast",
    });
    expect(setServiceTier).not.toHaveBeenCalled();
  });

  test("a Claude chat toggles Fast and Ultracode on its own model choice", async () => {
    const change = vi.fn(async () => undefined);
    const build = (capabilities: Record<string, unknown>, selected: Record<string, unknown>) =>
      buildComposerSlashCommands({
        model: {
          ...buildModel(),
          provider: {
            kind: "claude",
            label: "Claude",
            selection: "claude",
            options: [],
            select: () => {},
            commands: [{ name: "fast", description: "Native fast", inputHint: null }],
            nativeIntelligence: { selected, capabilities, change },
          },
        } as unknown as ThreadFooterModel,
        actions: buildActions(),
        serviceTier: null,
        setServiceTier: vi.fn(),
        openExpandedDialog: () => undefined,
        onPetToggle: () => undefined,
        activateGoalMode: () => undefined,
      });
    const commands = build({ fastMode: true, ultracode: true }, { fast: false, ultracode: true });
    expect(commands.filter((command) => command.title === "Fast")).toHaveLength(1);
    await commands.find((command) => command.id === "fast")!.onSelect!({ source: "dialog" });
    expect(change).toHaveBeenLastCalledWith({ fast: true });
    const ultracode = commands.find((command) => command.id === "ultracode")!;
    expect(ultracode.description).toBe("Turn Ultracode off");
    await ultracode.onSelect!({ source: "dialog" });
    expect(change).toHaveBeenLastCalledWith({ ultracode: false });

    const unavailable = build(
      { ultracodeUnavailableReason: "Dynamic workflows are off." },
      { ultracode: true },
    ).find((command) => command.id === "ultracode")!;
    expect(unavailable).toMatchObject({
      isVisible: true,
      isEnabled: false,
      description: "Dynamic workflows are off.",
    });
    expect(build({}, {}).find((command) => command.id === "ultracode")?.isVisible).toBe(false);
  });
});
