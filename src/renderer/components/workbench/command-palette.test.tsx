import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { CommandPaletteCard, CommandPaletteCommand } from "@/lib/command-palette";
import type { Card } from "@/lib/types";
import { createCommandPaletteCardSearchIndex } from "../../lib/command-palette-card-search";

mock.module("./card-icon", () => ({
  CardIcon: ({ className }: { className?: string }) => createElement("span", { className }, "C"),
}));

mock.module("./threads-icon", () => ({
  ThreadsIcon: ({ className }: { className?: string }) => createElement("span", { className }, "T"),
}));

mock.module("./toggle-list-icon", () => ({
  ToggleListIcon: ({ className }: { className?: string }) => createElement("span", { className }, "L"),
}));

const windowStub = {
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
  cancelAnimationFrame: () => undefined,
};

Reflect.set(globalThis, "window", windowStub);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function collectText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const maybeChildren = (value as { props?: { children?: unknown } }).props?.children;
  if (maybeChildren !== undefined) {
    return collectText(maybeChildren);
  }

  return "";
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: overrides.id ?? "card-1",
    title: overrides.title ?? "Misc task",
    description: overrides.description ?? "Rebuild the fuzzy search indxer for the palette.",
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
    created: overrides.created ?? new Date("2026-03-14T00:00:00.000Z"),
    order: overrides.order ?? 0,
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

describe("CommandPaletteSurface", () => {
  test("opens the top fuzzy description match on Enter", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const executedItems: CommandPaletteCard[] = [];
    const closeCalls: number[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const firstArg = args[0];
      if (typeof firstArg === "string" && firstArg.includes("react-test-renderer is deprecated")) {
        return;
      }
      originalConsoleError(...args);
    };

    try {
      const cards = [
        makePaletteCard({
          card: makeCard({
            id: "card-1",
            title: "Misc task",
            description: "Rebuild the fuzzy search indxer for the palette.",
          }),
        }),
      ];
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          createElement(CommandPaletteSurface, {
            open: true,
            openTriggerTick: 1,
            commands: [],
            cards,
            cardSearchIndex: createCommandPaletteCardSearchIndex(cards),
            loading: false,
            onRequestClose: () => {
              closeCalls.push(1);
            },
            onExecute: (item: CommandPaletteCard | CommandPaletteCommand) => {
              if (item.kind !== "card") {
                return;
              }
              executedItems.push(item);
            },
          }),
        );
      });

      await act(async () => {
        await Promise.resolve();
      });

      const input = renderer.root.findByProps({ "aria-label": "Command palette search" });

      await act(async () => {
        input.props.onChange({
          target: {
            value: "search indexer",
          },
        });
      });

      const previewNodes = renderer.root.findAll((node) => {
        const className = typeof node.props.className === "string" ? node.props.className : "";
        return className.includes("line-clamp-3");
      });
      const highlightNodes = renderer.root.findAll((node) => {
        const className = typeof node.props.className === "string" ? node.props.className : "";
        return className.includes("bg-token-foreground/8");
      });

      expect(previewNodes.length).toBe(1);
      expect(collectText(previewNodes[0]?.children ?? []).includes("fuzzy search indxer")).toBeTrue();
      expect(highlightNodes.length > 0).toBeTrue();

      let prevented = false;
      await act(async () => {
        input.props.onKeyDown({
          key: "Enter",
          preventDefault: () => {
            prevented = true;
          },
        });
      });

      expect(prevented).toBeTrue();
      expect(closeCalls.length).toBe(1);
      expect(executedItems.length).toBe(1);
      expect(executedItems[0]?.card.id).toBe("card-1");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("seeds command mode when an initial > query is provided", async () => {
    const { CommandPaletteSurface } = await import("./command-palette-surface");
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const firstArg = args[0];
      if (typeof firstArg === "string" && firstArg.includes("react-test-renderer is deprecated")) {
        return;
      }
      originalConsoleError(...args);
    };

    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          createElement(CommandPaletteSurface, {
            open: true,
            openTriggerTick: 2,
            initialQuery: ">",
            commands: [
              {
                kind: "command",
                id: "open-settings",
                title: "Open settings",
                subtitle: "Workspace preferences",
                keywords: ["settings", "preferences"],
                priority: 100,
              },
            ],
            cards: [
              makePaletteCard({
                card: makeCard({
                  id: "card-2",
                  title: "Misc task",
                  description: "Should not appear while command mode is active.",
                }),
              }),
            ],
            cardSearchIndex: createCommandPaletteCardSearchIndex([]),
            loading: false,
            onRequestClose: () => undefined,
            onExecute: () => undefined,
          }),
        );
      });

      await act(async () => {
        await Promise.resolve();
      });

      const input = renderer.root.findByProps({ "aria-label": "Command palette search" });
      const resultButtons = renderer.root.findAll((node) => node.type === "button" && node.props["cmdk-item"] === "");
      expect(input.props.value).toBe(">");
      expect(renderer.root.findAllByType("kbd").length).toBe(0);
      expect(resultButtons.length).toBe(1);
      expect(renderer.root.findAll((node) => collectText(node.children).includes("Misc task")).length).toBe(0);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
