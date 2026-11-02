import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { makeBrowserHistoryRuntime } from "./browser-history-store";

const withHistory = <A, E, R>(
  run: (input: { readonly filePath: string; readonly root: string }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-history-"));
      return { root, filePath: path.join(root, "browser-history.json") };
    }),
    run,
    ({ root }) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
  );

it.layer(NodeServices.layer)("Browser history runtime", (it) => {
  it.effect("persists searchable visit history and coalesces identical URLs", () =>
    withHistory(({ filePath }) =>
      Effect.gen(function* () {
        const history = yield* makeBrowserHistoryRuntime(filePath);
        yield* history.record({
          url: "https://example.com/path?q=one",
          title: "Example",
          visitedAt: 10,
        });
        yield* history.record({
          url: "https://example.com/path?q=one",
          title: "Updated title",
          visitedAt: 20,
        });
        yield* history.record({
          url: "https://other.example/",
          title: "Other",
          visitedAt: 15,
        });

        assert.deepInclude((yield* history.list()).entries[0], {
          title: "Updated title",
          visitCount: 2,
          lastVisitedAt: 20,
        });
        assert.lengthOf((yield* history.list({ query: "other" })).entries, 1);
        const reloaded = yield* makeBrowserHistoryRuntime(filePath);
        assert.lengthOf((yield* reloaded.list()).entries, 2);
      }),
    ),
  );

  it.effect("records admitted page URLs without a scheme or credential filter", () =>
    withHistory(({ filePath }) =>
      Effect.gen(function* () {
        const history = yield* makeBrowserHistoryRuntime(filePath);
        yield* history.record({ url: "javascript:alert(1)", title: "unsafe" });
        yield* history.record({
          url: "https://user:secret@example.com/",
          title: "credential",
        });
        yield* history.record({ url: "file:///tmp/index.html", title: "Local" });
        yield* history.record({ url: `data:text/html,${"x".repeat(20_000)}`, title: "Data" });
        assert.lengthOf((yield* history.list()).entries, 4);
      }),
    ),
  );

  it.effect("serializes concurrent mutations and reloads their durable result", () =>
    withHistory(({ filePath }) =>
      Effect.gen(function* () {
        const history = yield* makeBrowserHistoryRuntime(filePath);
        yield* Effect.all(
          [
            history.record({ url: "https://one.example/", title: "One", visitedAt: 1 }),
            history.record({ url: "https://two.example/", title: "Two", visitedAt: 2 }),
          ],
          { concurrency: "unbounded" },
        );
        const reloaded = yield* makeBrowserHistoryRuntime(filePath);
        assert.lengthOf((yield* reloaded.list()).entries, 2);

        const [entry] = (yield* history.list({ query: "one" })).entries;
        yield* history.delete(entry!.id);
        yield* history.clear;
        assert.isEmpty((yield* history.list()).entries);
      }),
    ),
  );

  it.effect("quarantines malformed history instead of trusting it", () =>
    withHistory(({ filePath, root }) =>
      Effect.gen(function* () {
        fs.writeFileSync(filePath, "{broken");
        const history = yield* makeBrowserHistoryRuntime(filePath);
        assert.isEmpty((yield* history.list()).entries);
        assert.isTrue(
          fs.readdirSync(root).some((name) => name.startsWith("browser-history.json.corrupt-")),
        );
      }),
    ),
  );
});
