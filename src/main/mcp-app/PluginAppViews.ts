import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Semaphore from "effect/Semaphore";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";
import type { PluginMcpBrokerService } from "../../host/agent-plugins/broker/contract";
import {
  derivePluginAppEntrypoints,
  pluginAppFileName,
  pluginAppLaunchInput,
  pluginAppMatchesFile,
  type PluginAppBinding,
  type PluginAppCatalogEntry,
} from "../../shared/agent-plugins/app-entrypoints";
import {
  includesProject,
  pluginRevision,
  runnableServer,
  type CatalogPlugin,
} from "../../host/agent-plugins/PluginCatalog";
import type {
  AgentPluginFailure,
  PluginAppLaunch,
  PluginAppViewEvent,
} from "../../shared/agent-plugins/ipc";
import type {
  PluginMcpLease,
  PluginMcpLeaseScope,
  PluginMcpProject,
} from "../../shared/agent-plugins/mcp-lease";
import {
  isMcpAppHtmlTooLarge,
  resolveMcpRenderableResource,
} from "../../shared/mcp-app/mcp-app-resource-contract";
import { localFileWatchHost } from "../file-watch-host";
import type { WorkspaceFileQueries } from "../host-runtime/WorkspaceFileQueries";
import { pluginFileReadResult, resolvePluginFileResourceRequest } from "./plugin-app-file-resource";

type ViewOwner = {
  readonly generation: string;
  readonly windowId: number;
  readonly spaceId: string;
  readonly emit: (event: PluginAppViewEvent) => void;
};
type View = {
  readonly owner: ViewOwner;
  readonly binding: PluginAppBinding;
  readonly scope: PluginMcpLeaseScope;
  readonly lease: PluginMcpLease;
  readonly fileUri: string | undefined;
  readonly authorize: Effect.Effect<boolean>;
  readonly subscriptions: Semaphore.Semaphore;
};

const unavailable = {
  code: "app_unavailable",
  message: "This plugin app is unavailable for this Project.",
};
const fileUnavailable = {
  code: "file_unavailable",
  message: "The selected file could not be read.",
};
const ownerMatches = (a: ViewOwner, b: ViewOwner) =>
  a.windowId === b.windowId && a.generation === b.generation && a.spaceId === b.spaceId;

export const makePluginAppViews = Effect.fnUntraced(function* ({
  broker,
  catalog,
  changes,
  home,
  files,
  ownerIsCurrent,
  projectIsActive,
  sessionIsInProject,
}: {
  readonly broker: PluginMcpBrokerService;
  readonly catalog: (projectId: string | null) => Effect.Effect<readonly CatalogPlugin[], unknown>;
  readonly changes: Stream.Stream<unknown>;
  readonly home: string;
  readonly files: Pick<WorkspaceFileQueries["Service"], "binary">;
  readonly ownerIsCurrent: (owner: ViewOwner) => boolean;
  readonly projectIsActive: (project: PluginMcpProject) => Effect.Effect<boolean, unknown>;
  readonly sessionIsInProject: (
    sessionId: string,
    projectId: string | null,
  ) => Effect.Effect<boolean, unknown>;
}) {
  const views = new Map<string, View>();
  const leases = yield* FiberMap.make<string>();
  const superviseLease = yield* FiberMap.runtime(leases)();
  const watches = yield* FiberMap.make<string>();
  const superviseWatch = yield* FiberMap.runtime(watches)();
  const getCatalog = (projectId: string | null) =>
    catalog(projectId).pipe(Effect.mapError(() => unavailable));
  const serversFor = (entries: readonly CatalogPlugin[], projectId: string | null) =>
    entries.flatMap((plugin) => {
      const { root, package: pkg } = plugin;
      if (!root || !pkg || !includesProject(plugin.scope, projectId)) return [];
      const source = {
        packageRoot: root,
        dataRoot: resolve(home, "plugin-data", pluginRevision(plugin.id)),
        generation: pkg.digest,
        servers: pkg.mcpServers.filter(runnableServer),
      };
      const presentation = plugin.presentation ?? {
        pluginName: pkg.presentation?.displayName || pkg.identity.name,
      };
      return source.servers.map(({ key: serverKey }) => ({
        pluginId: plugin.id,
        source,
        presentation,
        serverKey,
      }));
    });

  const list = Effect.fnUntraced(function* (project: PluginMcpProject) {
    const servers = serversFor(yield* getCatalog(project.projectId), project.projectId);
    const results = yield* Effect.forEach(
      servers,
      (server) => {
        const { pluginId, source, serverKey } = server;
        const scope: PluginMcpLeaseScope = {
          pluginId,
          generation: source.generation,
          serverKey,
          project,
          principal: { kind: "interface-view", id: randomUUID() },
        };
        return Effect.acquireUseRelease(
          broker.openLease(scope, source),
          (lease) => broker.listTools(scope, lease),
          (lease) => broker.revokeLease(lease.id),
        ).pipe(
          Effect.map((tools): PluginAppCatalogEntry[] =>
            derivePluginAppEntrypoints(server.serverKey, tools).map((entry) => ({
              pluginId: server.pluginId,
              ...server.presentation,
              entryTitle: entry.title,
              entry,
            })),
          ),
          Effect.catch(() => Effect.succeed([])),
        );
      },
      { concurrency: 4 },
    );
    return results.flat();
  });

  const retire = Effect.fnUntraced(function* (id: string) {
    const view = views.get(id);
    if (!view) return;
    views.delete(id);
    yield* FiberMap.remove(watches, id);
    yield* broker.revokeLease(view.lease.id);
    if (ownerIsCurrent(view.owner)) view.owner.emit({ viewId: id, kind: "revoked" });
  });

  yield* changes.pipe(
    Stream.runForEach(() =>
      Effect.forEach(
        [...views],
        ([id, view]) =>
          Effect.flatMap(view.authorize, (active) => (active ? Effect.void : retire(id))),
        { concurrency: 4, discard: true },
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const open = Effect.fnUntraced(function* (owner: ViewOwner, binding: PluginAppBinding) {
    const project = { spaceId: owner.spaceId, projectId: binding.projectId };
    const servers = serversFor(yield* getCatalog(binding.projectId), binding.projectId).filter(
      (server) => server.pluginId === binding.pluginId,
    );
    // The durable id contains the server key, but only an exact live declaration can grant access.
    const server = servers.find(({ serverKey }) =>
      binding.entryId.startsWith(JSON.stringify([serverKey]).slice(0, -1) + ","),
    );
    if (!server || !ownerIsCurrent(owner)) return yield* Effect.fail(unavailable);
    if (
      binding.kind === "file" &&
      binding.file.hostId === "local" &&
      !isAbsolute(binding.file.path)
    )
      return yield* Effect.fail(fileUnavailable);
    const viewId = randomUUID();
    const toolInput = pluginAppLaunchInput(binding, randomUUID());
    let approvedTool: string | undefined;
    const { pluginId, source, serverKey } = server;
    const authorize = Effect.gen(function* () {
      if (!ownerIsCurrent(owner) || !(yield* projectIsActive(project))) return false;
      if (
        binding.kind === "thread" &&
        !(yield* sessionIsInProject(binding.sessionId, binding.projectId))
      )
        return false;
      const entries = yield* getCatalog(binding.projectId);
      return entries.some(
        (plugin) =>
          plugin.id === pluginId &&
          plugin.root === source.packageRoot &&
          plugin.package?.digest === source.generation &&
          includesProject(plugin.scope, binding.projectId),
      );
    }).pipe(Effect.orElseSucceed(() => false));
    const scope: PluginMcpLeaseScope = {
      pluginId,
      generation: source.generation,
      serverKey,
      project,
      principal: {
        kind: "interface-view",
        id: viewId,
        ...(binding.kind === "thread" && { sessionId: binding.sessionId }),
      },
    };
    const lease = yield* broker
      .openLease(scope, source, {
        authorize,
        approval: ({ tool }) => Effect.succeed(tool.name === approvedTool ? "allow" : "deny"),
      })
      .pipe(Effect.mapError(() => unavailable));
    const view: View = {
      owner,
      binding,
      scope,
      lease,
      fileUri: toolInput.file?.resourceUri,
      authorize,
      subscriptions: yield* Semaphore.make(1),
    };
    return yield* Effect.gen(function* () {
      const tools = yield* broker.listTools(scope, lease);
      const entry = derivePluginAppEntrypoints(server.serverKey, tools).find(
        (candidate) => candidate.id === binding.entryId && candidate.kind === binding.kind,
      );
      if (
        !entry ||
        (binding.kind === "file" &&
          !pluginAppMatchesFile(entry, pluginAppFileName(binding.file.path)))
      )
        return yield* Effect.fail(unavailable);
      const response = yield* broker.readResource(scope, lease, entry.resourceUri);
      const resource = resolveMcpRenderableResource(
        entry.resourceUri,
        {
          contents: response.contents.filter(({ uri }) => uri === entry.resourceUri),
        },
        tools.find(({ name }) => name === entry.toolName)?._meta,
      );
      if (!resource || isMcpAppHtmlTooLarge(resource)) return yield* Effect.fail(unavailable);
      approvedTool = entry.toolName;
      const toolResult = yield* broker.callTool(scope, lease, entry.toolName, toolInput);
      if (toolResult.isError || !(yield* authorize)) return yield* Effect.fail(unavailable);
      views.set(viewId, view);
      superviseLease(
        viewId,
        broker.awaitRevoked(scope, lease).pipe(Effect.ignore, Effect.andThen(retire(viewId))),
      );
      if (!ownerIsCurrent(owner)) {
        yield* retire(viewId);
        return yield* Effect.fail(unavailable);
      }
      return { viewId, resource, toolInput, toolResult } satisfies PluginAppLaunch;
    }).pipe(
      Effect.mapError(() => unavailable),
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.andThen(retire(viewId), broker.revokeLease(lease.id)),
      ),
    );
  });

  const request = Effect.fnUntraced(function* (
    owner: ViewOwner,
    id: string,
    method: string,
    params: unknown,
  ) {
    const view = views.get(id);
    if (!view || !ownerMatches(view.owner, owner) || !ownerIsCurrent(owner))
      return yield* Effect.fail(unavailable);
    const active = yield* view.authorize;
    if (!active) {
      yield* retire(id);
      return yield* Effect.fail(unavailable);
    }
    if (
      (method === "ui/message" || method === "ui/update-model-context") &&
      view.binding.kind === "thread"
    )
      return {};
    if (!view.fileUri || view.binding.kind !== "file") {
      return yield* Effect.fail({
        code: "unsupported",
        message: "This operation is unavailable for this plugin app.",
      } satisfies AgentPluginFailure);
    }
    const uri = view.fileUri;
    const operation = resolvePluginFileResourceRequest(uri, method, params);
    if ("code" in operation) return yield* Effect.fail(operation);
    const file = view.binding.file;

    const watch = view.subscriptions.withPermit(
      Effect.gen(function* () {
        if (operation.method === "resources/unsubscribe") {
          yield* FiberMap.remove(watches, id);
          return {};
        }
        if (file.hostId !== "local")
          return yield* Effect.fail({
            code: "unsupported",
            message: "File change subscriptions require a local file.",
          });
        if (yield* FiberMap.has(watches, id)) return {};
        const path = resolve(file.path);
        const ready = yield* Deferred.make<void, AgentPluginFailure>();
        superviseWatch(
          id,
          localFileWatchHost
            .watch({
              path: dirname(path),
              recursive: false,
              renameEventHandling: "changed-path",
            })
            .pipe(
              Stream.runForEach((event) => {
                if (event._tag === "Ready")
                  return Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
                if (event.changedPaths.length && !event.changedPaths.includes(path))
                  return Effect.void;
                return Effect.sync(() => {
                  if (views.get(id) === view && ownerIsCurrent(owner))
                    view.owner.emit({ viewId: id, kind: "resource-updated", uri });
                });
              }),
              Effect.catch(() => Deferred.fail(ready, fileUnavailable).pipe(Effect.asVoid)),
            ),
        );
        yield* Deferred.await(ready);
        return {};
      }),
    );
    const read = (representation: "text" | "blob") =>
      Effect.gen(function* () {
        const bytes = yield* files.binary(file).pipe(Effect.mapError(() => fileUnavailable));
        const response = pluginFileReadResult(uri, bytes, representation);
        if (!response)
          return yield* Effect.fail({
            code: "representation_unavailable",
            message: "The file could not be returned in the requested representation.",
          });
        return response;
      });
    const result = yield* Effect.raceFirst(
      operation.method === "resources/read" ? read(operation.representation) : watch,
      broker.awaitRevoked(view.scope, view.lease).pipe(Effect.mapError(() => unavailable)),
    ).pipe(Effect.result);
    if (!(yield* view.authorize) || views.get(id) !== view) return yield* Effect.fail(unavailable);
    return yield* Effect.fromResult(result);
  });

  return {
    list,
    open,
    request,
    close: (owner: ViewOwner, id: string) => {
      const view = views.get(id);
      return view && ownerMatches(view.owner, owner) ? retire(id) : Effect.void;
    },
    releaseWindow: (windowId: number) =>
      Effect.forEach(
        [...views],
        ([id, view]) =>
          view.owner.windowId === windowId && !ownerIsCurrent(view.owner)
            ? retire(id)
            : Effect.void,
        { discard: true },
      ),
  };
});
