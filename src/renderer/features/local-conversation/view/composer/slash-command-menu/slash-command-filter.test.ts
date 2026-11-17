import { describe, expect, test } from "vite-plus/test";
import {
  composerHasDraftText,
  filterComposerSlashCommands,
  groupComposerSlashCommandMatches,
  resolveComposerSlashHighlight,
  resolveNextSlashHighlight,
  resolvePreservedSlashHighlight,
} from "./slash-command-filter";
import type { ComposerSlashCommand } from "./slash-command-types";

function command(
  input: Partial<ComposerSlashCommand> & { id: string; title: string },
): ComposerSlashCommand {
  return { icon: null, ...input };
}

function skill(name: string, title: string): ComposerSlashCommand {
  return command({ id: `skill:/skills/${name}/SKILL.md`, title, group: "Skills" });
}

function match(id: string, title = id) {
  return { command: command({ id, title }), title, score: 0 };
}

const ids = (matches: readonly { command: ComposerSlashCommand }[]) =>
  matches.map((entry) => entry.command.id);

describe("composer slash command filtering", () => {
  test("treats a lone slash command as an empty draft", () => {
    expect(composerHasDraftText("")).toBe(false);
    expect(composerHasDraftText("  /mo  ")).toBe(false);
    expect(composerHasDraftText("/model later")).toBe(false);
    expect(composerHasDraftText("ask /")).toBe(true);
    expect(composerHasDraftText("/model\nmore")).toBe(true);
    expect(composerHasDraftText("/a/b")).toBe(true);
  });

  test("matches word starts and continuous runs, not scattered letters", () => {
    const commands = [
      command({ id: "model", title: "Model", requiresEmptyComposer: true }),
      command({ id: "plan-mode", title: "Plan mode", requiresEmptyComposer: true }),
      command({ id: "side", title: "Side", requiresEmptyComposer: true }),
      skill("browser", "Browser Use"),
    ];
    const search = (query: string) =>
      ids(filterComposerSlashCommands({ query, composerText: `/${query}`, commands }));

    expect(search("mod")).toEqual(["model", "plan-mode"]);
    expect(search("pm")).toEqual(["plan-mode"]);
    expect(search("bu")).toEqual(["skill:/skills/browser/SKILL.md"]);
    expect(search("mdl")).toEqual([]);
  });

  test("hides empty-only commands for non-empty composer text", () => {
    const matches = filterComposerSlashCommands({
      query: "",
      composerText: "ask /",
      commands: [
        command({ id: "compact", title: "Compact", requiresEmptyComposer: true }),
        skill("browser", "Browser Use"),
      ],
    });

    expect(ids(matches)).toEqual(["skill:/skills/browser/SKILL.md"]);
  });

  test("uses trigger eligibility and keeps goal visible in non-empty composer text", () => {
    const matches = filterComposerSlashCommands({
      query: "go",
      trigger: "@",
      composerText: "ask @go",
      commands: [
        command({ id: "compact", title: "Compact", requiresEmptyComposer: true }),
        command({ id: "model", title: "Model" }),
        command({ id: "goal", title: "Goal", requiresEmptyComposer: false, triggers: ["/", "@"] }),
      ],
    });

    expect(ids(matches)).toEqual(["goal"]);
  });

  test("lists unheaded commands by title, then each section by title", () => {
    const matches = filterComposerSlashCommands({
      query: "",
      composerText: "/",
      commands: [
        skill("review", "Review PR"),
        command({ id: "status", title: "Status" }),
        skill("agent-browser", "Agent Browser"),
        command({ id: "mcp", title: "MCP" }),
        command({ id: "memories", title: "Memories" }),
        command({ id: "status", title: "Duplicate status" }),
        command({ id: "hidden", title: "Hidden", isVisible: false }),
      ],
    });

    expect(ids(matches)).toEqual([
      "mcp",
      "memories",
      "status",
      "skill:/skills/agent-browser/SKILL.md",
      "skill:/skills/review/SKILL.md",
    ]);
    expect(
      groupComposerSlashCommandMatches(matches).map((group) => [group.label, ids(group.matches)]),
    ).toEqual([
      [null, ["mcp", "memories", "status"]],
      ["Skills", ["skill:/skills/agent-browser/SKILL.md", "skill:/skills/review/SKILL.md"]],
    ]);
  });

  test("ranks a query within each section and keeps sections in order", () => {
    const matches = filterComposerSlashCommands({
      query: "re",
      composerText: "/re",
      commands: [
        skill("review", "Review PR"),
        skill("refactor", "Refactor"),
        command({ id: "reasoning", title: "Reasoning" }),
        command({ id: "status", title: "Status" }),
        command({ id: "fork", title: "Fork", searchAliases: ["branch from here"] }),
      ],
    });

    expect(ids(matches)).toEqual([
      "reasoning",
      "fork",
      "skill:/skills/refactor/SKILL.md",
      "skill:/skills/review/SKILL.md",
    ]);
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  test("finds a skill by its folder and a command by its ID", () => {
    expect(
      ids(
        filterComposerSlashCommands({
          query: "agent-br",
          composerText: "/agent-br",
          commands: [
            skill("agent-browser", "Browser Automation"),
            command({ id: "a", title: "A" }),
          ],
        }),
      ),
    ).toEqual(["skill:/skills/agent-browser/SKILL.md"]);
    expect(
      ids(
        filterComposerSlashCommands({
          query: "plan-m",
          composerText: "/plan-m",
          commands: [command({ id: "plan-mode", title: "Planning" })],
        }),
      ),
    ).toEqual(["plan-mode"]);
  });

  test("matches and orders by the title the menu shows", () => {
    const commands = [
      command({ id: "model", title: "Model" }),
      command({ id: "compact", title: "Compact" }),
    ];
    const shown: Record<string, string> = { model: "模型", compact: "压缩" };
    const resolveTitle = (entry: ComposerSlashCommand) => shown[entry.id]!;

    const all = filterComposerSlashCommands({
      query: "",
      composerText: "/",
      commands,
      resolveTitle,
    });
    expect(all.map((entry) => entry.title)).toEqual(["压缩", "模型"]);
    expect(
      ids(
        filterComposerSlashCommands({ query: "模型", composerText: "/", commands, resolveTitle }),
      ),
    ).toEqual(["model"]);
    expect(
      ids(filterComposerSlashCommands({ query: "mod", composerText: "/", commands, resolveTitle })),
    ).toEqual(["model"]);
  });

  test("wraps keyboard highlight through visible matches", () => {
    const matches = [match("compact"), match("model")];

    expect(resolveNextSlashHighlight({ matches, currentCommandId: null, direction: "first" })).toBe(
      "compact",
    );
    expect(
      resolveNextSlashHighlight({ matches, currentCommandId: "compact", direction: "next" }),
    ).toBe("model");
    expect(
      resolveNextSlashHighlight({ matches, currentCommandId: "compact", direction: "previous" }),
    ).toBe("model");
  });

  test("preserves the highlighted row across equivalent item updates", () => {
    const matches = [match("compact"), match("model")];
    const updatedMatches = [match("compact"), match("model")];

    expect(resolvePreservedSlashHighlight({ matches, currentCommandId: null })).toBe("compact");
    expect(
      resolvePreservedSlashHighlight({ matches: updatedMatches, currentCommandId: "model" }),
    ).toBe("model");
    expect(resolvePreservedSlashHighlight({ matches, currentCommandId: "missing" })).toBe(
      "compact",
    );
    expect(
      resolveComposerSlashHighlight({
        matches: updatedMatches,
        intent: { commandId: "model", source: "pointer" },
      }),
    ).toEqual({ commandId: "model", source: "pointer" });
    expect(
      resolveComposerSlashHighlight({
        matches,
        intent: { commandId: "missing", source: "pointer" },
      }),
    ).toEqual({ commandId: "compact", source: "programmatic" });
  });
});
