import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  BrowserSidebarCommand,
  BrowserSidebarLocalServer,
  BrowserSidebarLocalServerRoute,
  BrowserSidebarLocalServersSnapshot,
} from "../../shared/browser-sidebar";
import type { ElectronNetError } from "../platform/electron/ElectronNet";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

const LOCAL_SERVER_URL_PATTERN =
  /(?:https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/[^\s"'<>]*)?|(?:localhost|127(?:\.\d{1,3}){3})(?::\d+)(?:\/[^\s"'<>]*)?)/giu;

export type BrowserLocalServerCommand = Extract<
  BrowserSidebarCommand,
  {
    readonly type:
      | "local-servers-refresh"
      | "hide-local-server"
      | "unhide-local-server"
      | "remove-local-server-route";
  }
>;

interface LocalServerProjectState {
  readonly projectId: string;
  readonly isLoading: boolean;
  readonly servers: HashMap.HashMap<string, BrowserSidebarLocalServer>;
  readonly hiddenServerIds: HashSet.HashSet<string>;
  readonly hiddenRouteIds: HashSet.HashSet<string>;
  readonly updatedAt: number;
  readonly refreshGeneration: number;
}

export interface BrowserLocalServerRuntimeOptions {
  readonly fetch: (input: string, init: RequestInit) => Effect.Effect<Response, ElectronNetError>;
  readonly invalidateThumbnail: (url?: string) => Effect.Effect<void>;
}

export interface BrowserLocalServerRuntime {
  readonly updates: Stream.Stream<BrowserSidebarLocalServersSnapshot>;
  readonly snapshot: (projectId: string) => Effect.Effect<BrowserSidebarLocalServersSnapshot>;
  readonly observePtyData: (projectId: string, data: string) => Effect.Effect<void>;
  readonly applyCommand: (command: BrowserLocalServerCommand) => Effect.Effect<void>;
  readonly isDiscovered: (projectId: string, url: string) => Effect.Effect<boolean>;
  readonly closeProject: (projectId: string) => Effect.Effect<void>;
}

const initialProject = (projectId: string, now: number): LocalServerProjectState => ({
  projectId,
  isLoading: false,
  servers: HashMap.empty(),
  hiddenServerIds: HashSet.empty(),
  hiddenRouteIds: HashSet.empty(),
  updatedAt: now,
  refreshGeneration: 0,
});

const withHiddenState = (
  state: LocalServerProjectState,
  updatedAt: number,
): LocalServerProjectState => ({
  ...state,
  updatedAt,
  servers: HashMap.fromIterable(
    [...HashMap.values(state.servers)].map((server) => [
      server.id,
      {
        ...server,
        hidden: HashSet.has(state.hiddenServerIds, server.id),
        routes: server.routes.map((route) => ({
          ...route,
          hidden: HashSet.has(state.hiddenRouteIds, route.id),
        })),
      },
    ]),
  ),
});

const toSnapshot = (state: LocalServerProjectState): BrowserSidebarLocalServersSnapshot => ({
  projectId: state.projectId,
  isLoading: state.isLoading,
  servers: [...HashMap.values(state.servers)]
    .map((server) => ({
      ...server,
      routes: [...server.routes].sort((left, right) => right.lastSeenAt - left.lastSeenAt),
    }))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt),
  hiddenServerIds: [...state.hiddenServerIds],
  hiddenRouteIds: [...state.hiddenRouteIds],
  updatedAt: state.updatedAt,
});

export const isBrowserLocalServerCommand = (
  command: BrowserSidebarCommand,
): command is BrowserLocalServerCommand =>
  command.type === "local-servers-refresh" ||
  command.type === "hide-local-server" ||
  command.type === "unhide-local-server" ||
  command.type === "remove-local-server-route";

export const projectSessionIdFromTerminalSessionId = (terminalSessionId: string): string | null => {
  if (!terminalSessionId.startsWith("session:")) return null;
  const suffixIndex = terminalSessionId.lastIndexOf(":terminal:");
  if (suffixIndex <= "session:".length) return null;
  return terminalSessionId.slice("session:".length, suffixIndex);
};

export const makeBrowserLocalServerRuntime = (
  options: BrowserLocalServerRuntimeOptions,
): Effect.Effect<BrowserLocalServerRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const projects = yield* Ref.make(HashMap.empty<string, LocalServerProjectState>());
    const mutations = yield* Semaphore.make(1);
    const updates = yield* PubSub.sliding<BrowserSidebarLocalServersSnapshot>(
      MAIN_OBSERVATION_EVENT_CAPACITY,
    );
    yield* Effect.addFinalizer(() => PubSub.shutdown(updates));

    const publish = (state: LocalServerProjectState) =>
      PubSub.publish(updates, toSnapshot(state)).pipe(Effect.asVoid);
    const updateProject = <A>(
      projectId: string,
      mutate: (
        state: LocalServerProjectState,
        now: number,
      ) => readonly [A, LocalServerProjectState],
    ): Effect.Effect<A> =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const current = yield* Ref.get(projects);
          const project = Option.getOrElse(HashMap.get(current, projectId), () =>
            initialProject(projectId, now),
          );
          const [result, next] = mutate(project, now);
          yield* Ref.set(projects, HashMap.set(current, projectId, next));
          yield* publish(next);
          return result;
        }),
      );
    const probe = (origin: string) =>
      options.fetch(origin, { method: "HEAD" }).pipe(
        Effect.map((response) => response.status < 500),
        Effect.timeoutOrElse({ duration: "750 millis", orElse: () => Effect.succeed(false) }),
        Effect.catch(() => Effect.succeed(false)),
      );
    const refresh = (projectId: string) =>
      Effect.gen(function* () {
        const admission = yield* updateProject(projectId, (state, now) => {
          const generation = state.refreshGeneration + 1;
          const servers = [...HashMap.values(state.servers)];
          return [
            { generation, servers },
            {
              ...state,
              isLoading: servers.length > 0,
              refreshGeneration: generation,
              updatedAt: now,
            },
          ] as const;
        });
        if (admission.servers.length === 0) return;
        const results = yield* Effect.forEach(
          admission.servers,
          (server) =>
            probe(server.origin).pipe(Effect.map((online) => ({ id: server.id, online }))),
          { concurrency: 8 },
        );
        yield* mutations.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(projects);
            const state = Option.getOrUndefined(HashMap.get(current, projectId));
            if (!state || state.refreshGeneration !== admission.generation) return;
            const now = yield* Clock.currentTimeMillis;
            let servers = state.servers;
            for (const result of results) {
              const server = Option.getOrUndefined(HashMap.get(servers, result.id));
              if (!server) continue;
              servers = HashMap.set(servers, result.id, {
                ...server,
                online: result.online,
                lastSeenAt: result.online ? now : server.lastSeenAt,
              });
            }
            const next = withHiddenState({ ...state, isLoading: false, servers }, now);
            yield* Ref.set(projects, HashMap.set(current, projectId, next));
            yield* publish(next);
          }),
        );
      });

    return {
      updates: Stream.fromPubSub(updates),
      snapshot: (projectId) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(projects);
          const state = Option.getOrUndefined(HashMap.get(current, projectId));
          return toSnapshot(state ?? initialProject(projectId, yield* Clock.currentTimeMillis));
        }),
      observePtyData: (projectId, data) =>
        Effect.gen(function* () {
          const matches = data.match(LOCAL_SERVER_URL_PATTERN);
          if (!matches || matches.length === 0) return;
          const parsed = matches.flatMap(parseLocalServerUrl);
          if (parsed.length === 0) return;
          yield* updateProject(projectId, (state, now) => {
            let servers = state.servers;
            for (const url of parsed) {
              const origin = url.origin;
              const serverId = origin;
              const routePath = url.pathname || "/";
              const routeId = makeLocalServerRouteId(origin, routePath);
              const existing = Option.getOrUndefined(HashMap.get(servers, serverId));
              const routes = existing?.routes ?? [];
              const route: BrowserSidebarLocalServerRoute = {
                id: routeId,
                path: routePath,
                title: routePath === "/" ? origin : routePath,
                lastSeenAt: now,
                hidden: HashSet.has(state.hiddenRouteIds, routeId),
              };
              const routeIndex = routes.findIndex((candidate) => candidate.id === routeId);
              const nextRoutes =
                routeIndex < 0
                  ? [...routes, route]
                  : routes.map((candidate, index) => (index === routeIndex ? route : candidate));
              servers = HashMap.set(servers, serverId, {
                id: serverId,
                origin,
                host: url.hostname,
                port: Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10),
                protocol: url.protocol === "https:" ? "https:" : "http:",
                lastSeenAt: now,
                online: true,
                hidden: HashSet.has(state.hiddenServerIds, serverId),
                routes: nextRoutes.sort((left, right) => right.lastSeenAt - left.lastSeenAt),
              });
            }
            return [undefined, { ...state, isLoading: false, servers, updatedAt: now }] as const;
          });
          yield* Effect.forEach(
            new Set(
              parsed.flatMap((url) =>
                url.href === url.origin ? [url.origin] : [url.origin, url.href],
              ),
            ),
            (url) => options.invalidateThumbnail(url),
            { discard: true },
          );
        }),
      applyCommand: (command) => {
        if (command.type === "local-servers-refresh") return refresh(command.projectId);
        if (command.type === "hide-local-server") {
          return updateProject(command.projectId, (state, now) => {
            const serverId = readLocalServerOrigin(command.server.origin);
            const next = withHiddenState(
              { ...state, hiddenServerIds: HashSet.add(state.hiddenServerIds, serverId) },
              now,
            );
            return [undefined, next] as const;
          });
        }
        if (command.type === "unhide-local-server") {
          return updateProject(command.projectId, (state, now) => {
            const serverId = readLocalServerOrigin(command.url);
            const next = withHiddenState(
              { ...state, hiddenServerIds: HashSet.remove(state.hiddenServerIds, serverId) },
              now,
            );
            return [undefined, next] as const;
          });
        }
        return updateProject(command.projectId, (state, now) => {
          const serverOrigin = readLocalServerOrigin(command.serverUrl);
          const serverId = serverOrigin;
          const routeId = makeLocalServerRouteId(
            serverOrigin,
            normalizeRoutePath(command.routeUrl),
          );
          const server = Option.getOrUndefined(HashMap.get(state.servers, serverId));
          const servers = server
            ? HashMap.set(state.servers, serverId, {
                ...server,
                routes: server.routes.filter((route) => route.id !== routeId),
              })
            : state.servers;
          const next = withHiddenState(
            { ...state, servers, hiddenRouteIds: HashSet.add(state.hiddenRouteIds, routeId) },
            now,
          );
          return [undefined, next] as const;
        });
      },
      isDiscovered: (projectId, value) =>
        Ref.get(projects).pipe(
          Effect.map((current) => {
            const project = Option.getOrUndefined(HashMap.get(current, projectId));
            if (!project) return false;
            const origin = readLocalServerOrigin(value);
            return HashMap.has(project.servers, origin);
          }),
        ),
      closeProject: (projectId) =>
        mutations.withPermits(1)(
          Ref.update(projects, (current) => HashMap.remove(current, projectId)),
        ),
    } satisfies BrowserLocalServerRuntime;
  });

const parseLocalServerUrl = (value: string): URL[] => {
  try {
    const url = new URL(value || "about:blank");
    return isLocalServerUrl(url) ? [url] : [];
  } catch {
    return [];
  }
};

const isLocalServerUrl = (url: URL): boolean =>
  url.hostname === "localhost" ||
  url.hostname === "127.0.0.1" ||
  url.hostname === "::1" ||
  url.hostname === "[::1]";

const readLocalServerOrigin = (value: string): string => {
  try {
    return new URL(value || "about:blank").origin;
  } catch {
    return value;
  }
};

const normalizeRoutePath = (value: string): string => {
  try {
    const normalized = value.trim();
    const url = URL.canParse(normalized)
      ? new URL(normalized)
      : new URL(normalized, "http://localhost");
    return url.pathname || "/";
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
};

const makeLocalServerRouteId = (origin: string, pathname: string): string =>
  `${origin}${pathname || "/"}`;
