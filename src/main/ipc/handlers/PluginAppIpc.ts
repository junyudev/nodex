import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { z } from "zod";
import { PluginMcpBroker } from "../../../host/agent-plugins/broker";
import { PluginManager } from "../../codex-application/PluginManager";
import { CoreAuthority } from "../../core-runtime/CoreAuthority";
import { ProjectWorkspace } from "../../project-application/ProjectWorkspace";
import type {
  AgentPluginFailure,
  AgentPluginResult,
  PluginAppViewEvent,
} from "../../../shared/agent-plugins/ipc";
import { WorkbenchPluginAppBindingSchema } from "../../../shared/schemas/workbench-scene";
import { rendererSpaceParameter } from "../../../shared/space-ipc-policy";
import { MainConfig } from "../../app/MainConfig";
import { WorkspaceFileQueries } from "../../host-runtime/WorkspaceFileQueries";
import { safeBroadcastToWindows, safeSendToWebContents } from "../../ipc-safe-send";
import { makePluginAppViews } from "../../mcp-app/PluginAppViews";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

const projectIdSchema = z.string().min(1).max(512).nullable();
const viewIdSchema = z.uuid();
const requestSchema = z.strictObject({
  viewId: viewIdSchema,
  method: z.string().max(200),
  params: z.unknown().optional(),
});
const invalid = { code: "invalid_input", message: "Invalid plugin app request." };
const unavailable = {
  code: "app_unavailable",
  message: "This plugin app is unavailable for this Project.",
};

const outcome = <T>(effect: Effect.Effect<T, AgentPluginFailure>) =>
  effect.pipe(
    Effect.map((value): AgentPluginResult<T> => ({ ok: true, value })),
    Effect.catch((error) => Effect.succeed({ ok: false, error } as const)),
  );

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const plugins = yield* PluginManager;
    const broker = yield* PluginMcpBroker;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const files = yield* WorkspaceFileQueries;
    const projects = yield* ProjectWorkspace;
    const { identity } = yield* CoreAuthority;
    const personalSpaceId = identity.libraryId;
    const projectIsActive = (projectId: string | null) =>
      projectId === null
        ? Effect.succeed(true)
        : projects
            .getProject(projectId)
            .pipe(Effect.map((project) => project?.lifecycle === "active"));
    const changes = plugins.changes.pipe(
      Stream.filter(
        ({ kind }) =>
          kind === "plugins" || kind === "account" || kind === "connection" || kind === "mcp",
      ),
      Stream.tap(() =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "agent-plugins:app-event", [
            { kind: "catalog-changed" },
          ]),
        ),
      ),
    );
    const views = yield* makePluginAppViews({
      broker,
      files,
      changes,
      home: config.nodexHome,
      catalog: (projectId) =>
        plugins.catalog?.(projectId).pipe(Effect.map(({ entries }) => entries)) ??
        Effect.succeed([]),
      projectIsActive: (project) => projectIsActive(project.projectId),
      sessionIsInProject: (sessionId, projectId) =>
        projects
          .getProjectSession(sessionId)
          .pipe(
            Effect.map(
              (session) => !!session && session.projectId === projectId && !session.archived,
            ),
          ),
      ownerIsCurrent: (owner) =>
        windows.resolveRendererGeneration(owner.windowId) === owner.generation,
    });
    yield* windows.events.pipe(
      Stream.runForEach((event) =>
        event.kind === "released" || event.kind === "renderer-changed"
          ? views.releaseWindow(event.window.webContentsId)
          : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const authorize = (event: Electron.IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Plugin apps", config.rendererUrl);
          const windowId = event.sender.id;
          const generation = windows.resolveRendererGeneration(windowId);
          if (!generation) throw new Error("No active renderer");
          const spaceId = rendererSpaceParameter(event.senderFrame?.url ?? "") ?? personalSpaceId;
          if (spaceId !== personalSpaceId) throw new Error("Plugin apps require a personal Space");
          return {
            generation,
            windowId,
            spaceId,
            emit: (payload: PluginAppViewEvent) => {
              safeSendToWebContents(event.sender, "agent-plugins:app-event", [payload]);
            },
          };
        },
        catch: () => unavailable,
      });
    const decode = <T>(schema: z.ZodType<T>, raw: unknown) =>
      Effect.try({ try: () => schema.parse(raw), catch: () => invalid });
    const projectFor = Effect.fnUntraced(function* (spaceId: string, projectId: string | null) {
      const project = { spaceId, projectId };
      const active = yield* projectIsActive(projectId).pipe(Effect.orElseSucceed(() => false));
      if (!active) return yield* Effect.fail(unavailable);
      return project;
    });
    yield* ipc.handleQuery("agent-plugins:app-entries", (event, raw) =>
      outcome(
        Effect.gen(function* () {
          const owner = yield* authorize(event);
          const projectId = yield* decode(projectIdSchema, raw);
          return yield* views.list(yield* projectFor(owner.spaceId, projectId));
        }),
      ),
    );
    yield* ipc.handlePlainCommand("agent-plugins:app-open", (event, raw) =>
      outcome(
        Effect.gen(function* () {
          const owner = yield* authorize(event);
          const binding = yield* decode(WorkbenchPluginAppBindingSchema, raw);
          yield* projectFor(owner.spaceId, binding.projectId);
          return yield* views.open(owner, binding);
        }),
      ),
    );
    yield* ipc.handlePlainCommand("agent-plugins:app-close", (event, raw) =>
      outcome(
        Effect.gen(function* () {
          const owner = yield* authorize(event);
          const id = yield* decode(viewIdSchema, raw);
          yield* views.close(owner, id);
        }),
      ),
    );
    yield* ipc.handlePlainCommand("agent-plugins:app-request", (event, raw) =>
      outcome(
        Effect.gen(function* () {
          const owner = yield* authorize(event);
          const { viewId, method, params } = yield* decode(requestSchema, raw);
          return yield* views.request(owner, viewId, method, params);
        }),
      ),
    );
  }),
);
