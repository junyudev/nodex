import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  CodexExecutionHostSettings,
  ManagedWorktreeSettings,
  UpdateCodexExecutionHostSettingsInput,
} from "../../shared/types";
import { ApplicationSettings } from "../settings/ApplicationSettings";

export class ExecutionHostConfigurationError extends Schema.TaggedError<ExecutionHostConfigurationError>()(
  "ExecutionHostConfigurationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ExecutionHostConfiguration extends Context.Service<
  ExecutionHostConfiguration,
  {
    readonly settings: Effect.Effect<CodexExecutionHostSettings, ExecutionHostConfigurationError>;
    readonly update: (
      input: UpdateCodexExecutionHostSettingsInput,
    ) => Effect.Effect<CodexExecutionHostSettings, ExecutionHostConfigurationError>;
  }
>()("nodex/main/codex-application/ExecutionHostConfiguration") {}

export class ManagedWorktreeConfiguration extends Context.Service<
  ManagedWorktreeConfiguration,
  {
    readonly settings: Effect.Effect<ManagedWorktreeSettings, ExecutionHostConfigurationError>;
    readonly update: (
      input: Partial<ManagedWorktreeSettings>,
    ) => Effect.Effect<ManagedWorktreeSettings, ExecutionHostConfigurationError>;
  }
>()("nodex/main/codex-application/ManagedWorktreeConfiguration") {}

/** Owns the Profile-local authority for host and managed-worktree configuration. */
export const live: Layer.Layer<
  ExecutionHostConfiguration | ManagedWorktreeConfiguration,
  never,
  ApplicationSettings
> = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* ApplicationSettings;
    const mapError = (operation: string) => (cause: unknown) =>
      new ExecutionHostConfigurationError({ operation, cause });
    return Layer.merge(
      Layer.succeed(
        ExecutionHostConfiguration,
        ExecutionHostConfiguration.of({
          settings: settings.snapshot().pipe(
            Effect.map((snapshot) => snapshot.executionHosts),
            Effect.mapError(mapError("read-execution-hosts")),
          ),
          update: (input) =>
            settings.update({ type: "update-execution-hosts", input }).pipe(
              Effect.map((snapshot) => snapshot.executionHosts),
              Effect.mapError(mapError("update-execution-hosts")),
            ),
        }),
      ),
      Layer.succeed(
        ManagedWorktreeConfiguration,
        ManagedWorktreeConfiguration.of({
          settings: settings.snapshot().pipe(
            Effect.map((snapshot) => snapshot.managedWorktrees),
            Effect.mapError(mapError("read-managed-worktrees")),
          ),
          update: (input) =>
            settings.update({ type: "update-managed-worktrees", input }).pipe(
              Effect.map((snapshot) => snapshot.managedWorktrees),
              Effect.mapError(mapError("update-managed-worktrees")),
            ),
        }),
      ),
    );
  }),
);
