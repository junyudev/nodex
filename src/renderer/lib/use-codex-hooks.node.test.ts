import { describe, expect, test } from "vite-plus/test";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { CodexHooksListResponse } from "../../shared/codex-hooks";
import { applyCodexHookStatePatch, normalizeCodexHooksCwds } from "./use-codex-hooks";

function hook(key: string, currentHash: string): HookMetadata {
  return {
    environmentId: null,
    key,
    eventName: "stop",
    handlerType: "command",
    matcher: null,
    command: "echo done",
    async: false,
    timeoutSec: 10n,
    statusMessage: null,
    source: "user",
    sourcePath: "/tmp/hooks.json",
    pluginId: null,
    displayOrder: 0n,
    enabled: true,
    isManaged: false,
    currentHash,
    trustStatus: "untrusted",
    additionalContextLimit: null,
  };
}

describe("Codex Hooks query state", () => {
  test("normalizes roots without changing their first-seen order", () => {
    expect(normalizeCodexHooksCwds([" /workspace/b ", "", "/workspace/a", "/workspace/b"])).toEqual(
      ["/workspace/b", "/workspace/a"],
    );
  });

  test("optimistically patches every matching hook and trusts only its current hash", () => {
    const response: CodexHooksListResponse = {
      data: [
        { cwd: "/a", hooks: [hook("shared", "hash-a")], warnings: [], errors: [] },
        {
          cwd: "/b",
          hooks: [hook("shared", "hash-b"), hook("other", "hash-c")],
          warnings: [],
          errors: [],
        },
      ],
    };

    const patched = applyCodexHookStatePatch(response, {
      key: "shared",
      enabled: false,
      trustedHash: "hash-a",
    });

    expect(patched?.data[0]?.hooks[0]).toMatchObject({
      enabled: false,
      trustStatus: "trusted",
    });
    expect(patched?.data[1]?.hooks[0]).toMatchObject({
      enabled: false,
      trustStatus: "untrusted",
    });
    expect(patched?.data[1]?.hooks[1]).toEqual(response.data[1]?.hooks[1]);
  });
});
