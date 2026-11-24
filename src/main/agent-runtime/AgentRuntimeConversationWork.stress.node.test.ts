import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { RUNTIME_CORPORA } from "../../../scripts/scenarios/runtime/corpora/runtime-corpora";
import {
  conversationWorkHarness,
  counts,
  OPEN_MAIN_WORK,
  OPEN_RENDERER_REQUESTS,
  openConversation,
  recorded,
} from "./AgentRuntimeConversationWork.test-support";

/** Today's bounded snapshot: the latest five user Turns, never the whole history. */
const SNAPSHOT_TURNS = 5;
/** Each settled Turn installs its prompt, its reply and its checkpoint. */
const SNAPSHOT_ROWS = SNAPSHOT_TURNS * 3;

/** Today's snapshot excluding fixture metadata. The prompt index lists all 500 Runs. */
const LONG_SNAPSHOT_BYTES = 67_010;
const LONG_PROMPT_INDEX_BYTES = 269_454;

// oxlint-disable-next-line nodex/no-explicit-test-timeout -- Five hundred real Turns cross the Agent Runtime and its Codex fixture before anything is measured.
it.live(
  "runtime-500-turn: opening a long conversation does the same work as a short one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const corpus = RUNTIME_CORPORA["runtime-500-turn"];
        const harness = yield* conversationWorkHarness(corpus);
        const opened = yield* openConversation(harness, 1, SNAPSHOT_TURNS);
        const main = harness.mainWork.read(opened.mainWorkId);
        const renderer = harness.rendererWork.read(opened.workId);
        // The prompt rail reads its index on its own; it is the one read that grows with history.
        const index = yield* Effect.promise(() => opened.owner.readPromptIndex());
        const promptIndex = harness.mainWork.read(opened.mainWorkId)[
          "runtime.reply:thread.prompt-index"
        ];
        console.info(
          JSON.stringify({
            corpus: corpus.id,
            main: counts(main),
            snapshot: main["runtime.reply:thread.snapshot"],
            promptIndex,
            renderer: counts(renderer),
          }),
        );
        opened.close();

        expect(recorded(renderer, OPEN_RENDERER_REQUESTS)).toEqual(OPEN_RENDERER_REQUESTS);
        expect(recorded(main, OPEN_MAIN_WORK)).toEqual(OPEN_MAIN_WORK);
        expect(main["runtime.reply:thread.snapshot"]?.rows).toBe(SNAPSHOT_ROWS);
        expect(main["runtime.reply:thread.snapshot"]?.bytes).toBeLessThanOrEqual(
          LONG_SNAPSHOT_BYTES + harness.snapshotFixtureMetadataBytes,
        );
        expect(renderer["renderer.install"]?.rows).toBe(SNAPSHOT_ROWS);
        expect(index).toHaveLength(corpus.turns.length);
        expect(promptIndex?.bytes).toBeLessThanOrEqual(LONG_PROMPT_INDEX_BYTES);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  600_000,
);
