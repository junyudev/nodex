import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ElectronIpc } from "../../platform/electron/ElectronIpc";
import type { CodexThreadTargets } from "../../codex-application/CodexThreadTargets";
import type { CodexCreatedThreadResolution } from "../../codex-application/CodexCreatedThreadResolution";

/** Registers the three explicit target operations inside the existing scoped IPC owner. */
export const registerCodexThreadTargetEndpoints = (
  ipc: Pick<ElectronIpc["Service"], "handleQuery" | "handlePlainCommand">,
  targets: CodexThreadTargets["Service"],
  resolution: CodexCreatedThreadResolution["Service"],
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* ipc.handlePlainCommand("codex:thread:ensure-open", (_, input) =>
      targets.ensureOpen(input),
    );
    yield* ipc.handleQuery("codex:thread:child-summary", (_, input) => targets.readSummary(input));
    yield* ipc.handleQuery("codex:created-thread:resolve", (_, input) => resolution.read(input));
  });
