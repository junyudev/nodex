import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { installWindowApi } from "@/test/browser-globals";
import { render } from "@/test/dom";
import { queryKeys } from "@/lib/query-keys";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import type { ThreadFooterModel, ThreadStageActions } from "../../../thread-stage-types";
import { buildComposerSlashCommands } from "./slash-command-registry";

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

  test("selects the exact friendly and pragmatic personality values", async () => {
    const selected: string[] = [];
    let closeCount = 0;
    const model = { ...buildModel(), selectedPersonality: "friendly" as const };
    const commands = buildComposerSlashCommands({
      model,
      actions: {
        ...buildActions(),
        onPersonalityChange: async (personality) => {
          selected.push(personality);
        },
      },
      serviceTier: null,
      setServiceTier: () => undefined,
      openExpandedDialog: () => undefined,
      onPetToggle: () => undefined,
      activateGoalMode: () => undefined,
    });
    const personality = commands.find((command) => command.id === "personality");
    if (!personality?.Content) throw new Error("Expected Personality command content.");
    const Content = personality.Content;
    const view = render(
      <Content
        close={() => {
          closeCount += 1;
        }}
        back={() => undefined}
      />,
    );

    expect(personality.description).toBe("Friendly");
    expect(view.getByText("Warm, collaborative, and helpful").textContent).toBe(
      "Warm, collaborative, and helpful",
    );
    fireEvent.click(view.getByRole("button", { name: /Pragmatic/ }));

    await waitFor(() => {
      expect(JSON.stringify(selected)).toBe(JSON.stringify(["pragmatic"]));
      expect(closeCount).toBe(1);
    });
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
});
