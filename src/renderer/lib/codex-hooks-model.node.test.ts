import { describe, expect, test } from "vite-plus/test";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { HooksListEntry } from "@nodex/codex-app-server-protocol/v2/HooksListEntry";
import {
  groupCodexHooksListEntries,
  isCodexHookActive,
  resolveSelectedCodexHooksEntry,
  summarizeCodexHookEvents,
} from "./codex-hooks-model";

type CommandHookMetadata = Extract<HookMetadata, { handlerType: "command" }>;

function hook(
  overrides: Partial<CommandHookMetadata> & Pick<CommandHookMetadata, "key" | "source">,
): CommandHookMetadata {
  return {
    eventName: "stop",
    handlerType: "command",
    matcher: null,
    command: "echo done",
    async: false,
    timeoutSec: 10n,
    statusMessage: null,
    sourcePath: "/tmp/hooks.json",
    pluginId: null,
    displayOrder: 0n,
    enabled: true,
    isManaged: false,
    currentHash: "hash",
    trustStatus: "trusted",
    ...overrides,
    additionalContextLimit: overrides.additionalContextLimit ?? null,
  };
}

test("managed hooks are active while review-needed hooks are not", () => {
  expect(
    isCodexHookActive(
      hook({ key: "managed", source: "mdm", trustStatus: "managed", enabled: false }),
    ),
  ).toBe(true);
  expect(isCodexHookActive(hook({ key: "new", source: "user", trustStatus: "untrusted" }))).toBe(
    false,
  );
});

test("summarizes interrupt hooks as a first-class event", () => {
  const summaries = summarizeCodexHookEvents([
    hook({ key: "interrupt", source: "user", eventName: "interrupt" }),
  ]);

  expect(summaries.at(-1)).toEqual({
    eventName: "interrupt",
    active: 1,
    installed: 1,
    needsReview: 0,
  });
});

describe("Codex Hooks source grouping", () => {
  test("dedupes global hooks, keeps project roots separate, and groups plugins by protocol id", () => {
    const entries: HooksListEntry[] = [
      {
        cwd: "/workspace/a",
        hooks: [
          hook({ key: "user", source: "user" }),
          hook({ key: "admin", source: "cloudManagedConfig" }),
          hook({ key: "project-a", source: "project" }),
          hook({ key: "plugin-z", source: "plugin", pluginId: "zeta" }),
          hook({ key: "plugin-unknown", source: "plugin", pluginId: null }),
        ],
        warnings: [],
        errors: [],
      },
      {
        cwd: "/workspace/b",
        hooks: [
          hook({ key: "user", source: "user" }),
          hook({ key: "project-b", source: "project" }),
          hook({ key: "plugin-a", source: "plugin", pluginId: "alpha" }),
        ],
        warnings: [],
        errors: [],
      },
    ];

    const sections = groupCodexHooksListEntries(entries);
    expect(sections.map((section) => section.source)).toEqual([
      "plugin",
      "user",
      "admin",
      "project",
    ]);
    expect(
      sections[0]?.pluginEntries?.map((entry) =>
        entry.selection.source === "plugin" ? entry.selection.pluginId : undefined,
      ),
    ).toEqual(["alpha", "zeta", null]);
    expect(sections[1]?.entry?.hooks.map((entry) => entry.key)).toEqual(["user"]);
    expect(sections[3]?.projectEntries?.map((entry) => entry.cwd)).toEqual([
      "/workspace/a",
      "/workspace/b",
    ]);
    expect(
      resolveSelectedCodexHooksEntry(sections, {
        source: "project",
        projectRoot: "/workspace/b",
      })?.hooks.map((entry) => entry.key),
    ).toEqual(["project-b"]);
  });

  test("surfaces warning-only roots under Unknown source", () => {
    const sections = groupCodexHooksListEntries([
      {
        cwd: "/workspace/a",
        hooks: [],
        warnings: ["Could not parse hooks"],
        errors: [],
      },
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.source).toBe("unknown");
    expect(sections[0]?.entry?.warnings).toEqual(["Could not parse hooks"]);
  });
});
