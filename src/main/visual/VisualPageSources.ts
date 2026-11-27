import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import type { ContentRoutingContext } from "../../shared/content-routing-context";
import { readLocatedMarkdown, type MarkdownBlock } from "../../shared/nodex-markdown";
import { VISUAL_LIMITS } from "../../shared/visual/contract";
import type { CoreModules } from "../core-runtime/CoreModules";
import type { LibraryModule } from "../library-application/LibraryModule";
import type { ReadVisualSource } from "./VisualSources";
import { visualBlockSource, visualTableCells } from "../../shared/visual/page-blocks";

type PageDraft = components["schemas"]["LibraryPageDraftProjection"];

export function findVisualPageBlock(page: PageDraft, blockId: string): MarkdownBlock | undefined {
  const position = page.body_blocks.find((block) => block.block_id === blockId)?.spans[0]?.start;
  if (position === undefined) return undefined;
  const { blocks, locations } = readLocatedMarkdown(page.body_markdown, "document");
  const flatten = (nodes: readonly MarkdownBlock[]): MarkdownBlock[] =>
    nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
  const textPrefix = new TextDecoder().decode(
    new TextEncoder().encode(page.body_markdown).slice(0, position),
  );
  const index = locations.findIndex((spans) => spans[0]?.start === textPrefix.length);
  return flatten(blocks)[index];
}

export function readVisualPageBlock(page: PageDraft, blockId: string): string | undefined {
  const block = findVisualPageBlock(page, blockId);
  return block ? visualBlockSource(block) : undefined;
}

export function visualPageReader(options: {
  modules: CoreModules["Service"];
  library: LibraryModule["Service"];
  route: ContentRoutingContext;
  pageId: string;
  page?: PageDraft;
}): ReadVisualSource {
  const { modules, library, route, pageId } = options;
  return (reference) =>
    Effect.gen(function* () {
      if (reference.kind === "table") {
        const page = options.page ?? (yield* readVisualPage(modules, pageId));
        const table = page && findVisualPageBlock(page, reference.block);
        const cells = table && visualTableCells(table);
        if (!cells)
          return yield* Effect.fail(
            new Error("The table source must be on this Page and have a header row"),
          );
        return { kind: "table" as const, cells };
      }
      const file = yield* library.read(route, {
        read: {
          mode: "resolve_page_file",
          page_id: pageId,
          selector: { kind: "file_id", file_id: reference.file },
        },
      });
      if (!file.ok || file.value.value.kind !== "resolved_page_file")
        return yield* Effect.fail(new Error("The File source must belong to this Page"));
      const readSource = { kind: "page" as const, page_id: pageId };
      const presentation = yield* library.read(route, {
        read: { mode: "file_presentation", file_id: reference.file, source: readSource },
      });
      if (
        !presentation.ok ||
        presentation.value.value.kind !== "file_presentation" ||
        presentation.value.storeEpoch !== file.value.storeEpoch ||
        presentation.value.value.value.byte_length > VISUAL_LIMITS.resolvedBytes
      )
        return yield* Effect.fail(new Error("The Page File source is unavailable or over 4 MiB"));
      const blob = yield* library.readFileBlob(route, {
        fileId: reference.file,
        version: presentation.value.value.value.version,
        source: readSource,
      });
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes),
        catch: () => new Error("The Page File source must be UTF-8"),
      });
      return { kind: "file" as const, text };
    });
}

export const readVisualPage = Effect.fn("Visual.readPage")(function* (
  modules: CoreModules["Service"],
  pageId: string,
) {
  const snapshot = yield* modules.library.read({ kind: "page_draft_projection", page_id: pageId });
  return snapshot.value.kind === "page_draft_projection" ? snapshot.value.value : undefined;
});
