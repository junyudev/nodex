import { describe, expect, test, afterEach, vi } from "vite-plus/test";
import { createProjectEventSubscriptionHub } from "./project-event-subscription-hub";
import type { DatabasePageKeyNamespaceV2 } from "../../shared/database-module-v2";
import { projectPageKeyEditorModel } from "./project-page-key-editor-model";
import type { ProjectSession, Project } from "./types";
import { projectSessionToSummary } from "./project-session-query-cache";
import {
  appendProjectSessionSummaryWindow,
  preferNewestProjectSessionSummaryWindow,
  readProjectSessionSummaryWindowThrough,
} from "./project-session-summary-window";
import {
  dedupeSourceRoots,
  makeSourceRootPrimary,
  normalizeSourceRootKey,
  sourceRootDisplayName,
} from "./project-sources";
import { resolveReferencedProjectContext } from "./referenced-project-context";
import { buildRemoteDestinationSearchResult } from "./use-project-page-destination-search";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";

describe("ProjectEventSubscriptionHub", () => {
  test("pools a Project stream and refreshes every distinct consumer once per burst", () => {
    const projectListeners = new Map<string, () => void>();
    const scheduledFlushes: Array<() => void> = [];
    let subscribeCalls = 0;
    let unsubscribeCalls = 0;
    const hub = createProjectEventSubscriptionHub({
      subscribeToProject: (projectId, listener) => {
        subscribeCalls += 1;
        projectListeners.set(projectId, listener);
        return () => {
          unsubscribeCalls += 1;
          if (projectListeners.get(projectId) === listener) {
            projectListeners.delete(projectId);
          }
        };
      },
      schedule: (flush) => {
        scheduledFlushes.push(flush);
      },
    });

    const refreshCounts = new Map<string, number>();
    const unsubscribers: Array<() => void> = [];
    const register = (consumerKey: string): void => {
      unsubscribers.push(
        hub.subscribe("project-1", consumerKey, () => {
          refreshCounts.set(consumerKey, (refreshCounts.get(consumerKey) ?? 0) + 1);
        }),
      );
    };

    for (let index = 0; index < 10; index += 1) {
      register(`consumer:${index}`);
    }
    register("consumer:0");

    expect(subscribeCalls).toBe(1);
    projectListeners.get("project-1")?.();
    projectListeners.get("project-1")?.();
    expect(scheduledFlushes.length).toBe(1);

    scheduledFlushes.shift()?.();
    expect(refreshCounts.size).toBe(10);
    expect(refreshCounts.get("consumer:0")).toBe(1);

    for (const unsubscribe of unsubscribers.slice(0, -1)) unsubscribe();
    expect(unsubscribeCalls).toBe(0);
    projectListeners.get("project-1")?.();
    scheduledFlushes.shift()?.();
    expect(refreshCounts.get("consumer:0")).toBe(2);

    unsubscribers.at(-1)?.();
    expect(unsubscribeCalls).toBe(1);
    expect(projectListeners.size).toBe(0);
  });

  test("isolates Project streams and cancels a queued flush after last unmount", () => {
    const projectListeners = new Map<string, () => void>();
    const scheduledFlushes: Array<() => void> = [];
    const hub = createProjectEventSubscriptionHub({
      subscribeToProject: (projectId, listener) => {
        projectListeners.set(projectId, listener);
        return () => {
          projectListeners.delete(projectId);
        };
      },
      schedule: (flush) => {
        scheduledFlushes.push(flush);
      },
    });
    let alphaRefreshes = 0;
    let betaRefreshes = 0;
    const unsubscribeAlpha = hub.subscribe("alpha", "shared-key", () => {
      alphaRefreshes += 1;
    });
    hub.subscribe("beta", "shared-key", () => {
      betaRefreshes += 1;
    });

    projectListeners.get("alpha")?.();
    unsubscribeAlpha();
    scheduledFlushes.shift()?.();
    expect(alphaRefreshes).toBe(0);
    expect(betaRefreshes).toBe(0);

    projectListeners.get("beta")?.();
    scheduledFlushes.shift()?.();
    expect(alphaRefreshes).toBe(0);
    expect(betaRefreshes).toBe(1);
  });
});

describe("project page key editor model", () => {
  const settings = (
    overrides: Partial<DatabasePageKeyNamespaceV2> = {},
  ): DatabasePageKeyNamespaceV2 => ({
    databaseId: "database:test" as never,
    currentPrefix: "LAB",
    nextNumber: 8,
    assignedPageCount: 7,
    revision: 2,
    retiredPrefixes: [],
    ...overrides,
  });

  describe("Project Page-key editor model", () => {
    test("explains unused and used renames from authority settings", () => {
      const preview = {
        kind: "available" as const,
        prefix: "RND",
        availability: "available" as const,
        alternativePrefix: null,
        nextNumber: 8,
        exampleKeys: ["RND-8", "RND-9"],
      };
      const unused = projectPageKeyEditorModel({
        expanded: true,
        draftPrefix: "RND",
        currentPrefix: "LAB",
        preview,
        settings: settings({ assignedPageCount: 0, nextNumber: 1 }),
        settingsStatus: "ready",
      });
      expect(unused.canSubmit).toBe(true);
      expect(unused.impactText).toContain("old prefix will be released");

      const used = projectPageKeyEditorModel({
        expanded: true,
        draftPrefix: "RND",
        currentPrefix: "LAB",
        preview,
        settings: settings({
          retiredPrefixes: [{ prefix: "OLD", lastNumber: 4 }],
        }),
        settingsStatus: "ready",
      });
      expect(used.impactText).toContain("7 Pages");
      expect(used.impactText).toContain("keep working and remain reserved");
      expect(used.history).toEqual([
        {
          prefix: "OLD",
          detail: "Numbers through 4 still resolve",
        },
      ]);
    });

    test("keeps concurrency and reservation failures distinct", () => {
      const base = {
        expanded: true,
        draftPrefix: "RND",
        currentPrefix: "LAB",
        preview: {
          kind: "available" as const,
          prefix: "RND",
          availability: "available" as const,
          alternativePrefix: null,
          nextNumber: 8,
          exampleKeys: ["RND-8", "RND-9"],
        },
        settings: settings(),
        settingsStatus: "ready" as const,
      };
      expect(
        projectPageKeyEditorModel({
          ...base,
          saveFailure: {
            code: "identity_conflict",
            message: "reserved",
            retryable: false,
          },
        }).prefixError,
      ).toContain("claimed in another window");
      expect(
        projectPageKeyEditorModel({
          ...base,
          saveFailure: {
            code: "revision_conflict",
            message: "stale",
            retryable: false,
          },
        }).formError,
      ).toContain("changed in another window");
    });
  });
});

describe("project session query cache", () => {
  function createSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
    return {
      id: overrides.id ?? "session-1",
      projectId: overrides.projectId === undefined ? "project-1" : overrides.projectId,
      noThreadFallbackTitle: overrides.noThreadFallbackTitle ?? "Session",
      displayTitle: overrides.displayTitle ?? "Session",
      activityAt: overrides.activityAt ?? 0,
      pinned: overrides.pinned ?? false,
      managed: overrides.managed ?? false,
      pinnedOrder: overrides.pinnedOrder ?? null,
      archived: overrides.archived ?? false,
      archivedAt: overrides.archivedAt ?? null,
      snoozedUntil: overrides.snoozedUntil ?? null,
      snoozedAt: overrides.snoozedAt ?? null,
      wokeAt: overrides.wokeAt ?? null,
      pageTurn: overrides.pageTurn ?? null,
      canManage: true,
      canStop: true,
      unread: overrides.unread ?? false,
      thread: overrides.thread ?? null,
      executionRef: overrides.executionRef ?? null,
      createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    };
  }

  describe("project session query cache", () => {
    test("continues from the same cursor across revisions and deduplicates chats", () => {
      const first = projectSessionToSummary(createSession({ id: "first" }));
      const second = projectSessionToSummary(createSession({ id: "second" }));
      const base = {
        items: [first],
        totalCount: 4,
        nextCursor: "base",
        hasMore: true,
        projectionRevision: 4,
      };
      const next = {
        items: [first, second],
        totalCount: 5,
        nextCursor: "next",
        hasMore: true,
        projectionRevision: 5,
      };
      const appended = appendProjectSessionSummaryWindow(base, "base", next);
      expect(appended).toEqual({ ...next, items: [first, second] });
      const replaced = { ...base, nextCursor: "elsewhere" };
      expect(appendProjectSessionSummaryWindow(replaced, "base", next)).toBe(replaced);
      expect(
        appendProjectSessionSummaryWindow({ ...base, projectionRevision: 6 }, "base", next),
      ).toEqual({ ...next, items: [first, second], totalCount: 4, projectionRevision: 6 });
    });

    test("refills depth across short pages without giving an older head a newer revision", async () => {
      const items = Array.from({ length: 4 }, (_, index) =>
        projectSessionToSummary(createSession({ id: `chat-${index}` })),
      );
      const read = vi.fn(async (after: string | null, _first: number) => {
        const offset = after === null ? 0 : Number(after);
        return {
          items: items.slice(offset, offset + 1),
          totalCount: 4,
          nextCursor: String(offset + 1),
          hasMore: true,
          projectionRevision: 10 + offset,
        };
      });
      const refetched = await readProjectSessionSummaryWindowThrough({
        previousItemCount: () => 3,
        read,
      });

      expect(read.mock.calls).toEqual([
        [null, 50],
        ["1", 50],
        ["2", 50],
      ]);
      expect(refetched.items).toEqual(items.slice(0, 3));
      expect(refetched.nextCursor).toBe("3");

      const newer = { ...refetched, projectionRevision: 11 };
      expect(preferNewestProjectSessionSummaryWindow(newer, refetched)).toBe(newer);
    });
  });

  afterEach(() => vi.unstubAllGlobals());
});

describe("normalizeSourceRootKey", () => {
  test("lowercases and normalizes slashes", () => {
    expect(normalizeSourceRootKey("/Users/ASC/Repo")).toBe("/users/asc/repo");
    expect(normalizeSourceRootKey("C:\\Repo\\App")).toBe("c:/repo/app");
  });

  test("strips Windows long-path prefixes", () => {
    expect(normalizeSourceRootKey("\\\\?\\C:\\Repo")).toBe("c:/repo");
    expect(normalizeSourceRootKey("\\\\?\\UNC\\server\\share")).toBe("//server/share");
  });
});

describe("dedupeSourceRoots", () => {
  test("keeps first occurrence and drops case-insensitive duplicates", () => {
    expect(dedupeSourceRoots(["/repo/a", "/Repo/A", "/repo/b"])).toEqual(["/repo/a", "/repo/b"]);
  });

  test("treats backslash and forward-slash paths as the same folder", () => {
    expect(dedupeSourceRoots(["C:/repo", "C:\\repo"])).toEqual(["C:/repo"]);
  });

  test("drops empty and whitespace-only entries and trims the rest", () => {
    expect(dedupeSourceRoots(["", "  ", " /repo/a "])).toEqual(["/repo/a"]);
  });

  test("preserves order of distinct roots", () => {
    expect(dedupeSourceRoots(["/b", "/a", "/c"])).toEqual(["/b", "/a", "/c"]);
  });
});

describe("sourceRootDisplayName", () => {
  test("returns the last path segment", () => {
    expect(sourceRootDisplayName("/Users/asc/repo/nodex")).toBe("nodex");
    expect(sourceRootDisplayName("C:\\repo\\app")).toBe("app");
  });

  test("ignores trailing slashes", () => {
    expect(sourceRootDisplayName("/repo/nodex/")).toBe("nodex");
    expect(sourceRootDisplayName("/repo/nodex///")).toBe("nodex");
  });

  test("falls back to the normalized path for the filesystem root", () => {
    expect(sourceRootDisplayName("/")).toBe("/");
  });
});

describe("makeSourceRootPrimary", () => {
  test("moves the root to the front and keeps relative order", () => {
    expect(makeSourceRootPrimary(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });

  test("keeps an already-primary root stable", () => {
    expect(makeSourceRootPrimary(["/a", "/b"], "/a")).toEqual(["/a", "/b"]);
  });
});

describe("resolveReferencedProjectContext", () => {
  test("uses the referenced target Project instead of host shell metadata", () => {
    const context = resolveReferencedProjectContext("target-project", [
      {
        id: "host-project",
        name: "Host",
        primaryWorkspaceRoot: "/workspace/host",
      },
      {
        id: "target-project",
        name: "Target",
        primaryWorkspaceRoot: "/workspace/target",
      },
    ]);
    expect(context.projectName).toBe("Target");
    expect(context.projectWorkspacePath).toBe("/workspace/target");
  });

  test("falls back safely while the Project list is loading", () => {
    const context = resolveReferencedProjectContext("target-project", []);
    expect(context.projectName).toBe("target-project");
    expect(context.projectWorkspacePath === null).toBe(true);
  });
});

describe("use project page destination search", () => {
  const TEST_DATE = new Date("2026-07-25T00:00:00.000Z");

  function makeProject(id: string, name: string): Project {
    return {
      id,
      libraryId: "library:test",
      databaseId: `database:${id}`,
      defaultDatabaseViewId: `view:${id}`,
      lifecycle: "active",
      bindingRevision: 1,
      name,
      description: "",
      appearance: DEFAULT_PROJECT_APPEARANCE,
      sources: [],
      primaryWorkspaceRoot: null,
      pinned: false,
      pinnedOrder: null,
      created: TEST_DATE,
      updated: TEST_DATE,
    };
  }

  describe("Project Page destination search", () => {
    test("maps bounded Core search hits without hydrating every Project board", () => {
      const result = buildRemoteDestinationSearchResult({
        projects: [makeProject("alpha", "Alpha"), makeProject("beta", "Beta")],
        query: "release notes",
        results: [
          {
            projectId: "beta",
            pageId: "page:release",
            pageKey: "BETA-7",
            title: "Release notes",
            status: { optionId: "review", label: "Awaiting approval" },
            priority: null,
            tags: [],
            assignee: null,
            locationLabel: "Beta / Review",
            titleParts: [],
            excerpt: "Review release notes before shipping.",
            excerptParts: [],
            matches: [
              {
                source: "page_key",
                quality: "exact",
                pageKey: "BETA-7",
                isCurrent: true,
                parts: [],
              },
            ],
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
        ],
      });

      expect(result.pageHits).toEqual([
        {
          id: "page:beta:page:release",
          projectId: "beta",
          projectName: "Beta",
          projectAppearance: DEFAULT_PROJECT_APPEARANCE,
          columnId: "review",
          columnName: "Awaiting approval",
          pageId: "page:release",
          pageKey: "BETA-7",
          matchedPageKey: "BETA-7",
          matchedPageKeyIsCurrent: true,
          pageTitle: "Release notes",
        },
      ]);
    });
  });
});
