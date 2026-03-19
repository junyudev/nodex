import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  test("defers default runtime validation until the app-server client starts", async () => {
    const previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-service-runtime-"));

    process.chdir(tempDir);

    try {
      const service = new CodexService() as unknown as {
        client: {
          additionalSearchPaths: string[];
          binaryPath: string;
          missingBinaryMessage: string;
        };
        shutdown: () => Promise<void>;
      };

      try {
        const expectedRuntimeRootSuffix = path.join(".generated", "codex-runtime", "bin");
        expect(service.client.binaryPath.endsWith(path.join(expectedRuntimeRootSuffix, "codex"))).toBeTrue();
        expect((service.client.additionalSearchPaths[0] ?? "").endsWith(expectedRuntimeRootSuffix)).toBeTrue();
        expect(service.client.missingBinaryMessage).toBe(
          "Pinned Codex runtime is missing or incomplete. Run `bun run stage:codex-runtime:mac`.",
        );
      } finally {
        await service.shutdown();
      }
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
