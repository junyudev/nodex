import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PageFileHtmlAdmissionInput } from "../../shared/page-file-html";
import type { LibraryFilePresentation, LibraryPageFileSelector } from "../../shared/library-files";
import type { LibraryModule } from "../library-application/LibraryModule";
import { decodePageFileHtmlPath, encodePageFileHtmlPath } from "./page-file-html-policy";

export class PageFileHtmlResolutionError extends Schema.TaggedError<PageFileHtmlResolutionError>()(
  "PageFileHtmlResolutionError",
  {},
) {}

export interface ResolvedPageFileHtml {
  readonly path: string;
  readonly storeEpoch: string;
  readonly presentation: LibraryFilePresentation;
}

export interface PageFileHtmlResolver {
  readonly resolve: (
    input: PageFileHtmlAdmissionInput,
    resourcePath?: string,
  ) => Effect.Effect<ResolvedPageFileHtml, PageFileHtmlResolutionError>;
  readonly read: (
    input: PageFileHtmlAdmissionInput,
    resolved: ResolvedPageFileHtml,
  ) => Effect.Effect<Uint8Array, PageFileHtmlResolutionError>;
}

/** Core resolves paths only in explicit entries and authorizes every byte read with the Page. */
export function makePageFileHtmlResolver(
  library: Pick<LibraryModule["Service"], "read" | "readFileBlob">,
): PageFileHtmlResolver {
  const resolve = Effect.fn("PageFileHtml.resolve")(
    function* (input: PageFileHtmlAdmissionInput, resourcePath?: string) {
      const selector: LibraryPageFileSelector =
        resourcePath !== undefined
          ? { kind: "path", logical_path: resourcePath }
          : input.logicalPath !== null
            ? { kind: "path", logical_path: input.logicalPath }
            : { kind: "file_id", file_id: input.fileId };
      const result = yield* library.read(input.routingContext, {
        read: { mode: "resolve_page_file", page_id: input.pageId, selector },
      });
      if (!result.ok || result.value.value.kind !== "resolved_page_file")
        return yield* new PageFileHtmlResolutionError();
      const item = result.value.value.value;
      if (
        resourcePath === undefined &&
        (item.file.file_id !== input.fileId || (item.logical_path ?? null) !== input.logicalPath)
      )
        return yield* new PageFileHtmlResolutionError();
      if (resourcePath !== undefined && !item.logical_path)
        return yield* new PageFileHtmlResolutionError();
      const presentation = yield* library.read(input.routingContext, {
        read: {
          mode: "file_presentation",
          file_id: item.file.file_id,
          source: { kind: "page", page_id: input.pageId },
        },
      });
      if (
        !presentation.ok ||
        presentation.value.value.kind !== "file_presentation" ||
        presentation.value.storeEpoch !== result.value.storeEpoch
      )
        return yield* new PageFileHtmlResolutionError();
      const path = item.logical_path ?? presentation.value.value.value.default_name;
      if (input.logicalPath === null && resourcePath === undefined && path.includes("/"))
        return yield* new PageFileHtmlResolutionError();
      if (decodePageFileHtmlPath(`/${encodePageFileHtmlPath(path)}`) !== path)
        return yield* new PageFileHtmlResolutionError();
      return {
        path,
        storeEpoch: result.value.storeEpoch,
        presentation: presentation.value.value.value,
      };
    },
    Effect.mapError(() => new PageFileHtmlResolutionError()),
  );
  return {
    resolve,
    read: (input, resolved) =>
      library
        .readFileBlob(input.routingContext, {
          fileId: resolved.presentation.file_id,
          version: resolved.presentation.version,
          source: { kind: "page", page_id: input.pageId },
        })
        .pipe(
          Effect.map((blob) => blob.bytes),
          Effect.mapError(() => new PageFileHtmlResolutionError()),
        ),
  };
}
