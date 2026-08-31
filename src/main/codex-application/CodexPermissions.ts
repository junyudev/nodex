import * as path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigRequirementsReadResponse";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import type {
  CodexCanonicalHydratedPermissionContext,
  CodexPermissionMode,
  CodexPermissionState,
} from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import {
  buildPermissionModeConfigEdits,
  resolveCodexPermissionState,
} from "../codex/codex-permission-resolver";

interface CodexPermissionConfigSnapshot {
  readonly config: ConfigReadResponse["config"];
  readonly origins: ConfigReadResponse["origins"];
  readonly requirements: ConfigRequirementsReadResponse["requirements"];
}

/** Reconciles the effective Nodex permission decision with app-server hydration provenance. */
export const resolveCanonicalPermissionContext = (
  permissionState: CodexPermissionState,
  runtimeWorkspaceRoots: readonly string[],
  fallback: CodexCanonicalHydratedPermissionContext,
): CodexCanonicalHydratedPermissionContext => {
  const activePermissionProfile =
    permissionState.effectivePreset === "read-only"
      ? { id: ":read-only", extends: null }
      : permissionState.effectivePreset === "full-access"
        ? { id: ":danger-full-access", extends: null }
        : permissionState.effectivePreset === "auto" ||
            permissionState.effectivePreset === "guardian-approvals"
          ? { id: ":workspace", extends: null }
          : fallback.activePermissionProfile;
  return {
    activePermissionProfile,
    runtimeWorkspaceRoots: [...runtimeWorkspaceRoots],
    approvalPolicy: permissionState.approvalPolicy ?? fallback.approvalPolicy,
    approvalsReviewer: permissionState.approvalsReviewer ?? fallback.approvalsReviewer,
    sandboxPolicy: permissionState.sandbox ?? fallback.sandboxPolicy,
  };
};

export interface CodexPermissionDecision {
  readonly state: CodexPermissionState;
  readonly verifiedBuiltinFullAccess: boolean;
}

export class CodexPermissionsError extends Schema.TaggedError<CodexPermissionsError>()(
  "CodexPermissionsError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexPermissions extends Context.Service<
  CodexPermissions,
  {
    readonly snapshot: (
      projectId: string | null,
    ) => Effect.Effect<CodexPermissionState, CodexPermissionsError>;
    readonly resolve: (input: {
      readonly projectId: string | null;
      readonly requestedMode?: CodexPermissionMode;
      readonly workspaceRoots: readonly string[];
    }) => Effect.Effect<CodexPermissionDecision, CodexPermissionsError>;
    readonly resolveAutomation: (
      workspaceRoots: readonly string[],
    ) => Effect.Effect<CodexPermissionState>;
    readonly setMode: (
      projectId: string | null,
      mode: CodexPermissionMode,
    ) => Effect.Effect<CodexPermissionState, CodexPermissionsError>;
    readonly setConfigValue: (
      projectId: string | null,
      keyPath: string,
      value: unknown,
    ) => Effect.Effect<CodexPermissionState, CodexPermissionsError>;
  }
>()("nodex/main/codex-application/CodexPermissions") {}

const fallbackState = (
  runtimeStateHome: string,
  mode: CodexPermissionMode,
  workspaceRoots: readonly string[],
  previous: CodexPermissionState | null,
): CodexPermissionState => {
  const configTarget = previous?.configTarget ?? {
    source: "user" as const,
    filePath: path.join(runtimeStateHome, "config.toml"),
  };

  if (mode === "custom") {
    return {
      mode: "custom",
      effectivePreset: "custom",
      availableModes: previous?.availableModes ?? [
        "auto",
        "guardian-approvals",
        "full-access",
        "custom",
      ],
      approvalPolicy: previous?.approvalPolicy ?? null,
      approvalsReviewer: previous?.approvalsReviewer ?? "user",
      sandboxMode: previous?.sandboxMode ?? null,
      sandbox: previous?.sandbox ?? null,
      autoReviewAvailable: previous?.autoReviewAvailable ?? false,
      configTarget,
    };
  }

  const autoReviewAvailable = previous?.autoReviewAvailable ?? true;
  const approvalsReviewer =
    mode === "guardian-approvals" && autoReviewAvailable ? "auto_review" : "user";
  const sandbox =
    mode === "full-access"
      ? { type: "dangerFullAccess" as const }
      : workspaceRoots.length > 0
        ? {
            type: "workspaceWrite" as const,
            writableRoots: [...workspaceRoots],
            networkAccess:
              previous?.sandbox?.type === "workspaceWrite" ? previous.sandbox.networkAccess : false,
            excludeTmpdirEnvVar:
              previous?.sandbox?.type === "workspaceWrite"
                ? previous.sandbox.excludeTmpdirEnvVar
                : false,
            excludeSlashTmp:
              previous?.sandbox?.type === "workspaceWrite"
                ? previous.sandbox.excludeSlashTmp
                : false,
          }
        : null;

  return {
    mode,
    effectivePreset: mode === "guardian-approvals" && !autoReviewAvailable ? "auto" : mode,
    availableModes: previous?.availableModes ?? [
      "auto",
      "guardian-approvals",
      "full-access",
      "custom",
    ],
    approvalPolicy: mode === "full-access" ? "never" : "on-request",
    approvalsReviewer,
    sandboxMode: mode === "full-access" ? "danger-full-access" : "workspace-write",
    sandbox,
    autoReviewAvailable,
    configTarget,
  };
};

export const resolvePermissionMode = (
  runtimeStateHome: string,
  permissionState: CodexPermissionState,
  requestedMode: CodexPermissionMode | undefined,
  workspaceRoots: readonly string[],
): CodexPermissionState => {
  if (!requestedMode || requestedMode === permissionState.mode) return permissionState;
  if (!permissionState.availableModes.includes(requestedMode)) return permissionState;
  return fallbackState(runtimeStateHome, requestedMode, workspaceRoots, permissionState);
};

const permissionModeIsAvailable = (
  state: CodexPermissionState,
  mode: Exclude<CodexPermissionMode, "custom">,
): boolean => state.availableModes.includes(mode);

export const live = (options: {
  readonly runtimeStateHome: string;
}): Layer.Layer<CodexPermissions, never, CodexGateway | CoreModules> =>
  Layer.effect(
    CodexPermissions,
    Effect.gen(function* () {
      const core = yield* CoreModules;
      const gateway = yield* CodexGateway;
      const stateByScope = yield* Ref.make<ReadonlyMap<string | null, CodexPermissionState>>(
        new Map(),
      );
      const verifiedModeByProject = yield* Ref.make<ReadonlyMap<string, CodexPermissionMode>>(
        new Map(),
      );
      const runtimeStateHome = path.resolve(options.runtimeStateHome);
      const error = (operation: string, cause: unknown) =>
        new CodexPermissionsError({ operation, cause });

      const readWorkspaceRoots = Effect.fn("CodexPermissions.readWorkspaceRoots")(function* (
        projectId: string | null,
      ) {
        if (projectId === null) return [];
        const snapshot = yield* core.workspace
          .read({ kind: "project", project_id: projectId }, undefined, projectId)
          .pipe(Effect.mapError((cause) => error("read-project", cause)));
        if (snapshot.value.kind !== "project") {
          return yield* error(
            "read-project",
            new Error("Core returned a non-project Workspace read variant"),
          );
        }
        return snapshot.value.project.sources
          .map((source) => source.root.trim())
          .filter((root) => root.length > 0);
      });

      const readPersistedMode = Effect.fn("CodexPermissions.readPersistedMode")(function* (
        projectId: string | null,
      ) {
        const snapshot = yield* core.workspace
          .read(
            projectId === null
              ? { kind: "projectless_permission_mode" }
              : { kind: "project_permission_mode", project_id: projectId },
            undefined,
            projectId ?? undefined,
          )
          .pipe(Effect.mapError((cause) => error("read-selection", cause)));
        if (snapshot.value.kind === "project_permission_mode") {
          return snapshot.value.mode ?? null;
        }
        if (snapshot.value.kind === "projectless_permission_mode") {
          return snapshot.value.mode ?? null;
        }
        return yield* error(
          "read-selection",
          new Error("Core returned a non-permission Workspace read variant"),
        );
      });

      const writePersistedMode = Effect.fn("CodexPermissions.writePersistedMode")(function* (
        projectId: string | null,
        mode: CodexPermissionMode,
      ) {
        yield* core.workspace
          .apply(
            {
              operationId: createOperationId("permissions.update"),
              intent:
                projectId === null
                  ? { kind: "set_projectless_permission_mode", mode }
                  : { kind: "set_project_permission_mode", project_id: projectId, mode },
            },
            undefined,
            projectId ?? undefined,
          )
          .pipe(Effect.mapError((cause) => error("write-selection", cause)));
      });

      const readConfig = Effect.fn("CodexPermissions.readConfig")(function* () {
        yield* gateway.awaitReady(gateway.localHostId);
        const [configResult, requirementsResult] = yield* Effect.all(
          [
            gateway.requestLocal("config/read", { includeLayers: true }),
            gateway.requestLocal("configRequirements/read", undefined),
          ],
          { concurrency: 2 },
        );
        const configResponse = configResult as unknown as ConfigReadResponse;
        const requirementsResponse =
          requirementsResult as unknown as ConfigRequirementsReadResponse;
        return {
          config: configResponse.config,
          origins: configResponse.origins,
          requirements: requirementsResponse.requirements,
        } satisfies CodexPermissionConfigSnapshot;
      });

      const invalidate = Effect.fn("CodexPermissions.invalidate")((projectId: string | null) =>
        Effect.all(
          [
            Ref.update(stateByScope, (current) => {
              const next = new Map(current);
              next.delete(projectId);
              return next;
            }),
            projectId === null
              ? Effect.void
              : Ref.update(verifiedModeByProject, (current) => {
                  const next = new Map(current);
                  next.delete(projectId);
                  return next;
                }),
          ],
          { discard: true },
        ),
      );

      const applyPersistedSelection = Effect.fn("CodexPermissions.applyPersistedSelection")(
        function* (
          projectId: string | null,
          state: CodexPermissionState,
          workspaceRoots: readonly string[],
        ) {
          const selection = yield* readPersistedMode(projectId);
          if (selection === null) {
            if (projectId !== null) {
              yield* Ref.update(verifiedModeByProject, (current) => {
                const next = new Map(current);
                next.delete(projectId);
                return next;
              });
            }
            return state;
          }
          if (projectId !== null && selection !== "full-access") {
            yield* Ref.update(verifiedModeByProject, (current) => {
              const next = new Map(current);
              next.delete(projectId);
              return next;
            });
          }
          if (selection === "custom") {
            return fallbackState(runtimeStateHome, selection, workspaceRoots, state);
          }
          if (!permissionModeIsAvailable(state, selection)) {
            if (projectId !== null) {
              yield* Ref.update(verifiedModeByProject, (current) => {
                const next = new Map(current);
                next.delete(projectId);
                return next;
              });
            }
            return state;
          }
          if (projectId !== null && selection === "full-access") {
            yield* Ref.update(verifiedModeByProject, (current) => {
              const next = new Map(current);
              next.set(projectId, selection);
              return next;
            });
          }
          return fallbackState(runtimeStateHome, selection, workspaceRoots, state);
        },
      );

      const snapshot: CodexPermissions["Service"]["snapshot"] = Effect.fn(
        "CodexPermissions.snapshot",
      )(function* (projectId) {
        const cached = (yield* Ref.get(stateByScope)).get(projectId);
        if (cached !== undefined) return cached;

        const workspaceRoots = yield* readWorkspaceRoots(projectId);
        const previous = (yield* Ref.get(stateByScope)).get(projectId) ?? null;
        const resolution = yield* Effect.gen(function* () {
          const config = yield* readConfig();
          const resolved = resolveCodexPermissionState({
            ...config,
            defaultUserConfigPath: path.join(runtimeStateHome, "config.toml"),
            workspaceRoots: [...workspaceRoots],
          });
          return yield* applyPersistedSelection(projectId, resolved, workspaceRoots);
        }).pipe(
          Effect.map((state) => ({ cacheable: true as const, state })),
          Effect.catch((cause) =>
            Effect.logWarning(
              "Codex permission authority read failed; using a transient fallback",
            ).pipe(
              Effect.annotateLogs({
                cause: cause instanceof Error ? cause.message : String(cause),
                projectId,
              }),
              Effect.as({
                cacheable: false as const,
                state: fallbackState(
                  runtimeStateHome,
                  previous?.mode ?? "auto",
                  workspaceRoots,
                  previous,
                ),
              }),
            ),
          ),
        );
        if (resolution.cacheable) {
          yield* Ref.update(stateByScope, (current) => {
            const next = new Map(current);
            next.set(projectId, resolution.state);
            return next;
          });
        }
        return resolution.state;
      });

      const setMode: CodexPermissions["Service"]["setMode"] = Effect.fn("CodexPermissions.setMode")(
        function* (projectId, mode) {
          const current = yield* snapshot(projectId);
          if (!current.availableModes.includes(mode)) return current;
          const edits = buildPermissionModeConfigEdits(mode);
          if (edits.length > 0) {
            const params = {
              edits,
              filePath: current.configTarget.filePath,
              reloadUserConfig: current.configTarget.source === "user",
            } as unknown as ClientRequestParamsByMethod["config/batchWrite"];
            const written = yield* gateway.requestLocal("config/batchWrite", params).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
            if (!written) return current;
          }
          yield* writePersistedMode(projectId, mode).pipe(
            Effect.tapError(() => invalidate(projectId)),
          );
          yield* invalidate(projectId);
          return yield* snapshot(projectId);
        },
      );

      const setConfigValue: CodexPermissions["Service"]["setConfigValue"] = Effect.fn(
        "CodexPermissions.setConfigValue",
      )(function* (projectId, keyPath, value) {
        const current = yield* snapshot(projectId);
        const params = {
          keyPath,
          value,
          filePath: current.configTarget.filePath,
          reloadUserConfig: current.configTarget.source === "user",
        } as unknown as ClientRequestParamsByMethod["config/value/write"];
        const written = yield* gateway.requestLocal("config/value/write", params).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!written) return current;
        yield* writePersistedMode(projectId, "custom").pipe(
          Effect.tapError(() => invalidate(projectId)),
        );
        yield* invalidate(projectId);
        return yield* snapshot(projectId);
      });

      return CodexPermissions.of({
        snapshot,
        resolve: Effect.fn("CodexPermissions.resolve")(function* (input) {
          const state = yield* snapshot(input.projectId);
          const resolved = resolvePermissionMode(
            runtimeStateHome,
            state,
            input.requestedMode,
            input.workspaceRoots,
          );
          const verified =
            input.projectId !== null &&
            resolved.mode === "full-access" &&
            (yield* Ref.get(verifiedModeByProject)).get(input.projectId) === "full-access";
          return { state: resolved, verifiedBuiltinFullAccess: verified };
        }),
        resolveAutomation: (workspaceRoots) =>
          readConfig().pipe(
            Effect.map((config) =>
              resolveCodexPermissionState({
                ...config,
                defaultUserConfigPath: path.join(runtimeStateHome, "config.toml"),
                workspaceRoots: [...workspaceRoots],
              }),
            ),
            Effect.catch(() =>
              Effect.succeed(fallbackState(runtimeStateHome, "auto", workspaceRoots, null)),
            ),
          ),
        setMode,
        setConfigValue,
      });
    }),
  );
