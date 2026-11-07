import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import * as Effect from "effect/Effect";
import type { NativeSessionBackendKind } from "../../shared/native-session-catalog";
import type {
  ProjectCandidate,
  ProjectCandidateChat,
  ProjectDiscoveryResult,
} from "../../shared/project-discovery";
import type { GitRepositoryIdentity } from "../platform/node/GitRepositoryProbe";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 30 * DAY_MS;
const SUGGESTED_MIN_CHATS = 3;
const MAX_CONVERSATIONS_PER_SOURCE = 500;
const MAX_CANDIDATES = 50;
const MAX_RECENT_CHATS_PER_PROJECT = 20;
const PROBE_CONCURRENCY = 8;

export interface ProjectDiscoverySource {
  readonly backendKind: NativeSessionBackendKind;
  readonly instanceConfigId?: string;
}

/** One newest-first page of a source's history, with already-copied chats marked. */
export interface ProjectDiscoveryPage {
  readonly nativeHome: string;
  readonly nextCursor: string | null;
  readonly entries: readonly {
    readonly nativeSessionId: string;
    readonly title: string;
    readonly cwd: string;
    readonly cwdAvailable?: boolean;
    readonly updatedAt: number;
    readonly importedThreadId?: string;
  }[];
}

export interface ProjectDiscoveryConversation extends ProjectCandidateChat {
  readonly imported: boolean;
}

/** `owner/name` for a hosted remote URL in any of its common spellings. */
export function repositoryFromRemoteUrl(url: string | null): string | null {
  if (!url) return null;
  const path = url
    .trim()
    .replace(/\.git\/?$/u, "")
    .replace(/\/+$/u, "")
    .replace(/^[a-z+]+:\/\/[^/]+\//iu, "")
    .replace(/^[^/@]+@[^:]+:/u, "");
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
}

const isInside = (folder: string, parent: string): boolean =>
  folder === parent || folder.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/** Scratch space, downloads and Agents' own homes are worked in but are not anyone's Project. */
export function isOfferedProjectFolder(
  folder: string,
  places: {
    readonly home: string;
    readonly nodexHome: string;
    readonly temporary: readonly string[];
  },
): boolean {
  if (folder === places.home) return false;
  const excluded = [
    places.nodexHome,
    join(places.home, "Downloads"),
    join(places.home, ".codex"),
    join(places.home, ".claude"),
    join(places.home, "Documents", "Codex"),
    ...places.temporary,
  ];
  return !excluded.some((parent) => isInside(folder, parent));
}

/** Groups conversations by the repository or folder they ran in, most useful first. */
export function projectCandidatesFromConversations(
  conversations: readonly ProjectDiscoveryConversation[],
  identities: ReadonlyMap<string, GitRepositoryIdentity | null>,
  now: number,
  home = "",
): readonly ProjectCandidate[] {
  const byFolder = new Map<
    string,
    {
      readonly identity: GitRepositoryIdentity | null;
      readonly conversations: ProjectDiscoveryConversation[];
    }
  >();
  for (const conversation of conversations) {
    const identity = identities.get(conversation.cwd) ?? null;
    const path = identity?.root ?? conversation.cwd;
    const group = byFolder.get(path) ?? { identity, conversations: [] };
    group.conversations.push(conversation);
    byFolder.set(path, group);
  }
  const recentSince = now - RECENT_WINDOW_MS;
  return Array.from(byFolder, ([path, group]): ProjectCandidate => {
    const newestFirst = group.conversations.toSorted(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    const lastActiveAt = newestFirst[0]?.updatedAt ?? 0;
    return {
      path,
      displayPath: home && isInside(path, home) ? `~${path.slice(home.length)}` : path,
      name: basename(path),
      repository: repositoryFromRemoteUrl(group.identity?.remoteUrl ?? null),
      isGitRepository: group.identity !== null,
      chatCount: newestFirst.length,
      lastActiveAt,
      suggested:
        group.identity !== null &&
        newestFirst.length >= SUGGESTED_MIN_CHATS &&
        lastActiveAt >= recentSince,
      recentChats: newestFirst
        .filter((conversation) => !conversation.imported && conversation.updatedAt >= recentSince)
        .slice(0, MAX_RECENT_CHATS_PER_PROJECT)
        .map(({ imported: _imported, ...chat }) => chat),
    };
  }).toSorted(
    (left, right) =>
      Number(right.isGitRepository) - Number(left.isGitRepository) ||
      right.lastActiveAt - left.lastActiveAt,
  );
}

/**
 * Reads the configured histories newest first and turns them into Project candidates. A history
 * that cannot be read contributes nothing; finding fewer Projects never blocks setup.
 */
export const discoverProjects = <E>(input: {
  readonly sources: readonly ProjectDiscoverySource[];
  readonly nodexHome: string;
  readonly home?: string;
  readonly now: number;
  readonly readPage: (
    source: ProjectDiscoverySource,
    cursor: string | null,
  ) => Effect.Effect<ProjectDiscoveryPage, E>;
  readonly probe: (cwd: string) => Effect.Effect<GitRepositoryIdentity | null>;
}): Effect.Effect<ProjectDiscoveryResult> =>
  Effect.gen(function* () {
    const places = {
      home: input.home ?? homedir(),
      nodexHome: input.nodexHome,
      temporary: ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", tmpdir()],
    };
    let truncated = false;
    const conversations = new Map<string, ProjectDiscoveryConversation>();
    for (const source of input.sources) {
      let cursor: string | null = null;
      let read = 0;
      do {
        const page: ProjectDiscoveryPage | null = yield* input
          .readPage(source, cursor)
          .pipe(Effect.orElseSucceed((): ProjectDiscoveryPage | null => null));
        if (!page) break;
        for (const entry of page.entries) {
          read += 1;
          if (entry.cwdAvailable === false) continue;
          if (!isOfferedProjectFolder(entry.cwd, places)) continue;
          conversations.set(`${source.backendKind}\n${page.nativeHome}\n${entry.nativeSessionId}`, {
            backendKind: source.backendKind,
            ...(source.instanceConfigId ? { instanceConfigId: source.instanceConfigId } : {}),
            nativeHome: page.nativeHome,
            nativeSessionId: entry.nativeSessionId,
            title: entry.title,
            cwd: entry.cwd,
            updatedAt: entry.updatedAt,
            imported: entry.importedThreadId !== undefined,
          });
        }
        cursor = page.nextCursor;
        if (cursor && read >= MAX_CONVERSATIONS_PER_SOURCE) {
          truncated = true;
          break;
        }
      } while (cursor);
    }
    const all = [...conversations.values()];
    const folders = [...new Set(all.map((conversation) => conversation.cwd))];
    const probed = yield* Effect.forEach(
      folders,
      (folder) => input.probe(folder).pipe(Effect.map((identity) => [folder, identity] as const)),
      { concurrency: PROBE_CONCURRENCY },
    );
    const candidates = projectCandidatesFromConversations(
      all,
      new Map(probed),
      input.now,
      places.home,
    );
    return {
      candidates: candidates.slice(0, MAX_CANDIDATES),
      truncated: truncated || candidates.length > MAX_CANDIDATES,
    };
  });
