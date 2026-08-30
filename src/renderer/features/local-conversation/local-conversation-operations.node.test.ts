import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const commandMocks = vi.hoisted(() => ({
  invokeControl: vi.fn(async () => true),
  invokePlain: vi.fn(async () => true),
  invokeQuery: vi.fn(async () => []),
}));

vi.mock("../../lib/renderer-command", () => ({
  defineRendererCommand: <Definition>(definition: Definition) => definition,
  invokePlainCommand: commandMocks.invokePlain,
  invokeRendererControl: commandMocks.invokeControl,
  invokeRendererQuery: commandMocks.invokeQuery,
}));

import {
  runConversationOperation,
  localConversationCommandDefinitions,
} from "./local-conversation-operations";

beforeEach(() => {
  commandMocks.invokeControl.mockClear();
  commandMocks.invokePlain.mockClear();
  commandMocks.invokeQuery.mockClear();
});

describe("LocalConversation operation boundary", () => {
  test("dispatches queries, controls, and commands through their classified transports", async () => {
    await runConversationOperation("codex:model:list");
    await runConversationOperation("codex:subagent-thread:opened", "thread-1");
    await runConversationOperation("codex:thread:archive", "thread-1");

    expect(commandMocks.invokeQuery).toHaveBeenCalledWith("codex:model:list");
    expect(commandMocks.invokeControl).toHaveBeenCalledWith(
      "codex:subagent-thread:opened",
      "thread-1",
    );
    expect(commandMocks.invokePlain).toHaveBeenCalledWith(
      localConversationCommandDefinitions["codex:thread:archive"],
      "thread-1",
    );
  });
});
