import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type {
  AgentImportApplyInput,
  AgentImportResult,
  AgentImportScan,
  AgentImportSourceKind,
} from "../../shared/agent-import";
import {
  makeAgentImportOperations,
  type AgentImportFileConfiguration,
  type PendingImportScan,
} from "../codex/agent-import-operations";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexExternalAgentImportRuntime } from "./CodexExternalAgentImportRuntime";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";

export class AgentImportRuntimeError extends Data.TaggedError("AgentImportRuntimeError")<{
  readonly reason: "apply-failed" | "closed" | "concurrent-import" | "expired-scan" | "scan-failed";
  readonly cause: unknown;
}> {}

interface AgentImportState {
  readonly applying: boolean;
  readonly closed: boolean;
  readonly scans: HashMap.HashMap<string, PendingImportScan>;
}

export class AgentImportRuntime extends Context.Service<
  AgentImportRuntime,
  {
    readonly scan: (
      sourceKind: AgentImportSourceKind,
      selectedSourceHome?: string,
    ) => Effect.Effect<AgentImportScan, AgentImportRuntimeError>;
    readonly apply: (
      input: AgentImportApplyInput,
    ) => Effect.Effect<AgentImportResult, AgentImportRuntimeError>;
    readonly snapshot: Effect.Effect<{
      readonly applying: boolean;
      readonly closed: boolean;
      readonly scanIds: readonly string[];
    }>;
  }
>()("nodex/main/codex-application/AgentImportRuntime") {}

export type AgentImportRuntimeOptions = AgentImportFileConfiguration;

type ApplyAdmission =
  | { readonly _tag: "admitted"; readonly scan: PendingImportScan }
  | { readonly _tag: "closed" }
  | { readonly _tag: "concurrent-import" }
  | { readonly _tag: "expired-scan" };

const pruneExpired = (state: AgentImportState, now: number): AgentImportState => ({
  ...state,
  scans: HashMap.filter(state.scans, (pending) => pending.scan.expiresAt > now),
});

const runtimeError = (
  reason: AgentImportRuntimeError["reason"],
  cause: unknown,
): AgentImportRuntimeError => new AgentImportRuntimeError({ reason, cause });

export const make = (
  options: AgentImportRuntimeOptions,
): Effect.Effect<
  AgentImportRuntime["Service"],
  never,
  | CodexAppServerCapabilities
  | CodexApplicationEventHub
  | CodexExternalAgentImportRuntime
  | CodexGateway
  | CodexSidebarSyncRuntime
  | CodexThreadDirectory
  | ThreadCreationRuntime
  | CodexThreadTitlePersistence
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const operations = makeAgentImportOperations(options, {
      capabilities: yield* CodexAppServerCapabilities,
      events: yield* CodexApplicationEventHub,
      externalImport: yield* CodexExternalAgentImportRuntime,
      gateway: yield* CodexGateway,
      sidebarSync: yield* CodexSidebarSyncRuntime,
      threadDirectory: yield* CodexThreadDirectory,
      threadStarts: yield* ThreadCreationRuntime,
      threadTitles: yield* CodexThreadTitlePersistence,
    });
    const state = yield* Ref.make<AgentImportState>({
      applying: false,
      closed: false,
      scans: HashMap.empty(),
    });
    yield* Effect.addFinalizer(() =>
      Ref.set(state, {
        applying: false,
        closed: true,
        scans: HashMap.empty(),
      }),
    );
    const scan = (sourceKind: AgentImportSourceKind, selectedSourceHome?: string) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const prepared = yield* operations
          .scan(sourceKind, selectedSourceHome, startedAt)
          .pipe(Effect.mapError((cause) => runtimeError("scan-failed", cause)));
        const committed = yield* Ref.modify(state, (current) => {
          if (current.closed) return [false, current] as const;
          const currentScans = pruneExpired(current, startedAt).scans;
          return [
            true,
            {
              ...current,
              scans: HashMap.set(currentScans, prepared.scan.scanId, prepared),
            },
          ] as const;
        });
        if (!committed) {
          return yield* Effect.fail(
            runtimeError("closed", new Error("Agent import runtime is closed")),
          );
        }
        return prepared.scan;
      });

    const releaseApplyAdmission = Ref.update(state, (current) =>
      current.closed ? current : { ...current, applying: false },
    );

    const apply = (input: AgentImportApplyInput) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const admission = yield* Ref.modify(
          state,
          (current): readonly [ApplyAdmission, AgentImportState] => {
            if (current.closed) return [{ _tag: "closed" }, current];
            const currentState = pruneExpired(current, startedAt);
            if (currentState.applying) return [{ _tag: "concurrent-import" }, currentState];
            const pending = Option.getOrUndefined(HashMap.get(currentState.scans, input.scanId));
            if (!pending) return [{ _tag: "expired-scan" }, currentState];
            return [
              { _tag: "admitted", scan: pending },
              { ...currentState, applying: true },
            ];
          },
        );
        if (admission._tag === "closed") {
          return yield* Effect.fail(
            runtimeError("closed", new Error("Agent import runtime is closed")),
          );
        }
        if (admission._tag === "concurrent-import") {
          return yield* Effect.fail(
            runtimeError("concurrent-import", new Error("Another agent import is already running")),
          );
        }
        if (admission._tag === "expired-scan") {
          return yield* Effect.fail(
            runtimeError(
              "expired-scan",
              new Error("This import preview expired. Scan the source again."),
            ),
          );
        }

        return yield* Effect.gen(function* () {
          const importId = yield* Effect.sync(() => operations.makeImportId());
          const result = yield* operations
            .apply(input, admission.scan, importId, startedAt)
            .pipe(Effect.mapError((cause) => runtimeError("apply-failed", cause)));
          const completedAt = yield* Clock.currentTimeMillis;
          const committed = yield* Ref.modify(state, (current) => {
            if (current.closed) return [false, current] as const;
            return [
              true,
              {
                ...current,
                scans: HashMap.remove(current.scans, input.scanId),
              },
            ] as const;
          });
          if (!committed) {
            return yield* Effect.fail(
              runtimeError("closed", new Error("Agent import runtime is closed")),
            );
          }
          return { ...result, completedAt };
        }).pipe(Effect.ensuring(releaseApplyAdmission));
      });

    return AgentImportRuntime.of({
      scan,
      apply,
      snapshot: Ref.get(state).pipe(
        Effect.map((current) => ({
          applying: current.applying,
          closed: current.closed,
          scanIds: [...HashMap.keys(current.scans)].sort(),
        })),
      ),
    });
  });
