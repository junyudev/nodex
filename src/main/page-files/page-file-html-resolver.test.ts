import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { LibraryModule } from "../library-application/LibraryModule";
import type { LibraryModuleReadRequest, LibraryReadValue } from "../../shared/library-module";
import type { LibraryFile, ReadFileBytesInput } from "../../shared/library-files";
import { makePageFileHtmlResolver } from "./page-file-html-resolver";

const file: LibraryFile = {
  file_id: "report",
  library_id: "library",
  default_name: "report.html",
  mime_type: "text/html",
  byte_length: 4,
  blob_etag: "etag",
  head_version: 7,
  revision: 1,
  lifecycle: "live",
  created_at: "now",
  updated_at: "now",
};
const input = {
  routingContext: { kind: "library" } as const,
  pageId: "page",
  fileId: "report",
  logicalPath: "profile/report.html",
  colorScheme: "light" as const,
};
function setup(logicalPath: string | null = input.logicalPath) {
  const requests: LibraryModuleReadRequest[] = [];
  const byteRequests: ReadFileBytesInput[] = [];
  let presentationEpoch = "epoch";
  const library: Pick<LibraryModule["Service"], "read" | "readFileBlob"> = {
    read: (_route, request) =>
      Effect.sync(() => {
        requests.push(request);
        const value: LibraryReadValue =
          request.read.mode === "resolve_page_file"
            ? {
                kind: "resolved_page_file",
                value: {
                  file,
                  logical_path: logicalPath,
                  attachment: logicalPath
                    ? { attached_by: { kind: "person" }, attached_at: "2026-11-01T00:00:00.000Z" }
                    : null,
                  body_count: 1,
                },
              }
            : {
                kind: "file_presentation",
                value: {
                  file_id: file.file_id,
                  default_name: file.default_name,
                  mime_type: file.mime_type,
                  byte_length: file.byte_length,
                  blob_etag: file.blob_etag,
                  version: file.head_version,
                },
              };
        return {
          ok: true as const,
          value: {
            profileId: "profile",
            libraryId: "library",
            storeEpoch: value.kind === "file_presentation" ? presentationEpoch : "epoch",
            commitSeq: 1,
            value,
          },
        };
      }),
    readFileBlob: (_route, request) =>
      Effect.sync(() => {
        byteRequests.push(request);
        return { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "text/html", etag: "etag" };
      }),
  };
  return {
    resolver: makePageFileHtmlResolver(library),
    requests,
    byteRequests,
    replaceStore: () => {
      presentationEpoch = "other";
    },
  };
}

it.effect(
  "uses Core's explicit Page path selector and Page-bound immutable version for bytes",
  () =>
    Effect.gen(function* () {
      const { resolver, requests, byteRequests } = setup();
      const resolved = yield* resolver.resolve(input);
      yield* resolver.read(input, resolved);
      assert.deepEqual(requests[0], {
        read: {
          mode: "resolve_page_file",
          page_id: "page",
          selector: { kind: "path", logical_path: "profile/report.html" },
        },
      });
      assert.deepEqual(byteRequests, [
        { fileId: "report", version: 7, source: { kind: "page", page_id: "page" } },
      ]);
      yield* resolver.resolve(input, "profile/trace.json");
      assert.deepEqual(requests[2], {
        read: {
          mode: "resolve_page_file",
          page_id: "page",
          selector: { kind: "path", logical_path: "profile/trace.json" },
        },
      });
    }),
);

it.effect("rejects stale document identity, missing explicit entry, and mixed Store epochs", () =>
  Effect.gen(function* () {
    const fixture = setup();
    assert.equal(
      (yield* Effect.result(fixture.resolver.resolve({ ...input, fileId: "other" })))._tag,
      "Failure",
    );
    const bodyOnly = setup(null);
    assert.equal(
      (yield* Effect.result(bodyOnly.resolver.resolve(input, "report.html")))._tag,
      "Failure",
    );
    fixture.replaceStore();
    assert.equal((yield* Effect.result(fixture.resolver.resolve(input)))._tag, "Failure");
  }),
);

it.effect("admits body-only documents by exact File identity without inventing sibling names", () =>
  Effect.gen(function* () {
    const { resolver, requests } = setup(null);
    const document = yield* resolver.resolve({ ...input, logicalPath: null });
    assert.equal(document.path, "report.html");
    assert.deepEqual(requests[0], {
      read: {
        mode: "resolve_page_file",
        page_id: "page",
        selector: { kind: "file_id", file_id: "report" },
      },
    });
  }),
);
