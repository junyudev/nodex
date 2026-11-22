import { describe, expect, test, vi } from "vite-plus/test";
import type { AgentIntelligenceModelChoice } from "@/components/shared/agent-runtime/use-agent-intelligence-menu";
import type { CodexComposerSkill } from "@/lib/types";
import { buildComposerActions } from "@/test/composer-actions-fixture";
import { render } from "@/test/dom";
import type {
  ConversationProviderPresentation,
  ThreadFooterModel,
  ThreadStageActions,
} from "../../../thread-stage-types";
import { createTestIntelligenceMenu } from "../composer-intelligence.test-support";
import { filterComposerSlashCommands, filterComposerSlashSubmenu } from "./slash-command-filter";
import { buildComposerSlashCommands } from "./slash-command-registry";
import type { ComposerSlashCommand } from "./slash-command-types";

function buildModel(overrides: Partial<ThreadFooterModel> = {}): ThreadFooterModel {
  return {
    threadId: "thread_1",
    isNewThreadTab: false,
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
      { mode: "default", name: "Default", model: null },
      { mode: "plan", name: "Plan", model: null },
    ],
    selectedCollaborationMode: "default",
    composerPlugins: [],
    isThreadRunning: false,
    ...overrides,
  } as ThreadFooterModel;
}

function buildNewThreadModel(overrides: Partial<ThreadFooterModel> = {}): ThreadFooterModel {
  return buildModel({
    threadId: null,
    isNewThreadTab: true,
    newThreadTarget: {
      projectId: "project_1",
      projectName: "Nodex",
      sessionId: "session_1",
      runInTarget: "localProject",
    },
    conversation: null,
    body: { ...buildModel().body, latestTurnId: null },
    ...overrides,
  });
}

function buildActions(overrides: Partial<ThreadStageActions> = {}): ThreadStageActions {
  return buildComposerActions({
    onCompactThread: undefined,
    onUploadFeedback: undefined,
    ...overrides,
  });
}

function buildCommands(overrides: Partial<Parameters<typeof buildComposerSlashCommands>[0]> = {}) {
  return buildComposerSlashCommands({
    model: buildModel(),
    actions: buildActions(),
    intelligence: createTestIntelligenceMenu(),
    onPetToggle: () => {},
    activateGoalMode: () => {},
    openFeedback: () => {},
    mcp: { statuses: undefined, loading: false, error: null },
    ...overrides,
  });
}

function providerCommand(
  name: string,
  overrides: Partial<ConversationProviderPresentation["commands"][number]> = {},
): ConversationProviderPresentation["commands"][number] {
  return { name, description: "Native command", inputHint: null, aliases: [], ...overrides };
}

function getCommand(commands: readonly ComposerSlashCommand[], id: string): ComposerSlashCommand {
  const command = commands.find((entry) => entry.id === id);
  if (!command) throw new Error(`Expected slash command ${id}.`);
  return command;
}

async function runCommand(command: ComposerSlashCommand) {
  if (command.action.kind !== "run") throw new Error(`Expected ${command.id} to run directly.`);
  await command.action.run();
}

function getSubmenu(commands: readonly ComposerSlashCommand[], id: string) {
  const { action } = getCommand(commands, id);
  if (action.kind !== "submenu") throw new Error(`Expected a submenu for ${id}.`);
  return action.submenu;
}

describe("buildComposerSlashCommands", () => {
  test("offers each invocable skill once and replaces the query with its chip", () => {
    const insertMention = vi.fn();
    const skill = (
      name: string,
      overrides: Partial<CodexComposerSkill> = {},
    ): CodexComposerSkill => ({
      name,
      displayName: name,
      description: `${name} description`,
      iconUrl: null,
      brandColor: null,
      path: `/repo/.agents/skills/${name}/SKILL.md`,
      scope: "repo",
      ...overrides,
    });
    const commands = buildCommands({
      model: buildModel({
        provider: {
          kind: "claude",
          label: "Claude",
          selection: "claude:work",
          commands: [
            providerCommand("Review"),
            providerCommand("review-pr", { aliases: ["REVIEW"] }),
          ],
        },
      }),
      skills: {
        inventory: [
          skill("review", { displayName: "Review PR", pluginId: "github@openai-curated" }),
          skill("review", { displayName: "Shadowed copy" }),
          skill("deploy", { userInvocable: false }),
        ],
        roots: ["/repo/"],
        plugins: [],
      },
    });

    expect(commands.filter((command) => command.section?.kind === "agent")).toEqual([]);
    const skillCommands = commands.filter((command) => command.section?.kind === "skills");
    expect(skillCommands.map((command) => command.title)).toEqual(["Review PR"]);
    const review = getCommand(skillCommands, "skill:/repo/.agents/skills/review/SKILL.md");
    const view = render(<>{review.trailing}</>);
    expect(view.getByText("repo")).toBeDefined();
    expect(view.getByText("From GitHub")).toBeDefined();
    if (review.action.kind !== "insert") throw new Error("Expected Review PR to insert a skill.");
    review.action.insert({ insertMention, insertText: vi.fn() });
    expect(insertMention).toHaveBeenCalledExactlyOnceWith({
      kind: "skill",
      name: "review",
      displayName: "Review PR",
      path: "/repo/.agents/skills/review/SKILL.md",
      description: "review description",
      iconUrl: null,
      brandColor: null,
    });
  });

  test.each(["claude", "opencode"] as const)(
    "keeps the Nodex Side action when %s offers its own side command",
    async (kind) => {
      const onOpenSideChat = vi.fn(async () => undefined);
      const commands = buildCommands({
        model: buildModel({
          provider: {
            kind,
            label: kind,
            selection: `${kind}:work`,
            commands: [providerCommand("side")],
          },
        }),
        actions: buildActions({ onOpenSideChat }),
      });

      expect(getCommand(commands, "compact").isVisible).toBe(false);
      expect(getCommand(commands, "merge").isVisible).toBe(false);
      expect(commands.some((command) => command.id === "agent:side")).toBe(false);
      const side = getCommand(commands, "side");
      expect(side.isVisible).toBe(true);
      await runCommand(side);
      expect(onOpenSideChat).toHaveBeenCalledOnce();
    },
  );

  test.each(["claude", "opencode"] as const)(
    "keeps supported common conversation commands actionable for %s",
    async (kind) => {
      const onCompactThread = vi.fn(async () => undefined);
      const onMergeForkBack = vi.fn(async () => undefined);
      const commands = buildCommands({
        model: buildModel({
          provider: { kind, label: kind, selection: `${kind}:work`, commands: [] },
        }),
        actions: buildActions({ onCompactThread, onMergeForkBack }),
      });

      for (const id of ["compact", "merge"]) {
        const command = getCommand(commands, id);
        expect(command).toMatchObject({ isVisible: true, isEnabled: true });
        await runCommand(command);
      }
      expect(onCompactThread).toHaveBeenCalledExactlyOnceWith("thread_1");
      expect(onMergeForkBack).toHaveBeenCalledOnce();
    },
  );

  test.each([
    {
      kind: "codex",
      label: "Codex",
      names: ["Compact", "goal", "feedback"],
      hidden: ["compact", "goal", "feedback"],
    },
    {
      kind: "claude",
      label: "Claude",
      names: ["usage", "CONTEXT", "cost", "effort"],
      hidden: ["status", "reasoning"],
    },
  ] as const)(
    "supersedes $label commands by name or alias even when the corresponding Nodex command is hidden",
    ({ kind, label, names, hidden }) => {
      const commands = buildCommands({
        model: buildNewThreadModel({
          provider: {
            kind,
            label,
            selection: kind,
            controls: { goals: false },
            commands: [
              ...names.map((name) => providerCommand(name)),
              providerCommand("wipe", { aliases: ["RESET"] }),
            ],
          },
        }),
        actions: buildActions({ onStartThreadForSession: async () => undefined }),
      });

      for (const id of [...hidden, "clear"]) {
        expect(getCommand(commands, id).isVisible).toBe(false);
      }
      expect(commands.filter((command) => command.section?.kind === "agent")).toEqual([]);
    },
  );

  test("finds an Agent command by alias and inserts its canonical name with room for arguments", () => {
    const commands = buildCommands({
      model: buildModel({
        provider: {
          kind: "claude",
          label: "Claude",
          selection: "claude:work",
          commands: [providerCommand("scan", { aliases: ["audit"], inputHint: "[directory]" })],
        },
      }),
    });
    const matches = filterComposerSlashCommands({
      commands,
      query: "audit",
      composerText: "/audit",
    });
    expect(matches.map(({ command }) => command.id)).toEqual(["agent:scan"]);

    const scan = getCommand(commands, "agent:scan");
    expect(scan.section).toEqual({ kind: "agent", label: "Claude" });
    const view = render(<>{scan.trailing}</>);
    expect(view.getByText("[directory]")).toBeDefined();

    if (scan.action.kind !== "insert") throw new Error("Expected scan to insert the command.");
    const insertText = vi.fn();
    scan.action.insert({ insertMention: vi.fn(), insertText });
    expect(insertText).toHaveBeenCalledExactlyOnceWith("/scan ");
  });

  test.each(["claude", "opencode"] as const)(
    "forks %s directly with one destination and no loaded latest Turn",
    async (kind) => {
      const onForkThread = vi.fn(async () => undefined);
      const commands = buildCommands({
        model: buildModel({
          body: { ...buildModel().body, latestTurnId: null },
          provider: { kind, label: kind, selection: `${kind}:work`, commands: [] },
          forkDestinations: [{ target: "local", label: "Fork chat", iconKey: "local" }],
        }),
        actions: buildActions({ onForkThread }),
      });
      const fork = getCommand(commands, "fork");
      expect(fork).toMatchObject({ isVisible: true, isEnabled: true });
      await runCommand(fork);
      expect(onForkThread).toHaveBeenCalledExactlyOnceWith("local");
    },
  );

  test("offers both fork destinations and forks to the chosen target", async () => {
    const onForkThread = vi.fn(async () => undefined);
    const commands = buildCommands({
      model: buildModel({
        forkDestinations: [
          { target: "local", label: "Fork chat", iconKey: "local" },
          { target: "newWorktree", label: "Fork chat in new worktree", iconKey: "worktree" },
        ],
      }),
      actions: buildActions({ onForkThread }),
    });
    const items = getSubmenu(commands, "fork").sections.flatMap((section) => section.items);

    expect(items.map(({ id, title }) => [id, title])).toEqual([
      ["local", "Fork chat"],
      ["newWorktree", "Fork chat in new worktree"],
    ]);
    for (const item of items) await item.run?.();
    expect(onForkThread.mock.calls).toEqual([["local"], ["newWorktree"]]);
  });

  test("forks from the latest Turn when only turn-level forking is available", async () => {
    const onForkFromTurn = vi.fn(async () => undefined);
    const commands = buildCommands({ actions: buildActions({ onForkFromTurn }) });

    await runCommand(getCommand(commands, "fork"));

    expect(onForkFromTurn).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread_1",
      turnId: "turn_1",
      message: "",
    });
  });

  test("routes native Status and MCP commands to the live runtime inspector", async () => {
    const onOpenStatusPanel = vi.fn();
    const commands = buildCommands({
      model: buildModel({
        provider: {
          kind: "claude",
          label: "Claude",
          selection: "claude:work",
          commands: [providerCommand("mcp")],
          diagnostics: async () => ({
            health: {
              status: "ready",
              executable: null,
              version: null,
              account: null,
              error: null,
            },
            mcpServers: [],
            agents: [],
            capabilities: [],
          }),
        },
      }),
      actions: buildActions({ onOpenStatusPanel }),
    });
    expect(commands.filter((command) => command.section?.kind === "agent")).toEqual([]);
    for (const id of ["status", "mcp"]) {
      const command = getCommand(commands, id);
      expect(command.isVisible).toBe(true);
      await runCommand(command);
    }
    expect(onOpenStatusPanel.mock.calls).toEqual([["thread_1"], ["thread_1"]]);
  });

  test("delegates Pet visibility to the native avatar overlay owner", async () => {
    const onPetToggle = vi.fn();
    const commands = buildCommands({ onPetToggle });

    await runCommand(getCommand(commands, "pet"));

    expect(onPetToggle).toHaveBeenCalledOnce();
  });

  test("offers Merge back only in a fork and enables it once the reply finishes", async () => {
    const onMergeForkBack = vi.fn(async () => undefined);
    expect(getCommand(buildCommands(), "merge").isVisible).toBe(false);
    const actions = buildActions({ onMergeForkBack });
    const running = buildCommands({ model: buildModel({ isThreadRunning: true }), actions });
    expect(getCommand(running, "merge").isEnabled).toBe(false);
    const merge = getCommand(buildCommands({ actions }), "merge");
    expect(merge).toMatchObject({ isVisible: true, isEnabled: true });
    await runCommand(merge);
    expect(onMergeForkBack).toHaveBeenCalledOnce();
  });

  test("supersedes the Agent's own clear command and enables Clear context once the reply finishes", async () => {
    const onClearContext = vi.fn(async () => undefined);
    const build = (isThreadRunning: boolean) =>
      buildCommands({
        model: buildModel({
          isThreadRunning,
          provider: {
            kind: "claude",
            label: "Claude",
            selection: "claude:work",
            commands: [providerCommand("clear")],
          },
        }),
        actions: buildActions({ onClearContext }),
      });

    expect(getCommand(build(true), "clear").isEnabled).toBe(false);
    const commands = build(false);
    expect(commands.some((command) => command.id === "agent:clear")).toBe(false);
    const clear = getCommand(commands, "clear");
    expect(clear).toMatchObject({ title: "Clear context", isVisible: true, isEnabled: true });
    await runCommand(clear);
    expect(onClearContext).toHaveBeenCalledOnce();
  });

  test("keeps capabilities in the context provider without duplicating plugin slash commands", () => {
    const commands = buildCommands({
      model: buildModel({
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
      }),
    });

    expect(commands.some((command) => command.id.startsWith("plugin:"))).toBe(false);
  });

  test("reports MCP server authentication status in a read-only row", () => {
    const commands = buildCommands({
      mcp: {
        statuses: [
          {
            name: "docs",
            pluginId: null,
            httpOrigin: null,
            serverInfo: null,
            serverCapabilities: null,
            toolListMeta: null,
            tools: {},
            toolsError: null,
            resources: [],
            resourceTemplates: [],
            runtimeStatus: "connected",
            authStatus: "oAuth",
          },
        ],
        loading: false,
        error: null,
      },
    });
    const sections = filterComposerSlashSubmenu(getSubmenu(commands, "mcp"), "");

    expect(sections[0]?.items).toEqual([
      { id: "docs", title: "docs", description: "OAuth connected" },
    ]);
    expect(sections[0]?.emptyState).toBeNull();
  });

  test.each([
    {
      mcp: { statuses: undefined, loading: true, error: null },
      message: "Loading MCP servers",
    },
    {
      mcp: { statuses: undefined, loading: false, error: "Could not connect" },
      message: "Could not connect",
    },
    {
      mcp: { statuses: [], loading: false, error: null },
      message: "No MCP servers",
    },
  ])("shows MCP status state: $message", ({ mcp, message }) => {
    const sections = filterComposerSlashSubmenu(getSubmenu(buildCommands({ mcp }), "mcp"), "");

    expect(sections[0]).toMatchObject({ items: [], loading: mcp.loading, emptyState: message });
  });

  test("offers Goal for an existing chat with draft text and activates goal mode", async () => {
    const activateGoalMode = vi.fn();
    const commands = buildCommands({ activateGoalMode });
    const matches = filterComposerSlashCommands({
      commands,
      query: "goal",
      composerText: "ask /goal",
    });
    expect(matches.map(({ command }) => command.id)).toEqual(["goal"]);

    await runCommand(getCommand(commands, "goal"));

    expect(activateGoalMode).toHaveBeenCalledOnce();
  });

  test("offers Goal in a new chat when a session thread can be started", async () => {
    const activateGoalMode = vi.fn();
    const commands = buildCommands({
      model: buildNewThreadModel(),
      actions: buildActions({ onStartThreadForSession: async () => undefined }),
      activateGoalMode,
    });
    const goal = getCommand(commands, "goal");
    expect(goal.isVisible).toBe(true);

    await runCommand(goal);

    expect(activateGoalMode).toHaveBeenCalledOnce();
  });

  test("uses the intelligence menu's reasoning choices, current effort, and selection action", async () => {
    const choose = vi.fn(async () => undefined);
    const commands = buildCommands({
      intelligence: createTestIntelligenceMenu({
        effort: {
          label: "Medium",
          choices: [
            { value: "medium", label: "Medium", description: null, current: true },
            { value: "high", label: "High", description: "Deep reasoning", current: false },
          ],
          choose,
        },
      }),
    });
    const reasoning = getCommand(commands, "reasoning");
    expect(reasoning.isVisible).toBe(true);
    const items = getSubmenu(commands, "reasoning").sections.flatMap((section) => section.items);

    // Levels read as one scale; what each means shows on hover.
    expect(
      items.map(({ id, title, tooltip, current }) => ({ id, title, tooltip, current })),
    ).toEqual([
      { id: "medium", title: "Medium", tooltip: null, current: true },
      { id: "high", title: "High", tooltip: "Deep reasoning", current: false },
    ]);
    await items.find((item) => item.id === "high")?.run?.();
    expect(choose).toHaveBeenCalledExactlyOnceWith("high");
  });

  test("lists the intelligence menu's enabled models and puts off models in a search-only section", async () => {
    const current: AgentIntelligenceModelChoice = {
      key: "sonnet",
      binding: { driver: "codex", instanceId: "codex" },
      label: "Sonnet",
      detail: "Balanced",
      tooltip: null,
      searchText: "coding model",
      current: true,
      disabled: false,
      off: false,
      opensSettings: false,
    };
    const off: AgentIntelligenceModelChoice = {
      ...current,
      key: "mini",
      label: "Mini",
      detail: "Smaller",
      searchText: "small model",
      current: false,
      off: true,
    };
    const intelligence = createTestIntelligenceMenu();
    const choose = vi.fn(async () => undefined);
    const commands = buildCommands({
      intelligence: {
        ...intelligence,
        models: { ...intelligence.models, choices: [current, off], choose },
      },
    });

    const sections = getSubmenu(commands, "model").sections;
    expect(sections).toMatchObject([
      { items: [{ id: "sonnet", title: "Sonnet", description: "Balanced", current: true }] },
      {
        showOnlyWhenSearching: true,
        items: [{ id: "mini", title: "Mini", description: "Smaller", current: false }],
      },
    ]);
    await sections[1]?.items[0]?.run?.();
    expect(choose).toHaveBeenCalledExactlyOnceWith(off);
  });

  test("toggles Fast and Ultracode using the intelligence menu's current values", async () => {
    const setFast = vi.fn(async () => undefined);
    const setUltracode = vi.fn(async () => undefined);
    const fast = { on: false, description: "Turn Fast on", set: setFast };
    const ultracode = {
      on: true,
      description: "Turn Ultracode on",
      set: setUltracode,
      unavailableReason: null,
    };
    const commands = buildCommands({
      intelligence: createTestIntelligenceMenu({ fast, ultracode }),
    });

    await runCommand(getCommand(commands, "fast"));
    expect(setFast).toHaveBeenCalledExactlyOnceWith(true);
    await runCommand(getCommand(commands, "ultracode"));
    expect(setUltracode).toHaveBeenCalledExactlyOnceWith(false);

    const unavailable = buildCommands({
      intelligence: createTestIntelligenceMenu({
        ultracode: { ...ultracode, unavailableReason: "Dynamic workflows are off." },
      }),
    });
    expect(getCommand(unavailable, "ultracode")).toMatchObject({
      isVisible: true,
      isEnabled: false,
      description: "Dynamic workflows are off.",
    });
    expect(getCommand(buildCommands(), "ultracode").isVisible).toBe(false);
  });

  test("Fast and Ultrafast each switch to their own Codex speed and back to Standard", async () => {
    const choose = vi.fn(async () => undefined);
    const build = (tiers: readonly ("fast" | "ultrafast")[], value: "fast" | "ultrafast" | null) =>
      buildCommands({
        intelligence: createTestIntelligenceMenu({
          speed: { tiers: tiers.map((tier) => ({ value: tier })), value, choose },
        }),
      });

    const ultrafast = build(["fast", "ultrafast"], "ultrafast");
    expect(getCommand(ultrafast, "ultrafast").description).toBe("Turn Ultrafast off");
    await runCommand(getCommand(ultrafast, "fast"));
    expect(choose).toHaveBeenLastCalledWith("fast");
    await runCommand(getCommand(ultrafast, "ultrafast"));
    expect(choose).toHaveBeenLastCalledWith(null);

    const fastOnly = build(["fast"], null);
    expect(getCommand(fastOnly, "fast").isVisible).toBe(true);
    expect(getCommand(fastOnly, "ultrafast").isVisible).toBe(false);
  });

  test("opens Feedback through the Composer when uploads are available", async () => {
    const openFeedback = vi.fn();
    const commands = buildCommands({
      actions: buildActions({ onUploadFeedback: async () => undefined }),
      openFeedback,
    });
    const feedback = getCommand(commands, "feedback");
    expect(feedback.isVisible).toBe(true);

    await runCommand(feedback);

    expect(openFeedback).toHaveBeenCalledOnce();
  });
});
