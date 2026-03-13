import { describe, expect, test } from "bun:test";
import { filterCommandPaletteItems, type CommandPaletteCard, type CommandPaletteCommand } from "./command-palette";
import type { Card } from "./types";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: overrides.id ?? "card-1",
    title: overrides.title ?? "Polish command palette",
    description: overrides.description ?? "Add quick card switching and commands.",
    status: overrides.status ?? "in_progress",
    archived: overrides.archived ?? false,
    priority: overrides.priority,
    estimate: overrides.estimate,
    tags: overrides.tags ?? ["search"],
    dueDate: overrides.dueDate,
    scheduledStart: overrides.scheduledStart,
    scheduledEnd: overrides.scheduledEnd,
    isAllDay: overrides.isAllDay ?? false,
    recurrence: overrides.recurrence,
    reminders: overrides.reminders ?? [],
    scheduleTimezone: overrides.scheduleTimezone,
    assignee: overrides.assignee,
    agentStatus: overrides.agentStatus,
    agentBlocked: overrides.agentBlocked ?? false,
    runInTarget: overrides.runInTarget ?? "localProject",
    runInLocalPath: overrides.runInLocalPath,
    runInBaseBranch: overrides.runInBaseBranch,
    runInWorktreePath: overrides.runInWorktreePath,
    runInEnvironmentPath: overrides.runInEnvironmentPath,
    revision: overrides.revision ?? 1,
    created: overrides.created ?? new Date("2026-03-13T00:00:00.000Z"),
    order: overrides.order ?? 0,
  };
}

function makeCommand(overrides: Partial<CommandPaletteCommand> = {}): CommandPaletteCommand {
  return {
    kind: "command",
    id: overrides.id ?? "open-settings",
    title: overrides.title ?? "Open settings",
    subtitle: overrides.subtitle ?? "Workspace preferences",
    keywords: overrides.keywords ?? ["settings", "preferences"],
    shortcut: overrides.shortcut,
    active: overrides.active ?? false,
    priority: overrides.priority ?? 100,
  };
}

function makePaletteCard(overrides: Partial<CommandPaletteCard> = {}): CommandPaletteCard {
  const card = overrides.card ?? makeCard();
  return {
    kind: "card",
    id: overrides.id ?? `${overrides.projectId ?? "default"}:${card.id}`,
    projectId: overrides.projectId ?? "default",
    projectName: overrides.projectName ?? "Default",
    projectIcon: overrides.projectIcon ?? "",
    columnName: overrides.columnName ?? "In progress",
    card,
    inActiveProject: overrides.inActiveProject ?? true,
    recentIndex: overrides.recentIndex ?? null,
    boardIndex: overrides.boardIndex ?? 0,
  };
}

describe("filterCommandPaletteItems", () => {
  test("prefers title matches and active-project cards", () => {
    const currentProjectCard = makePaletteCard({
      card: makeCard({ id: "card-a", title: "Command palette" }),
      inActiveProject: true,
      boardIndex: 5,
    });
    const otherProjectCard = makePaletteCard({
      card: makeCard({ id: "card-b", title: "Command palette" }),
      projectId: "ops",
      projectName: "Ops",
      inActiveProject: false,
      boardIndex: 0,
    });

    const result = filterCommandPaletteItems({
      query: "command pal",
      commands: [],
      cards: [otherProjectCard, currentProjectCard],
    });

    expect(result.cards[0]?.card.id).toBe("card-a");
  });

  test("supports command-only mode with a > prefix", () => {
    const result = filterCommandPaletteItems({
      query: "> sett",
      commands: [
        makeCommand(),
        makeCommand({ id: "search", title: "Search tasks", subtitle: "Current project", keywords: ["find"] }),
      ],
      cards: [makePaletteCard()],
    });

    expect(result.commandMode).toBeTrue();
    expect(result.commands.length).toBe(1);
    expect(result.commands[0]?.id).toBe("open-settings");
    expect(result.cards.length).toBe(0);
  });

  test("boosts recent cards when the query is otherwise tied", () => {
    const recentCard = makePaletteCard({
      card: makeCard({ id: "recent", title: "Search flow" }),
      recentIndex: 0,
      boardIndex: 10,
    });
    const staleCard = makePaletteCard({
      card: makeCard({ id: "stale", title: "Search flow" }),
      recentIndex: null,
      boardIndex: 0,
    });

    const result = filterCommandPaletteItems({
      query: "search flow",
      commands: [],
      cards: [staleCard, recentCard],
    });

    expect(result.cards[0]?.card.id).toBe("recent");
  });

  test("returns useful defaults for an empty query", () => {
    const result = filterCommandPaletteItems({
      query: "",
      commands: [
        makeCommand({ id: "terminal", title: "Toggle terminal", priority: 300 }),
        makeCommand({ id: "board", title: "Switch to board", priority: 200 }),
      ],
      cards: [
        makePaletteCard({ card: makeCard({ id: "alpha", title: "Alpha" }), boardIndex: 3 }),
        makePaletteCard({ card: makeCard({ id: "beta", title: "Beta" }), boardIndex: 0 }),
      ],
    });

    expect(result.commands[0]?.id).toBe("terminal");
    expect(result.cards[0]?.card.id).toBe("beta");
  });
});
