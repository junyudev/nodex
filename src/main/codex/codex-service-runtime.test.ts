import { describe, expect, test } from "bun:test";
import { CodexService } from "./codex-service";
import type { ResolvedCodexRuntime } from "./codex-runtime";

describe("codex-service runtime bootstrap", () => {
  test("passes the resolved runtime into the Codex app-server client", async () => {
    const runtime: ResolvedCodexRuntime = {
      source: "bundled",
      binaryPath: "/tmp/nodex/codex",
      additionalSearchPaths: ["/tmp/nodex/path"],
      metadataPath: "/tmp/nodex/runtime.json",
      missingBinaryMessage: "Bundled Codex runtime is missing or corrupted. Reinstall Nodex.",
      version: "0.115.0",
    };
    const service = new CodexService({ runtime }) as unknown as {
      client: {
        additionalSearchPaths: string[];
        binaryPath: string;
        missingBinaryMessage: string;
      };
      shutdown: () => Promise<void>;
    };

    try {
      expect(service.client.binaryPath).toBe(runtime.binaryPath);
      expect(service.client.additionalSearchPaths[0]).toBe(runtime.additionalSearchPaths[0]);
      expect(service.client.missingBinaryMessage).toBe(runtime.missingBinaryMessage);
    } finally {
      await service.shutdown();
    }
  });
});
