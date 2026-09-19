import { describe, expect, test } from "vite-plus/test";
import type { CodexCanonicalHookRun } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import {
  buildHookFeedbackSettingsHref,
  collectHookFeedbackSources,
} from "./hook-feedback-settings";

function buildHook(
  source: CodexCanonicalHookRun["run"]["source"],
  text: string,
  eventName: CodexCanonicalHookRun["run"]["eventName"] = "stop",
): CodexCanonicalHookRun {
  return {
    id: `${source}:${text}`,
    run: {
      id: `${source}:${text}`,
      eventName,
      source,
      handlerType: "command",
      executionMode: "sync",
      scope: "turn",
      sourcePath: "",
      displayOrder: 0n,
      status: "completed",
      statusMessage: null,
      startedAt: 1n,
      completedAt: 2n,
      durationMs: 1n,
      entries: [{ kind: "feedback", text }],
    },
  };
}

describe("hook feedback settings", () => {
  test("matches the trimmed user message against exact Stop-hook feedback text", () => {
    const hooks = [
      buildHook("project", "Address this failure."),
      buildHook("user", "  Address this failure.  "),
      buildHook("user", "Different feedback"),
      buildHook("plugin", "Address this failure.", "postToolUse"),
    ];

    expect(collectHookFeedbackSources(hooks, "Address this failure.")).toEqual(["project", "user"]);
    expect(collectHookFeedbackSources(hooks, "  Address this failure.  ")).toEqual([
      "project",
      "user",
    ]);
    expect(collectHookFeedbackSources(hooks, "No match")).toEqual([]);
  });

  test("maps exact source categories and includes project root only for project hooks", () => {
    expect(
      buildHookFeedbackSettingsHref({
        hostId: "local",
        cwd: "/workspace/nodex",
        sources: ["project"],
      }),
    ).toBe("/settings/hooks-settings?hostId=local&source=project&projectRoot=%2Fworkspace%2Fnodex");
    expect(
      buildHookFeedbackSettingsHref({
        hostId: "remote-1",
        cwd: "/workspace/nodex",
        sources: ["system", "mdm"],
      }),
    ).toBe("/settings/hooks-settings?hostId=remote-1&source=admin");
    expect(
      buildHookFeedbackSettingsHref({ hostId: "local", cwd: null, sources: ["project"] }),
    ).toBe("/settings/hooks-settings?hostId=local");
    expect(
      buildHookFeedbackSettingsHref({
        hostId: "local",
        cwd: "/workspace/nodex",
        sources: ["project", "user"],
      }),
    ).toBe("/settings/hooks-settings?hostId=local");
  });
});
