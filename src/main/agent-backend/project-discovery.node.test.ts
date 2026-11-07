import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { GitRepositoryIdentity } from "../platform/node/GitRepositoryProbe";
import {
  discoverProjects,
  isOfferedProjectFolder,
  projectCandidatesFromConversations,
  repositoryFromRemoteUrl,
  type ProjectDiscoveryConversation,
  type ProjectDiscoveryPage,
} from "./project-discovery";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

const conversation = (
  id: string,
  cwd: string,
  updatedAt: number,
  overrides: Partial<ProjectDiscoveryConversation> = {},
): ProjectDiscoveryConversation => ({
  backendKind: "codex",
  nativeHome: "/home/.codex",
  nativeSessionId: id,
  title: id,
  cwd,
  updatedAt,
  imported: false,
  ...overrides,
});

const repository = (root: string, remoteUrl: string | null = null): GitRepositoryIdentity => ({
  root,
  remoteUrl,
});

describe("repositoryFromRemoteUrl", () => {
  it.each([
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets/", "acme/widgets"],
    ["ssh://git@example.com/group/sub/widgets", "sub/widgets"],
  ])("reads %s", (url, expected) => {
    expect(repositoryFromRemoteUrl(url)).toBe(expected);
  });

  it("has no answer without a recognizable path", () => {
    expect(repositoryFromRemoteUrl(null)).toBeNull();
    expect(repositoryFromRemoteUrl("https://example.com/widgets")).toBeNull();
  });
});

describe("isOfferedProjectFolder", () => {
  const home = resolve("/Users/me");
  const places = {
    home,
    nodexHome: join(home, ".nodex"),
    temporary: [tmpdir()],
  };

  it("offers ordinary work folders", () => {
    expect(isOfferedProjectFolder(join(home, "code", "widgets"), places)).toBe(true);
    expect(isOfferedProjectFolder(join(home, "Downloads-archive"), places)).toBe(true);
  });

  it.each([
    home,
    join(home, "Downloads", "thing"),
    join(home, ".codex", "worktrees", "abc"),
    join(home, ".claude", "projects"),
    join(home, ".nodex", "generated", "one"),
    join(home, "Documents", "Codex", "scratch"),
    join(tmpdir(), "experiment"),
  ])("does not offer %s", (folder) => {
    expect(isOfferedProjectFolder(folder, places)).toBe(false);
  });
});

describe("projectCandidatesFromConversations", () => {
  it("merges a repository's folders and linked worktrees into one candidate", () => {
    const main = repository("/code/widgets", "git@github.com:acme/widgets.git");
    const [candidate] = projectCandidatesFromConversations(
      [
        conversation("a", "/code/widgets", NOW - DAY),
        conversation("b", "/code/widgets/packages/ui", NOW - 2 * DAY),
        conversation("c", "/worktrees/widgets-fix", NOW - 3 * DAY),
      ],
      new Map([
        ["/code/widgets", main],
        ["/code/widgets/packages/ui", main],
        ["/worktrees/widgets-fix", main],
      ]),
      NOW,
    );
    expect(candidate).toMatchObject({
      path: "/code/widgets",
      name: "widgets",
      repository: "acme/widgets",
      chatCount: 3,
      lastActiveAt: NOW - DAY,
      suggested: true,
    });
    expect(candidate?.recentChats.map((chat) => chat.nativeSessionId)).toEqual(["a", "b", "c"]);
  });

  it("suggests only actively used Git repositories", () => {
    const identities = new Map([
      ["/code/few", repository("/code/few")],
      ["/code/old", repository("/code/old")],
      ["/notes", null],
    ]);
    const conversations = [
      conversation("few", "/code/few", NOW - DAY),
      ...["1", "2", "3"].map((id) => conversation(`old${id}`, "/code/old", NOW - 90 * DAY)),
      ...["1", "2", "3"].map((id) => conversation(`note${id}`, "/notes", NOW - DAY)),
    ];
    const byPath = new Map(
      projectCandidatesFromConversations(conversations, identities, NOW).map((candidate) => [
        candidate.path,
        candidate,
      ]),
    );
    expect(byPath.get("/code/few")?.suggested).toBe(false);
    expect(byPath.get("/code/old")?.suggested).toBe(false);
    expect(byPath.get("/notes")?.suggested).toBe(false);
  });

  it("shortens a path under the home directory", () => {
    const home = resolve("/home/me");
    const folder = join(home, "code", "a");
    const [candidate] = projectCandidatesFromConversations(
      [conversation("a", folder, NOW)],
      new Map(),
      NOW,
      home,
    );
    expect(candidate?.path).toBe(folder);
    expect(candidate?.displayPath).toBe(`~${sep}code${sep}a`);
  });

  it("lists Git repositories first, newest activity on top", () => {
    const candidates = projectCandidatesFromConversations(
      [
        conversation("folder", "/notes", NOW),
        conversation("older", "/code/older", NOW - 5 * DAY),
        conversation("newer", "/code/newer", NOW - DAY),
      ],
      new Map([
        ["/code/older", repository("/code/older")],
        ["/code/newer", repository("/code/newer")],
      ]),
      NOW,
    );
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "/code/newer",
      "/code/older",
      "/notes",
    ]);
  });

  it("leaves old and already-copied chats out of what can be brought in", () => {
    const [candidate] = projectCandidatesFromConversations(
      [
        conversation("recent", "/code/a", NOW - DAY),
        conversation("copied", "/code/a", NOW - DAY, { imported: true }),
        conversation("old", "/code/a", NOW - 60 * DAY),
      ],
      new Map([["/code/a", repository("/code/a")]]),
      NOW,
    );
    expect(candidate?.chatCount).toBe(3);
    expect(candidate?.recentChats.map((chat) => chat.nativeSessionId)).toEqual(["recent"]);
  });
});

describe("discoverProjects", () => {
  const page = (
    entries: ProjectDiscoveryPage["entries"],
    nextCursor: string | null = null,
  ): ProjectDiscoveryPage => ({ nativeHome: "/home/.codex", nextCursor, entries });
  const entry = (id: string, cwd: string, cwdAvailable = true) => ({
    nativeSessionId: id,
    title: id,
    cwd,
    cwdAvailable,
    updatedAt: NOW - DAY,
  });

  it.effect("reads every page, skipping folders that are gone or not Projects", () =>
    Effect.gen(function* () {
      const result = yield* discoverProjects({
        sources: [{ backendKind: "codex" }],
        nodexHome: "/home/.nodex",
        home: "/home",
        now: NOW,
        readPage: (_source, cursor) =>
          Effect.succeed(
            cursor === null
              ? page([entry("a", "/code/a"), entry("gone", "/code/gone", false)], "next")
              : page([entry("b", "/code/b"), entry("scratch", join(tmpdir(), "scratch"))]),
          ),
        probe: (cwd) => Effect.succeed(repository(cwd)),
      });
      expect(result.truncated).toBe(false);
      expect(result.candidates.map((candidate) => candidate.path).toSorted()).toEqual([
        "/code/a",
        "/code/b",
      ]);
    }),
  );

  it.effect("keeps what other histories found when one can't be read", () =>
    Effect.gen(function* () {
      const result = yield* discoverProjects({
        sources: [{ backendKind: "codex" }, { backendKind: "claude", instanceConfigId: "c" }],
        nodexHome: "/home/.nodex",
        home: "/home",
        now: NOW,
        readPage: (source) =>
          source.backendKind === "codex"
            ? Effect.fail("unreadable" as const)
            : Effect.succeed(page([entry("a", "/code/a")])),
        probe: () => Effect.succeed(null),
      });
      expect(result.candidates.map((candidate) => candidate.path)).toEqual(["/code/a"]);
    }),
  );

  it.effect("stops at its bound and says so", () =>
    Effect.gen(function* () {
      let reads = 0;
      const result = yield* discoverProjects({
        sources: [{ backendKind: "codex" }],
        nodexHome: "/home/.nodex",
        home: "/home",
        now: NOW,
        readPage: () => {
          reads += 1;
          return Effect.succeed(
            page(
              Array.from({ length: 50 }, (_, index) => entry(`${reads}-${index}`, "/code/a")),
              "more",
            ),
          );
        },
        probe: (cwd) => Effect.succeed(repository(cwd)),
      });
      expect(result.truncated).toBe(true);
      expect(reads).toBe(10);
    }),
  );
});
