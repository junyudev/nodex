import path from "node:path";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FILE_SEARCH_EXCLUDED_SEGMENTS } from "../../shared/file-search";
import type { FileWatchHost } from "../file-watch-host";
import { WorkspaceFileListing } from "../platform/node/WorkspaceFileListing";
import type {
  FileIndexSessionOutcome,
  FileIndexWorkerThreadMessage,
} from "./file-index-worker-protocol";
import { FileSearchRanking } from "./file-search-ranking";
import {
  parentDirectory,
  WorkspaceFileIndex,
  type FileIndexCapacity,
} from "./workspace-file-index";

/**
 * One root holds at most what one search scope could hold before indexes were shared; all
 * resident roots together hold at most twice that. Idle roots make room first.
 */
export const FILE_INDEX_LIMITS = {
  root: { entries: 150_000, pathUnits: 16 * 1024 * 1024 },
  resident: { entries: 300_000, pathUnits: 32 * 1024 * 1024 },
} as const satisfies Record<"root" | "resident", FileIndexCapacity>;

export const FILE_INDEX_TIMINGS = {
  /** How long a root with no open search stays indexed and watched. */
  idleRelease: Duration.minutes(5),
  /** File changes are applied once they have been quiet this long... */
  changeSettle: Duration.millis(100),
  /** ...or once they have waited this long. */
  changeMaxDelay: Duration.seconds(1),
  watchRetry: Duration.seconds(5),
  publishInterval: Duration.millis(32),
} as const;

const RANKING_BATCH_SIZE = 512;
/** Beyond these, applying individual changes costs more than listing the root again. */
const MAX_CHANGED_PATHS = 1_024;
const MAX_REFRESHED_DIRECTORIES = 64;
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set(FILE_SEARCH_EXCLUDED_SEGMENTS);
const IGNORE_FILES = new Set([".gitignore", ".ignore", ".rgignore"]);

type RootStatus = "building" | "ready" | "failed";

interface RootIndex {
  readonly root: string;
  readonly index: WorkspaceFileIndex;
  readonly scope: Scope.Closeable;
  readonly wake: Queue.Queue<void>;
  status: RootStatus;
  watch: "pending" | "active" | "unavailable";
  sessions: number;
  releasedAt: number;
  /** Replaced each time the first listing makes progress. */
  progress: Deferred.Deferred<void>;
  changes: Set<string> | "all";
  lastChangeAt: number;
}

interface Session {
  readonly roots: readonly RootIndex[];
  seq: number;
}

interface Refresh {
  /** Root-relative directory; empty is the root. */
  readonly directory: string;
  /** `direct` relists the directory's own files and any folder not yet indexed below it. */
  readonly depth: "direct" | "tree";
}

export interface FileIndexRootState {
  readonly root: string;
  readonly status: RootStatus;
  readonly watch: RootIndex["watch"];
  readonly sessions: number;
  readonly entries: number;
  readonly pathUnits: number;
}

export interface FileIndexModule {
  readonly open: (sessionId: string, roots: readonly string[]) => Effect.Effect<void>;
  /** Supersedes the session's previous query; an empty query only stops its ranking. */
  readonly query: (sessionId: string, seq: number, query: string) => Effect.Effect<void>;
  readonly close: (sessionId: string) => Effect.Effect<void>;
  readonly inspect: Effect.Effect<readonly FileIndexRootState[]>;
}

export interface FileIndexModuleOptions {
  readonly platform: string;
  readonly watchHost: FileWatchHost;
  readonly publish: (message: FileIndexWorkerThreadMessage) => void;
  readonly limits?: Record<"root" | "resident", FileIndexCapacity>;
  readonly timings?: Partial<Record<keyof typeof FILE_INDEX_TIMINGS, Duration.Input>>;
  /** Observes each root after its watched changes have been applied. */
  readonly onUpdated?: (state: FileIndexRootState) => Effect.Effect<void>;
}

const stateOf = (root: RootIndex): FileIndexRootState => ({
  root: root.root,
  status: root.status,
  watch: root.watch,
  sessions: root.sessions,
  entries: root.index.size,
  pathUnits: root.index.pathUnits,
});
const covers = (ancestor: string, directory: string) =>
  ancestor === "" || directory === ancestor || directory.startsWith(`${ancestor}/`);
const depthOf = (directory: string) => (directory ? directory.split("/").length : 0);

/** A watched change, as a root-relative path, when it can change which names are searchable. */
export function relevantChange(root: string, changed: string): string | null {
  const relative = path.relative(root, changed);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  const segments = relative ? relative.split(path.sep) : [];
  const excluded = segments.findIndex((segment) => EXCLUDED_SEGMENTS.has(segment));
  if (excluded >= 0) {
    // Creating a repository or editing its excludes changes the ignore rules around it.
    const [first, ...rest] = segments.slice(excluded);
    const repository = first === ".git" && (rest.length === 0 || rest.join("/") === "info/exclude");
    if (!repository) return null;
  }
  return segments.join("/");
}

/**
 * Owns one shared index per searched root. Sessions over the same root rank the same entries;
 * file changes update the index in place, and roots nobody searches are released after a while.
 */
export const makeFileIndexModule = Effect.fn("FileIndexModule.make")(function* (
  options: FileIndexModuleOptions,
) {
  const listing = yield* WorkspaceFileListing;
  const moduleScope = yield* Scope.Scope;
  const limits = options.limits ?? FILE_INDEX_LIMITS;
  const timings = { ...FILE_INDEX_TIMINGS, ...options.timings };
  const settleMillis = Duration.toMillis(timings.changeSettle);
  const maxDelayMillis = Duration.toMillis(timings.changeMaxDelay);
  const publishMillis = Duration.toMillis(timings.publishInterval);
  const windowsPaths = options.platform === "win32";
  const onUpdated = options.onUpdated ?? (() => Effect.void);
  const roots = new Map<string, RootIndex>();
  const sessions = new Map<string, Session>();
  const rankings = yield* FiberMap.make<string>();
  const idleReleases = yield* FiberMap.make<string>();

  const resident = (except?: RootIndex) => {
    let entries = 0;
    let pathUnits = 0;
    for (const root of roots.values()) {
      if (root === except) continue;
      entries += root.index.size;
      pathUnits += root.index.pathUnits;
    }
    return { entries, pathUnits };
  };
  const capacityFor = (root: RootIndex): FileIndexCapacity => {
    const others = resident(root);
    return {
      entries: Math.min(limits.root.entries, limits.resident.entries - others.entries),
      pathUnits: Math.min(limits.root.pathUnits, limits.resident.pathUnits - others.pathUnits),
    };
  };

  const signal = Effect.fnUntraced(function* (root: RootIndex) {
    const previous = root.progress;
    root.progress = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });

  const closeRoot = Effect.fnUntraced(function* (root: RootIndex) {
    if (roots.get(root.root) === root) roots.delete(root.root);
    yield* Scope.close(root.scope, Exit.void);
  });

  /** A new root may need a full root's room; idle roots give it up, least recently used first. */
  const makeRoom = Effect.fnUntraced(function* () {
    while (true) {
      const used = resident();
      if (
        used.entries + limits.root.entries <= limits.resident.entries &&
        used.pathUnits + limits.root.pathUnits <= limits.resident.pathUnits
      )
        return;
      const idle = [...roots.values()]
        .filter((root) => root.sessions === 0)
        .sort((left, right) => left.releasedAt - right.releasedAt)[0];
      if (!idle) return;
      yield* FiberMap.remove(idleReleases, idle.root);
      yield* closeRoot(idle);
    }
  });

  const noteChanges = Effect.fnUntraced(function* (
    root: RootIndex,
    changed: readonly string[] | null,
  ) {
    let relevant = changed === null || changed.length === 0;
    if (relevant) root.changes = "all";
    else if (root.changes !== "all") {
      for (const absolute of changed!) {
        const relative = relevantChange(root.root, absolute);
        if (relative === null) continue;
        relevant = true;
        root.changes.add(relative);
        if (root.changes.size > MAX_CHANGED_PATHS) {
          root.changes = "all";
          break;
        }
      }
    } else relevant = changed!.some((absolute) => relevantChange(root.root, absolute) !== null);
    if (!relevant) return;
    root.lastChangeAt = yield* Clock.currentTimeMillis;
    yield* Queue.offer(root.wake, undefined);
  });

  const watch = Effect.fnUntraced(function* (root: RootIndex, attempted: Deferred.Deferred<void>) {
    let recovering = false;
    yield* Effect.forever(
      options.watchHost
        .watch({ path: root.root, recursive: true, renameEventHandling: "changed-path" })
        .pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event._tag === "Ready") {
                root.watch = "active";
                // Changes made while the root was not watched are unknown.
                if (recovering) yield* noteChanges(root, null);
                recovering = true;
                yield* Deferred.succeed(attempted, undefined);
                return;
              }
              yield* noteChanges(root, event.changedPaths);
            }),
          ),
          Effect.catch((error) => Effect.logWarning("Could not watch workspace files", error)),
          Effect.andThen(
            Effect.gen(function* () {
              root.watch = "unavailable";
              recovering = true;
              yield* Deferred.succeed(attempted, undefined);
              yield* Effect.sleep(timings.watchRetry);
            }),
          ),
        ),
    );
  });

  const listInto = (root: RootIndex, directory: string, excludedDirectories: readonly string[]) =>
    Effect.gen(function* () {
      const listed: string[] = [];
      yield* listing.list({
        root: root.root,
        directory,
        excludedDirectories,
        onPaths: (paths) =>
          Effect.sync(() => {
            for (const raw of paths) {
              const normalized = root.index.normalize(raw);
              if (normalized !== null) listed.push(normalized);
            }
            return listed.length <= limits.root.entries;
          }),
      });
      return listed;
    });

  /** Applies one refresh; a directory that disappeared hands the work to its parent. */
  const refresh = Effect.fnUntraced(function* (root: RootIndex, target: Refresh) {
    const { index } = root;
    const children = yield* listing.readDirectory(path.join(root.root, target.directory));
    if (children === null) {
      index.removeTree(target.directory);
      if (!target.directory) return null;
      return { directory: index.indexedAncestor(target.directory), depth: "direct" } as const;
    }
    let excluded: string[] = [];
    if (target.depth === "direct") {
      const kinds = new Map(children.map((child) => [child.name, child.kind]));
      for (const directory of index.subdirectories(target.directory)) {
        const kind = kinds.get(directory.slice(directory.lastIndexOf("/") + 1));
        if (kind === undefined || kind === "file") index.removeTree(directory);
      }
      // Folders that are already indexed keep their own entries; only new folders are walked.
      excluded = index.subdirectories(target.directory);
    }
    const listed = yield* listInto(root, target.directory, excluded);
    index.reconcile(target.directory, target.depth, listed, capacityFor(root));
    return null;
  });

  const planRefreshes = Effect.fnUntraced(function* (
    root: RootIndex,
    changes: ReadonlySet<string> | "all",
  ) {
    const full: Refresh[] = [{ directory: "", depth: "tree" }];
    if (changes === "all") return full;
    const { index } = root;
    const trees = new Set<string>();
    const directs = new Set<string>();
    const around = (directory: string) => {
      if (!directory || index.hasDirectory(directory)) trees.add(directory);
      else directs.add(index.indexedAncestor(directory));
    };
    for (const change of changes) {
      const segments = change.split("/");
      if (!change) trees.add("");
      else if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)))
        around(segments.slice(0, segments.indexOf(".git")).join("/"));
      else if (IGNORE_FILES.has(segments.at(-1)!)) around(parentDirectory(change));
      else {
        // A path that cannot be inspected is left for its folder's listing to decide.
        const kind = yield* listing
          .pathKind(path.join(root.root, change))
          .pipe(Effect.orElseSucceed(() => "other" as const));
        if (kind === null) {
          // Removed names leave without a listing.
          if (!index.remove(change)) index.removeTree(change);
          continue;
        }
        // A file whose contents changed keeps its name.
        if (kind === "file" && index.hasFile(change)) continue;
        if (kind === "file") index.removeTree(change);
        directs.add(index.indexedAncestor(change));
      }
    }
    const keptTrees: string[] = [];
    for (const tree of [...trees].sort((left, right) => depthOf(left) - depthOf(right)))
      if (!keptTrees.some((kept) => covers(kept, tree))) keptTrees.push(tree);
    const keptDirects = [...directs]
      .filter((directory) => !keptTrees.some((tree) => covers(tree, directory)))
      .sort((left, right) => depthOf(right) - depthOf(left));
    if (keptTrees.length + keptDirects.length > MAX_REFRESHED_DIRECTORIES) return full;
    return [
      ...keptTrees.map((directory): Refresh => ({ directory, depth: "tree" })),
      ...keptDirects.map((directory): Refresh => ({ directory, depth: "direct" })),
    ];
  });

  const maintain = (root: RootIndex) =>
    Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(root.wake);
        const started = yield* Clock.currentTimeMillis;
        while (true) {
          yield* Effect.sleep(timings.changeSettle);
          const now = yield* Clock.currentTimeMillis;
          if (now - root.lastChangeAt >= settleMillis || now - started >= maxDelayMillis) break;
        }
        yield* Queue.clear(root.wake);
        const changes = root.changes;
        root.changes = new Set();
        const pending = [...(yield* planRefreshes(root, changes))];
        const planned = new Set(pending.map((item) => `${item.depth}\0${item.directory}`));
        while (pending.length > 0) {
          const next = yield* refresh(root, pending.shift()!).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not update workspace files", error).pipe(Effect.as(null)),
            ),
          );
          if (next && !planned.has(`${next.depth}\0${next.directory}`)) {
            planned.add(`${next.depth}\0${next.directory}`);
            pending.push(next);
          }
        }
        yield* onUpdated(stateOf(root));
      }).pipe(
        Effect.catch((error) => Effect.logWarning("Could not update workspace files", error)),
      ),
    );

  const build = Effect.fnUntraced(function* (root: RootIndex) {
    const attempted = yield* Deferred.make<void>();
    yield* watch(root, attempted).pipe(Effect.forkIn(root.scope));
    // Watching first means no change between listing and watching is missed.
    yield* Deferred.await(attempted);
    const listed = yield* listing
      .list({
        root: root.root,
        directory: "",
        excludedDirectories: [],
        onPaths: (paths) =>
          Effect.gen(function* () {
            const capacity = capacityFor(root);
            let room = true;
            for (const raw of paths) {
              const normalized = root.index.normalize(raw);
              if (normalized === null) continue;
              if (root.index.add(normalized, capacity) === "full") {
                room = false;
                break;
              }
            }
            yield* signal(root);
            return room;
          }),
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(listed)) {
      // Open searches report the failure; the next search lists the root again.
      root.status = "failed";
      if (roots.get(root.root) === root) roots.delete(root.root);
      yield* signal(root);
      yield* Effect.logWarning("Could not index workspace files", listed.cause);
      yield* Scope.close(root.scope, Exit.void).pipe(Effect.forkIn(moduleScope));
      return;
    }
    root.index.finishBuilding();
    root.status = "ready";
    yield* signal(root);
    yield* maintain(root);
  });

  const acquire = Effect.fnUntraced(function* (rootPath: string) {
    const existing = roots.get(rootPath);
    if (existing) {
      existing.sessions++;
      yield* FiberMap.remove(idleReleases, rootPath);
      return existing;
    }
    yield* makeRoom();
    const root: RootIndex = {
      root: rootPath,
      index: new WorkspaceFileIndex(windowsPaths),
      scope: yield* Scope.fork(moduleScope),
      wake: yield* Queue.sliding<void>(1),
      status: "building",
      watch: "pending",
      sessions: 1,
      releasedAt: 0,
      progress: yield* Deferred.make<void>(),
      changes: new Set(),
      lastChangeAt: 0,
    };
    roots.set(rootPath, root);
    yield* build(root).pipe(Effect.forkIn(root.scope));
    return root;
  });

  const release = Effect.fnUntraced(function* (root: RootIndex) {
    root.sessions--;
    if (root.sessions > 0 || roots.get(root.root) !== root) return;
    root.releasedAt = yield* Clock.currentTimeMillis;
    // Without a watch the index cannot stay current, so the next search lists the root again.
    if (root.watch === "unavailable") return yield* closeRoot(root);
    yield* FiberMap.run(
      idleReleases,
      root.root,
      Effect.sleep(timings.idleRelease).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            root.sessions === 0 && roots.get(root.root) === root ? closeRoot(root) : Effect.void,
          ),
        ),
      ),
    );
  });

  const rank = Effect.fnUntraced(function* (
    sessionId: string,
    session: Session,
    seq: number,
    query: string,
  ) {
    const ranking = new FileSearchRanking(query);
    let publishedAt = -Infinity;
    const publish = (outcome: FileIndexSessionOutcome) =>
      Effect.sync(() => {
        if (session.seq === seq) options.publish({ type: "session", sessionId, seq, outcome });
      });
    const publishMatches = Effect.gen(function* () {
      yield* publish({ kind: "updated", files: ranking.results() });
      publishedAt = yield* Clock.currentTimeMillis;
    });
    const publishProgress = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (ranking.dirty && ranking.size > 0 && now - publishedAt >= publishMillis)
        yield* publishMatches;
    });
    for (const root of session.roots) {
      // A finished listing is never edited in place, so this list stays consistent.
      const entries = root.index.entries();
      let offset = 0;
      while (true) {
        const progress = root.progress;
        const end = Math.min(entries.length, offset + RANKING_BATCH_SIZE);
        ranking.scan(root.root, entries, offset, end);
        offset = end;
        if (root.status === "failed") return yield* publish({ kind: "failed" });
        if (offset === entries.length && root.status !== "building") break;
        yield* publishProgress;
        if (offset < entries.length) yield* Effect.yieldNow;
        else yield* Deferred.await(progress);
      }
    }
    if (ranking.dirty) yield* publishMatches;
    yield* publish({ kind: "completed" });
  });

  const open = Effect.fn("FileIndexModule.open")(function* (
    sessionId: string,
    rootPaths: readonly string[],
  ) {
    if (sessions.has(sessionId)) return;
    const acquired: RootIndex[] = [];
    for (const rootPath of new Set(rootPaths)) acquired.push(yield* acquire(rootPath));
    sessions.set(sessionId, { roots: acquired, seq: -1 });
  });

  const query = Effect.fn("FileIndexModule.query")(function* (
    sessionId: string,
    seq: number,
    text: string,
  ) {
    const session = sessions.get(sessionId);
    if (!session) {
      if (text) options.publish({ type: "session", sessionId, seq, outcome: { kind: "failed" } });
      return;
    }
    session.seq = seq;
    if (!text) return yield* FiberMap.remove(rankings, sessionId);
    yield* FiberMap.run(rankings, sessionId, rank(sessionId, session, seq, text));
  });

  const close = Effect.fn("FileIndexModule.close")(function* (sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.seq = -1;
    yield* FiberMap.remove(rankings, sessionId);
    for (const root of session.roots) yield* release(root);
  });

  const inspect = Effect.sync(() => [...roots.values()].map(stateOf));

  return { open, query, close, inspect } satisfies FileIndexModule;
});
