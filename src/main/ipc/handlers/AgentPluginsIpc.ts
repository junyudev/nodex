import { isAbsolute, parse, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import {
  PluginInstallation,
  type PluginInstallationError,
  type PluginInstallationMutation,
} from "../../../host/agent-plugins/PluginInstallation";
import {
  effectivePluginContributions,
  samePluginProject,
  type PluginProject,
} from "../../../shared/agent-plugins/installation-registry";
import {
  describePluginMcp,
  describePluginPackage,
  type AgentPluginFailure,
  type AgentPluginList,
  type AgentPluginResult,
  type PluginPreview,
} from "../../../shared/agent-plugins/ipc";
import { rendererSpaceParameter } from "../../../shared/space-ipc-policy";
import { MainConfig } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ProjectId = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 && value.trim() === value && !value.includes("\0")),
);
const Directory = Schema.String.check(
  Schema.makeFilter((value) => {
    // A Windows drive-relative root (e.g. "\\folder") is not an absolute source.
    const root = parse(value).root;
    return isAbsolute(value) && (sep !== "\\" || root.length > 1) && !value.includes("\0");
  }),
);
const List = Schema.Struct({ projectId: Schema.NullOr(ProjectId) });
const Preview = Schema.Struct({ directory: Directory });
const Install = Schema.Struct({ directory: Directory, previewDigest: Id });
const Enable = Schema.Struct({ id: Id, projectId: ProjectId, enabled: Schema.Boolean });
const Reload = Schema.Struct({ id: Id });
const Uninstall = Schema.Struct({ id: Id, data: Schema.Literals(["keep", "delete"]) });

const failure = (code: string, message: string): AgentPluginFailure => ({ code, message });

function installationFailure(error: PluginInstallationError): AgentPluginFailure {
  switch (error.code) {
    case "package-rejected":
      return { ...failure(error.code, "The package could not be read."), reasons: error.reasons };
    case "staged-digest-mismatch":
      return failure(error.code, "The folder changed. Review it again before installing.");
    case "identity-changed":
      return failure(
        error.code,
        "The plugin identity changed. Install the folder as a new plugin.",
      );
    case "not-installed":
      return failure(error.code, "This plugin is no longer installed.");
    case "invalid-project":
      return failure(error.code, "This Project is unavailable.");
    case "revision-conflict":
      return failure(error.code, "The installation list changed. Try again.");
    case "store-busy":
      return failure(error.code, "The plugin registry is in use. Try again.");
    case "unsupported-source":
      return failure(error.code, "Choose a local plugin folder.");
    case "invalid-registry":
    case "store-io":
      return failure(error.code, "Could not access the plugin registry.");
  }
}

const outcome = <T>(effect: Effect.Effect<T, AgentPluginFailure>) =>
  effect.pipe(
    Effect.map((value): AgentPluginResult<T> => ({ ok: true, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
  );

const mutationReceipt = ({ cleanupWarnings }: PluginInstallationMutation) => ({ cleanupWarnings });

export const live = (context: {
  readonly personalSpaceId: string;
  readonly projectIsActive: (project: PluginProject) => Effect.Effect<boolean, unknown>;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const ipc = yield* ElectronIpc;
      const plugins = yield* PluginInstallation;
      const config = yield* MainConfig;
      const desktop = yield* ElectronDesktop;
      const windows = yield* ElectronWindowHost;
      const authorize = (event: IpcMainInvokeEvent) =>
        Effect.try({
          try: () => {
            requireTrustedAppRendererSender(event, "Agent Plugins", config.rendererUrl);
            return rendererSpaceParameter(event.senderFrame?.url ?? "") ?? context.personalSpaceId;
          },
          catch: () => failure("policy_denied", "Agent Plugins require a trusted Nodex window."),
        });
      const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
        schema: S,
        raw: unknown,
      ) =>
        Schema.decodeUnknownEffect(schema)(raw, { onExcessProperty: "error" }).pipe(
          Effect.mapError(() => failure("invalid_input", "Invalid Agent Plugins request.")),
        );
      const projectFor = Effect.fnUntraced(function* (spaceId: string, projectId: string) {
        const project = { spaceId, projectId };
        const unavailable = failure("invalid-project", "This Project is unavailable.");
        const active = yield* context
          .projectIsActive(project)
          .pipe(Effect.mapError(() => unavailable));
        if (!active) return yield* Effect.fail(unavailable);
        return project;
      });
      yield* ipc.handleQuery("agent-plugins:list", (event, raw) =>
        outcome(
          Effect.gen(function* () {
            const spaceId = yield* authorize(event);
            const { projectId } = yield* decode(List, raw);
            const project = projectId === null ? null : yield* projectFor(spaceId, projectId);
            const [registry, writerStatus] = yield* Effect.all(
              [plugins.list, plugins.writerStatus],
              {
                concurrency: "unbounded",
              },
            ).pipe(Effect.mapError(installationFailure));
            const effective = new Map(
              (project ? effectivePluginContributions(registry, project) : []).map((entry) => [
                entry.installationId,
                entry,
              ]),
            );
            return {
              writerStatus,
              installations: registry.installations.map((entry) => {
                const contribution = effective.get(entry.id);
                return {
                  id: entry.id,
                  source: entry.source,
                  package: describePluginPackage(entry.package),
                  projectEnabled:
                    project !== null &&
                    entry.projects.some((item) => samePluginProject(item, project)),
                  effective: contribution
                    ? {
                        ...contribution,
                        mcpServers: contribution.mcpServers.map(describePluginMcp),
                      }
                    : null,
                };
              }),
            } satisfies AgentPluginList;
          }),
        ),
      );
      yield* ipc.handlePlainCommand("agent-plugins:pick-folder", (event) =>
        outcome(
          Effect.gen(function* () {
            yield* authorize(event);
            const owner = yield* windows.fromWebContents(event.sender);
            if (!owner)
              return yield* Effect.fail(
                failure("policy_denied", "The Nodex window is unavailable."),
              );
            const options: OpenDialogOptions = {
              title: "Choose plugin folder",
              properties: ["openDirectory"],
            };
            const result = yield* Effect.tryPromise({
              try: () => desktop.dialog.showOpenDialog(owner, options),
              catch: () => failure("picker-unavailable", "Could not open the folder picker."),
            });
            return result.canceled ? null : (result.filePaths[0] ?? null);
          }),
        ),
      );
      yield* ipc.handleQuery("agent-plugins:preview", (event, raw) =>
        outcome(
          authorize(event).pipe(
            Effect.andThen(decode(Preview, raw)),
            Effect.flatMap(({ directory }) =>
              plugins.preview(directory).pipe(Effect.mapError(installationFailure)),
            ),
            Effect.map((result): PluginPreview =>
              result.status === "loaded"
                ? { status: "loaded", package: describePluginPackage(result.package) }
                : result,
            ),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("agent-plugins:install", (event, raw) =>
        outcome(
          authorize(event).pipe(
            Effect.andThen(decode(Install, raw)),
            Effect.flatMap(({ directory, previewDigest }) =>
              plugins
                .install({ kind: "local", locator: directory }, previewDigest)
                .pipe(Effect.mapError(installationFailure)),
            ),
            Effect.map(mutationReceipt),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("agent-plugins:set-project-enabled", (event, raw) =>
        outcome(
          Effect.gen(function* () {
            const spaceId = yield* authorize(event);
            const { id, projectId, enabled } = yield* decode(Enable, raw);
            const project = yield* projectFor(spaceId, projectId);
            yield* plugins
              .setProjectEnabled(id, project, enabled)
              .pipe(Effect.mapError(installationFailure));
          }),
        ),
      );
      yield* ipc.handlePlainCommand("agent-plugins:reload", (event, raw) =>
        outcome(
          authorize(event).pipe(
            Effect.andThen(decode(Reload, raw)),
            Effect.flatMap(({ id }) =>
              plugins.reload(id).pipe(Effect.mapError(installationFailure)),
            ),
            Effect.map(mutationReceipt),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("agent-plugins:uninstall", (event, raw) =>
        outcome(
          authorize(event).pipe(
            Effect.andThen(decode(Uninstall, raw)),
            Effect.flatMap(({ id, data }) =>
              plugins.uninstall(id, { data }).pipe(Effect.mapError(installationFailure)),
            ),
            Effect.map(mutationReceipt),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("agent-plugins:repair-writer", (event) =>
        outcome(
          authorize(event).pipe(
            Effect.andThen(plugins.repairWriter.pipe(Effect.mapError(installationFailure))),
          ),
        ),
      );
    }),
  );
