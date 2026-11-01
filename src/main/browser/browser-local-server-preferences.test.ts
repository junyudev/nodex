import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { makeBrowserLocalServerPreferencesRuntime } from "./browser-local-server-preferences";

it.layer(NodeServices.layer)("Browser local server preferences runtime", (it) => {
  const makeRuntime = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-browser-local-prefs-" });
    const filePath = path.join(root, "browser-local-server-preferences.json");
    const runtime = yield* makeBrowserLocalServerPreferencesRuntime(filePath, () => 1_234);
    return { filePath, fs, root, runtime };
  });

  it.effect("durably serializes concurrent updates without losing fields", () =>
    Effect.gen(function* () {
      const { filePath, fs, runtime } = yield* makeRuntime;
      assert.deepEqual(yield* runtime.snapshot, {
        showMode: "online",
        sortMode: "recently-used",
        expandedProjectIds: [],
      });

      yield* Effect.all(
        [
          runtime.update({ showMode: "hidden" }),
          runtime.update({
            sortMode: "origin",
            expandedProjectIds: [" alpha ", "alpha", "", "beta"],
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(yield* runtime.snapshot, {
        showMode: "hidden",
        sortMode: "origin",
        expandedProjectIds: ["alpha", "beta"],
      });
      const replacement = yield* makeBrowserLocalServerPreferencesRuntime(filePath);
      assert.deepEqual(yield* replacement.snapshot, yield* runtime.snapshot);
      if (process.platform !== "win32")
        assert.strictEqual((yield* fs.stat(filePath)).mode & 0o777, 0o600);
    }),
  );

  it.effect("quarantines malformed state instead of blocking Browser startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-browser-local-invalid-" });
      const filePath = path.join(root, "browser-local-server-preferences.json");
      yield* fs.writeFileString(filePath, "{broken");

      const runtime = yield* makeBrowserLocalServerPreferencesRuntime(filePath, () => 4_321);
      assert.deepEqual(yield* runtime.snapshot, {
        showMode: "online",
        sortMode: "recently-used",
        expandedProjectIds: [],
      });
      assert.deepEqual(yield* fs.readDirectory(root), [
        "browser-local-server-preferences.json.corrupt-4321",
      ]);
    }),
  );
});
