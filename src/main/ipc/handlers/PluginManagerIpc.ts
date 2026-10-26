import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import type { PluginQueries, PluginCommands } from "../../../shared/codex-plugin-management";
import { PluginManager } from "../../codex-application/PluginManager";
import { pluginError } from "../../codex-application/PluginManagementError";
import { MainConfig } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { safeSendToWindow } from "../../ipc-safe-send";

const context = {
  hostId: Schema.Literal("local"),
  projectId: Schema.NullOr(Schema.NonEmptyString),
};
const ContextInput = Schema.Struct(context);
const selector = Schema.Union([
  Schema.Struct({
    ...context,
    marketplacePath: Schema.NonEmptyString,
    remoteMarketplaceName: Schema.optionalKey(Schema.Never),
    pluginName: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...context,
    marketplacePath: Schema.optionalKey(Schema.Never),
    remoteMarketplaceName: Schema.NonEmptyString,
    pluginName: Schema.NonEmptyString,
  }),
]);
const cursor = Schema.optionalKey(Schema.NullOr(Schema.String));
const personalCursor = Schema.optionalKey(
  Schema.NullOr(
    Schema.Struct({
      workspaceCreatedPageToken: Schema.NullOr(Schema.String),
      userPageToken: Schema.NullOr(Schema.String),
    }),
  ),
);
const skill = Schema.Union([
  Schema.Struct({
    ...context,
    path: Schema.NonEmptyString,
    name: Schema.optionalKey(Schema.Never),
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    ...context,
    path: Schema.optionalKey(Schema.Never),
    name: Schema.NonEmptyString,
    enabled: Schema.Boolean,
  }),
]);
export const pluginQuerySchemas = {
  context: ContextInput,
  capabilities: ContextInput,
  list: Schema.Struct({ ...context, forceRefetch: Schema.optionalKey(Schema.Boolean) }),
  installed: ContextInput,
  read: selector,
  search: Schema.Struct({
    ...context,
    term: Schema.String,
    scope: Schema.optionalKey(Schema.Literals(["global", "personal", "workspace"])),
    cursor,
  }),
  skills: Schema.Struct({ ...context, forceReload: Schema.optionalKey(Schema.Boolean) }),
  "skill-contents": Schema.Union([
    Schema.Struct({
      ...context,
      path: Schema.NonEmptyString,
      remoteMarketplaceName: Schema.optionalKey(Schema.Never),
      remotePluginId: Schema.optionalKey(Schema.Never),
      skillName: Schema.optionalKey(Schema.Never),
    }),
    Schema.Struct({
      ...context,
      path: Schema.optionalKey(Schema.Never),
      remoteMarketplaceName: Schema.NonEmptyString,
      remotePluginId: Schema.NonEmptyString,
      skillName: Schema.NonEmptyString,
    }),
  ]),
  hooks: ContextInput,
  "public-home": ContextInput,
  category: Schema.Struct({
    ...context,
    slug: Schema.NonEmptyString,
    search: Schema.optionalKey(Schema.String),
    cursor,
  }),
  personal: ContextInput,
  "personal-page": Schema.Struct({
    ...context,
    feed: Schema.Literals(["created", "shared"]),
    cursor: personalCursor,
  }),
  "marketplace-removal-preview": Schema.Struct({
    ...context,
    marketplaceName: Schema.NonEmptyString,
  }),
} as const;
export const pluginCommandSchemas = {
  install: Schema.Union([
    Schema.Struct({
      ...context,
      marketplacePath: Schema.NonEmptyString,
      remoteMarketplaceName: Schema.optionalKey(Schema.Never),
      pluginName: Schema.NonEmptyString,
      installAttemptId: Schema.NonEmptyString,
    }),
    Schema.Struct({
      ...context,
      marketplacePath: Schema.optionalKey(Schema.Never),
      remoteMarketplaceName: Schema.NonEmptyString,
      pluginName: Schema.NonEmptyString,
      installAttemptId: Schema.NonEmptyString,
    }),
  ]),
  uninstall: Schema.Struct({ ...context, pluginId: Schema.NonEmptyString }),
  "set-enabled": Schema.Struct({
    ...context,
    pluginId: Schema.NonEmptyString,
    enabled: Schema.Boolean,
  }),
  "skill-enabled": skill,
  "marketplace-add": Schema.Struct({
    ...context,
    source: Schema.NonEmptyString,
    refName: Schema.optionalKey(Schema.NullOr(Schema.String)),
    sparsePaths: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  }),
  "marketplace-remove": Schema.Struct({
    ...context,
    marketplaceName: Schema.NonEmptyString,
    operationId: Schema.optionalKey(Schema.NonEmptyString),
  }),
  "marketplace-upgrade": Schema.Struct({
    ...context,
    marketplaceName: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  }),
  refresh: ContextInput,
} as const;
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const manager = yield* PluginManager;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Plugin management", config.rendererUrl);
        },
        catch: () =>
          pluginError("policy_denied", "Plugin management requires a trusted Nodex window."),
      });
    const registerQuery = <K extends keyof PluginQueries>(name: K) =>
      ipc.handleQuery(`codex:plugins:${name}`, (event, raw) =>
        authorize(event).pipe(
          Effect.andThen(
            Schema.decodeUnknownEffect(pluginQuerySchemas[name])(raw).pipe(
              Effect.mapError(() => pluginError("invalid_input", "Invalid plugin request.")),
            ),
          ),
          Effect.flatMap((input) => manager.query(name, input as PluginQueries[K]["input"])),
        ),
      );
    const registerCommand = <K extends keyof PluginCommands>(name: K) =>
      ipc.handlePlainCommand(`codex:plugins:${name}`, (event, raw) =>
        authorize(event).pipe(
          Effect.andThen(
            Schema.decodeUnknownEffect(pluginCommandSchemas[name])(raw).pipe(
              Effect.mapError(() => pluginError("invalid_input", "Invalid plugin request.")),
            ),
          ),
          Effect.flatMap((input) => manager.command(name, input as PluginCommands[K]["input"])),
        ),
      );
    for (const name of Object.keys(pluginQuerySchemas) as (keyof PluginQueries)[])
      yield* registerQuery(name);
    for (const name of Object.keys(pluginCommandSchemas) as (keyof PluginCommands)[])
      yield* registerCommand(name);
    yield* manager.changes.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          for (const window of windows.all())
            safeSendToWindow(window, "codex:plugins:changed", [event]);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
