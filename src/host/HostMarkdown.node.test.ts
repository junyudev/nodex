import { resolve } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, vi } from "vitest";

it.effect("a host graph loads Nodex Markdown from its bundle before any owner uses it", () =>
  Effect.gen(function* () {
    // A fresh module graph, as a headless host process starts with: nothing has loaded Markdown.
    vi.resetModules();
    const markdown = yield* Effect.promise(() => import("../shared/nodex-markdown"));
    const { live } = yield* Effect.promise(() => import("./HostMarkdown"));
    const { testLayer } = yield* Effect.promise(() => import("../main/app/MainConfig"));
    expect(() => markdown.readMarkdown("**Ready**")).toThrow("Nodex Markdown is not initialized");

    const markdownModulePath = resolve(
      process.cwd(),
      "src/shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm",
    );
    yield* Layer.build(live).pipe(
      Effect.provide(Layer.merge(testLayer({ markdownModulePath }), NodeFileSystem.layer)),
      Effect.scoped,
    );
    expect(markdown.markdownPlainText(markdown.readMarkdown("**Ready**"))).toBe("Ready");
  }),
);
