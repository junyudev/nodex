import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { makeBrowserPageRuntime, type BrowserSerializedPage } from "./browser-page-store";

const identity = {
  browserConversationId: "conversation-1",
  browserViewScopeId: "window-session-1",
  browserTabId: "browser-tab-1",
} as const;

const withPages = <A, E, R>(
  run: (input: { readonly filePath: string; readonly root: string }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-pages-"));
      return { root, filePath: path.join(root, "browser-sidebar-page-states.json") };
    }),
    run,
    ({ root }) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
  );

const page = (
  browserStorageId: string,
  overrides: Partial<BrowserSerializedPage> = {},
): BrowserSerializedPage => ({
  schemaVersion: 1,
  runtime: "electron-webview",
  browserStorageId,
  identity,
  title: "Example",
  url: "https://example.com/",
  updatedAt: 1,
  navigation: {
    currentIndex: 0,
    entries: [
      {
        title: "Example",
        url: "https://example.com/",
        pageState: "state",
      },
    ],
  },
  ...overrides,
});

it.layer(NodeServices.layer)("Browser page runtime", (it) => {
  it.effect("persists and reloads a validated navigation snapshot", () =>
    withPages(({ filePath }) =>
      Effect.gen(function* () {
        const pages = yield* makeBrowserPageRuntime(filePath);
        yield* pages.set(page("browser:one"));

        const reloaded = yield* makeBrowserPageRuntime(filePath);
        assert.deepEqual(yield* reloaded.get("browser:one"), page("browser:one"));
        assert.deepInclude(JSON.parse(fs.readFileSync(filePath, "utf8")), {
          schemaVersion: 1,
        });
      }),
    ),
  );

  it.effect("round-trips file, credentialed and long data URLs without a navigation cap", () =>
    withPages(({ filePath }) =>
      Effect.gen(function* () {
        const pages = yield* makeBrowserPageRuntime(filePath);
        const url = `data:text/html,${"x".repeat(80_000)}`;
        const snapshot = page("browser:urls", {
          url,
          navigation: {
            currentIndex: 2,
            entries: [
              { title: "Local", url: "file:///tmp/index.html" },
              { title: "Web", url: "https://user:secret@example.com/" },
              { title: "Data", url },
            ],
          },
        });
        yield* pages.set(snapshot);
        const reloaded = yield* makeBrowserPageRuntime(filePath);
        assert.deepEqual(yield* reloaded.get("browser:urls"), snapshot);
      }),
    ),
  );

  it.effect("keeps at most 500 navigation entries and 100 pages", () =>
    withPages(({ filePath }) =>
      Effect.gen(function* () {
        const pages = yield* makeBrowserPageRuntime(filePath);
        yield* pages.set(
          page("browser:long", {
            navigation: {
              currentIndex: 549,
              entries: Array.from({ length: 550 }, (_, index) => ({
                title: `Page ${index}`,
                url: `https://example.com/${index}`,
              })),
            },
          }),
        );
        const long = yield* pages.get("browser:long");
        assert.lengthOf(long?.navigation.entries ?? [], 500);
        assert.strictEqual(long?.navigation.currentIndex, 499);

        for (let index = 0; index < 101; index += 1) {
          yield* pages.set(page(`browser:${index}`, { updatedAt: index + 1 }));
        }
        assert.isNull(yield* pages.get("browser:0"));
        assert.isNotNull(yield* pages.get("browser:100"));
      }),
    ),
  );

  it.effect("quarantines corruption without preventing startup", () =>
    withPages(({ filePath, root }) =>
      Effect.gen(function* () {
        fs.writeFileSync(filePath, "{not-json", "utf8");
        const pages = yield* makeBrowserPageRuntime(filePath);
        assert.isNull(yield* pages.get("browser:missing"));
        const quarantine = fs
          .readdirSync(root)
          .find((name) => name.startsWith("browser-sidebar-page-states.json.corrupt-"));
        assert.isString(quarantine);
        assert.strictEqual(fs.readFileSync(path.join(root, quarantine!), "utf8"), "{not-json");
      }),
    ),
  );

  it.effect("reassociates a page without retaining the source identity", () =>
    withPages(({ filePath }) =>
      Effect.gen(function* () {
        const pages = yield* makeBrowserPageRuntime(filePath);
        yield* pages.set(page("browser:source"));
        yield* pages.reassociate("browser:source", "browser:target");

        assert.isNull(yield* pages.get("browser:source"));
        assert.deepInclude(yield* pages.get("browser:target"), {
          browserStorageId: "browser:target",
        });
      }),
    ),
  );

  it.effect("clears durable navigation history without touching the Browser profile", () =>
    withPages(({ filePath }) =>
      Effect.gen(function* () {
        const pages = yield* makeBrowserPageRuntime(filePath);
        yield* pages.set(page("browser:one"));
        yield* pages.set(page("browser:two"));
        yield* pages.clear;
        assert.isNull(yield* pages.get("browser:one"));
        assert.isNull(yield* pages.get("browser:two"));
      }),
    ),
  );
});
