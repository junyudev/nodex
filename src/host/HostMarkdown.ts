import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { MainConfig } from "../main/app/MainConfig";
import { initMarkdownSync } from "../shared/nodex-markdown";

/**
 * Nodex Markdown is one synchronous module per process. Every host, a desktop or a headless Space
 * host, loads the module its own bundle ships at the base of the graph that owns Markdown, before
 * any owner reads or writes it; the desktop's startup window does not wait for it. The module
 * ships with the application, so failing to load it is a defect.
 */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { markdownModulePath } = yield* MainConfig;
    initMarkdownSync(yield* (yield* FileSystem.FileSystem).readFile(markdownModulePath));
  }).pipe(Effect.orDie),
);
