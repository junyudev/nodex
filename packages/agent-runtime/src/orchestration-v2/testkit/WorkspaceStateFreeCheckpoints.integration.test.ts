import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProviderDriverKind } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { rollbackThread } from "../../nodex/Rollback.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { ThreadManagementService } from "../ThreadManagementService.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { multiTurnInput } from "./fixtures/multi_turn/input.ts";
import { CODEX_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { layerProviderReplay } from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

/** A committed repository whose hooks are disabled, so only the code under test can write. */
const gitWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-workspace-state-free-" });
  const hooks = path.join(cwd, ".no-hooks");
  yield* fs.makeDirectory(hooks);
  const git = (...args: ReadonlyArray<string>) =>
    spawner.exitCode(ChildProcess.make("git", args, { cwd })).pipe(Effect.orDie);
  yield* git("init");
  yield* git("config", "core.hooksPath", hooks);
  yield* git("config", "user.name", "Nodex Test");
  yield* git("config", "user.email", "nodex-test@example.com");
  yield* fs.writeFileString(path.join(cwd, "README.md"), "# Workspace\n");
  yield* fs.writeFileString(path.join(cwd, ".gitignore"), ".no-hooks\n");
  yield* git("add", "README.md", ".gitignore");
  yield* git("commit", "-m", "initial");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

/**
 * Every ref and the working tree status. Notes that local Git tooling attaches to the fixture's
 * own commit are not repository state written by the Runtime.
 */
const repositoryState = (cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const git = (...args: ReadonlyArray<string>) =>
      spawner
        .streamString(ChildProcess.make("git", args, { cwd }))
        .pipe(Stream.mkString, Effect.orDie);
    return {
      refs: (yield* git("for-each-ref"))
        .split("\n")
        .filter((line) => line !== "" && !line.includes("\trefs/notes/")),
      status: yield* git("status", "--porcelain"),
    };
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("finishes Runs and rewinds in a Git workspace without writing to the repository", () =>
  Effect.gen(function* () {
    const recorded = yield* readProviderReplayTranscript(
      new URL("./fixtures/multi_turn/codex_transcript.ndjson", import.meta.url),
    ).pipe(Effect.provide(NodeServices.layer));
    const workspace = yield* gitWorkspace;
    const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptWorkspace(
        materializeReplayTranscriptRuntimeInstructions(recorded, {
          driver: ProviderDriverKind.make("codex"),
          model: CODEX_MODEL_SELECTION.model,
        }),
        workspace,
      ),
    );
    const materialized = yield* materializeFixtureInput({
      scenario: "workspace-state-free",
      fixtureInput: multiTurnInput(),
      driver: ProviderDriverKind.make("codex"),
      modelSelection: CODEX_MODEL_SELECTION,
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const scenario = {
      name: "workspace-state-free/codex",
      transcript,
      commands: materialized.commands,
      steps: materialized.steps,
      projectionThreadIds: materialized.projectionThreadIds,
      runtimePolicyOverride: { cwd: workspace },
    };
    const threadId = materialized.projectionThreadIds[0]!;
    const before = yield* repositoryState(workspace);
    const replayGate = makeProviderReplayGate([]);

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* runOrchestratorV2Scenario(scenario, { replayGate });
      const finished = yield* orchestrator.getThreadRecords(threadId, ["runs", "checkpoints"]);
      assert.deepEqual(
        finished.runs.map((run) => run.status),
        ["completed", "completed"],
      );
      // Each finished Run still receives its conversation anchor, with no workspace state.
      assert.deepEqual(
        finished.checkpoints
          .filter((checkpoint) => checkpoint.runId !== null)
          .map((checkpoint) => [checkpoint.appRunOrdinal, checkpoint.status, checkpoint.files]),
        [
          [1, "missing", []],
          [2, "missing", []],
        ],
      );

      const lastRun = finished.runs[1]!;
      const accepted = yield* rollbackThread({
        threadId,
        requestId: CommandId.make("rewind-workspace-state-free"),
        runId: lastRun.id,
      }).pipe(
        Effect.provide(
          Layer.mock(ThreadManagementService)({
            getReceipt: orchestrator.getReceipt,
            getCheckpointContext: orchestrator.getCheckpointContext,
            getThreadRecords: orchestrator.getThreadRecords,
            dispatch: orchestrator.dispatch,
          }),
        ),
        Effect.provide(IdAllocator.layer),
      );
      assert.equal(accepted.userMessageId, lastRun.userMessageId);
      // The rewind targets the first Run's anchor and never restores files.
      const firstAnchor = finished.checkpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === 1,
      )!;
      const providerThreadId = finished.thread.activeProviderThreadId!;
      const rollback = yield* (yield* EffectOutbox.EffectOutboxV2).get(
        `effect:${accepted.commandId}:provider-thread.rollback:${providerThreadId}:${firstAnchor.id}`,
      );
      assert.isTrue(Option.isSome(rollback));
      assert.deepInclude(Option.getOrThrow(rollback).request, {
        type: "provider-thread.rollback",
        beforeRunId: lastRun.id,
        checkpointId: firstAnchor.id,
        restoreFiles: false,
      });
    }).pipe(
      Effect.provide(
        layerProviderReplay(scenario, CodexOrchestratorReplayHarness, {
          replayGate,
          checkpointStoreLayer: CheckpointStore.layerWithoutWorkspaceState,
        }),
      ),
      provideDeterministicTestRuntime,
    );

    assert.deepEqual(yield* repositoryState(workspace), before);
  }).pipe(Effect.scoped),
);
