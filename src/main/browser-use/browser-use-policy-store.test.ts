import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { makeBrowserUsePolicyRuntime } from "./browser-use-policy-store";

it.layer(NodeServices.layer)("Browser Use policy runtime", (it) => {
  const makeRuntime = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-browser-policy-" });
    const filePath = path.join(root, "browser", "config.toml");
    const runtime = yield* makeBrowserUsePolicyRuntime(filePath, () => 1_234);
    return { filePath, fs, path, root, runtime };
  });

  it.effect("atomically persists exact plugin keys and serializes concurrent mutations", () =>
    Effect.gen(function* () {
      const { filePath, fs, runtime } = yield* makeRuntime;
      yield* Effect.all(
        [
          runtime.updateModes({
            approvalMode: "neverAsk",
            historyApprovalMode: "alwaysAsk",
            downloadApprovalMode: "neverAsk",
            uploadApprovalMode: "alwaysAsk",
            fullCdpAccessEnabled: true,
          }),
          runtime.updateOriginRule({
            action: "add",
            kind: "denied",
            origin: "example.com/path",
            resource: "download",
          }),
        ],
        { concurrency: "unbounded" },
      );
      yield* runtime.updateOriginRule({
        action: "add",
        kind: "allowed",
        origin: "https://example.com",
        resource: "download",
      });

      assert.deepInclude(runtime.snapshot(), {
        approvalMode: "neverAsk",
        downloadApprovalMode: "neverAsk",
        fullCdpAccessEnabled: true,
        allowedDownloadOrigins: ["https://example.com"],
        deniedDownloadOrigins: [],
      });
      const raw = yield* fs.readFileString(filePath);
      assert.include(raw, 'approval_mode = "never_ask"');
      assert.include(raw, "full_cdp_access_enabled = true");
      assert.include(raw, "[downloads]");
    }),
  );

  it.effect("hard-denies general and resource-specific origins", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime;
      yield* runtime.updateOriginRule({
        action: "add",
        kind: "denied",
        origin: "https://blocked.example",
        resource: "origin",
      });
      yield* runtime.updateOriginRule({
        action: "add",
        kind: "denied",
        origin: "https://files.example",
        resource: "upload",
      });
      assert.isTrue(runtime.isExplicitlyDenied("download", "https://blocked.example/report.pdf"));
      assert.isTrue(runtime.isExplicitlyDenied("upload", "https://files.example/form"));
      assert.isFalse(runtime.isExplicitlyDenied("download", "https://files.example/report.pdf"));
    }),
  );

  it.effect("quarantines invalid TOML without treating non-origin pages as explicit denials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-browser-policy-invalid-" });
      const filePath = path.join(root, "config.toml");
      yield* fs.writeFileString(filePath, "[origins\n");
      const runtime = yield* makeBrowserUsePolicyRuntime(filePath, () => 4_321);
      assert.isFalse(runtime.snapshot().fullCdpAccessEnabled);
      assert.isFalse(runtime.isExplicitlyDenied("origin", "file:///tmp/private"));
      assert.isFalse(runtime.isExplicitlyDenied("origin", "about:blank"));
      assert.deepEqual(yield* fs.readDirectory(root), ["config.toml.corrupt-4321"]);
    }),
  );
});
