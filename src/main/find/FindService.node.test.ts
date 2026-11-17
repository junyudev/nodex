import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import type { PageSearchResult } from "../../shared/types";
import type { FindRequest } from "../../shared/find";
import { makeFindService } from "./FindService";

const request: FindRequest = {
  query: "launch",
  kinds: ["page", "chat"],
  place: { kind: "project", projectId: "ops" },
  preferredProjectId: "ops",
  limit: 2,
};

const page = (pageId: string, textRank: number, archived = false): PageSearchResult => ({
  pageId,
  textRank,
  archived,
  title: pageId,
  projectId: "ops",
  pageKey: null,
  status: null,
  priority: null,
  tags: [],
  assignee: null,
  locationLabel: "Project",
  titleParts: [],
  excerpt: null,
  excerptParts: [],
  matches: [],
  updatedAt: "2026-11-18",
});

it.effect("federates phases, keeps surviving instant order, and pages a stable window", () =>
  Effect.gen(function* () {
    const first = page("first", 8);
    const second = page("second", 9);
    const archived = page("archived", 0, true);
    const find = makeFindService({
      searchPages: ({ instant, projectFilterIds, preferredProjectId }) =>
        Effect.sync(() => {
          expect(projectFilterIds).toEqual(["ops"]);
          expect(preferredProjectId).toBe("ops");
          return {
            results: instant ? [first, second] : [{ ...second, textRank: 0 }, first, archived],
            libraryId: "library",
            storeEpoch: "epoch",
            commitSeq: 1,
          };
        }),
      searchBlocks: () => Effect.die("not requested"),
      search: () => Effect.succeed({ matches: [], complete: true }),
      searchMessages: () =>
        Effect.succeed({
          matches: [],
          truncated: false,
          sources: [{ source: "runtime" as const, state: "partial" as const }],
        }),
    });
    const instant = yield* find(request, "instant");
    expect(instant.hits.map((hit) => hit.identity)).toEqual(["first", "second"]);

    const complete = yield* find(request, "complete");
    expect(complete.hits.map((hit) => hit.identity)).toEqual(["first", "second"]);
    expect(complete.topResult?.identity).toBe("second");
    expect(complete.coverage).toContainEqual({ source: "runtime", state: "partial" });
    expect(complete.nextCursor).not.toBeNull();

    const continued = yield* find({ ...request, cursor: complete.nextCursor! }, "complete");
    expect(continued.hits.map((hit) => hit.identity)).toEqual(["archived"]);
    expect(continued.nextCursor).toBeNull();
  }),
);
