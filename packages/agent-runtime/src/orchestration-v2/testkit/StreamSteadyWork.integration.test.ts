import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type OrchestrationV2StoredEvent,
  type ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@nodex/runtime-contracts";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@nodex/provider-testing/replayWorkspace";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@nodex/provider-testing/replayTranscript";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import {
  corpusStreamChunks,
  RUNTIME_CORPORA,
  runtimeCorpusManifest,
} from "../../../../../scripts/scenarios/runtime/corpora/runtime-corpora.ts";
import { createAgentRuntimeFrameDecoder } from "../../../../../src/main/platform/node/agent-runtime-framing.ts";
import {
  classifyRuntimeFrame,
  createRuntimeWorkLedger,
  runtimeWorkTotal,
  type RuntimeWorkLedger,
} from "../../../../../src/shared/diagnostics/runtime-work.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { encodeJsonLine } from "../../nodex/JsonLines.ts";
import { makeObservedEventDelivery } from "../../nodex/ObservedEvents.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  SIMPLE_PROMPT,
} from "./fixtures/shared.ts";
import type { OrchestratorV2ScenarioStep } from "./OrchestratorScenario.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { materializeReplayMessageIdentities } from "./ReplayMessageIdentities.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

/**
 * Bytes the Runtime sends Main for one observer while the `stream-steady` corpus streams: a
 * 128 KiB reasoning item, then a 32 KiB reply, each at about 1 KiB/s through the real Codex
 * Adapter, its text coalescer, paragraph streaming and the observer's own delivery, on a test
 * clock. Main's frame decoder counts every frame as Main receives it, by phase: reasoning until
 * the reply begins, then the reply.
 *
 * A transcript subscription, as every window's transcript is, receives a live item's next version
 * as a patch, so its text crosses once: one whole first version, then each update's fields and
 * appended text. Any other observer still receives whole events, each repeating the item's text.
 * Both are recorded; a regression in either fails here, and removed work lowers the numbers.
 */
const TRANSCRIPT_BASELINE = {
  // The reasoning node is still republished whole on every coalescer flush: 2,050 frames.
  reasoning: { frames: 2_382, bytes: 5_655_042 },
  assistant: { frames: 93, bytes: 96_872 },
} as const;
const WHOLE_EVENT_BASELINE = {
  reasoning: { frames: 2_382, bytes: 27_203_533 },
  assistant: { frames: 94, bytes: 1_606_022 },
} as const;
/**
 * What one patch frame may add beyond the text it appends: its envelope, item id, offset and
 * changed status fields. Measured at about 355 B on this corpus.
 */
const PATCH_OVERHEAD_BYTES = 400;
/** Main names each observation by its request's UUID, so frames carry one of this length. */
const SUBSCRIPTION_IDS: Readonly<Record<"transcript" | "events", string>> = {
  transcript: "00000000-0000-4000-8000-000000000001",
  events: "00000000-0000-4000-8000-000000000002",
};

const corpus = RUNTIME_CORPORA["stream-steady"];
const manifest = runtimeCorpusManifest(corpus);
const stream = corpus.stream!;
const reasoningItem = stream.items.find((item) => item.kind === "reasoning")!;
const assistantItem = stream.items.find((item) => item.kind === "assistant")!;
const REASONING_ID = "rs_stream_steady";

type Frame = { readonly method?: string; readonly params?: Record<string, unknown> };
const frameOf = (entry: ProviderReplayEntry): Frame =>
  "frame" in entry && typeof entry.frame === "object" && entry.frame !== null
    ? (entry.frame as Frame)
    : {};

/** The recorded one-turn Codex transcript with the corpus streamed into its turn. */
function streamSteadyTranscript(recorded: ProviderReplayTranscript): ProviderReplayTranscript {
  const entries = [...recorded.entries];
  const started = entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" &&
      frameOf(entry).method === "item/started" &&
      (frameOf(entry).params?.item as { type?: string } | undefined)?.type === "agentMessage",
  );
  const startedParams = frameOf(entries[started]!).params!;
  const identity = { threadId: startedParams.threadId, turnId: startedParams.turnId };
  const assistantId = (startedParams.item as { id: string }).id;
  const inbound = (label: string, method: string, params: object, afterMs?: number) =>
    ({
      type: "emit_inbound",
      label,
      frame: { method, params },
      ...(afterMs === undefined ? {} : { afterMs }),
    }) as ProviderReplayEntry;
  const reasoning = [
    inbound("item/started", "item/started", {
      ...identity,
      item: { type: "reasoning", id: REASONING_ID, summary: [], content: [] },
    }),
    inbound("item/reasoning/summaryPartAdded", "item/reasoning/summaryPartAdded", {
      ...identity,
      itemId: REASONING_ID,
      summaryIndex: 0,
    }),
    ...corpusStreamChunks(stream, reasoningItem).map((delta) =>
      inbound(
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryTextDelta",
        { ...identity, itemId: REASONING_ID, delta, summaryIndex: 0 },
        stream.intervalMs,
      ),
    ),
    inbound("item/completed", "item/completed", {
      ...identity,
      item: { type: "reasoning", id: REASONING_ID, summary: [reasoningItem.text], content: [] },
    }),
  ];
  const deltas = corpusStreamChunks(stream, assistantItem).map((delta) =>
    inbound(
      "item/agentMessage/delta",
      "item/agentMessage/delta",
      { ...identity, itemId: assistantId, delta },
      stream.intervalMs,
    ),
  );
  const withFinalText = (entry: ProviderReplayEntry): ProviderReplayEntry => {
    const frame = frameOf(entry);
    if (entry.type !== "emit_inbound") return entry;
    const replaceText = (item: unknown) =>
      (item as { id?: string }).id === assistantId
        ? { ...(item as object), text: assistantItem.text }
        : item;
    if (frame.method === "item/completed")
      return {
        ...entry,
        frame: { ...frame, params: { ...frame.params, item: replaceText(frame.params?.item) } },
      };
    if (frame.method === "turn/completed") {
      const turn = frame.params?.turn as { items: unknown[] };
      return {
        ...entry,
        frame: {
          ...frame,
          params: { ...frame.params, turn: { ...turn, items: turn.items.map(replaceText) } },
        },
      };
    }
    return entry;
  };
  const rest = entries
    .slice(started + 1)
    .filter((entry) => frameOf(entry).method !== "item/agentMessage/delta");
  return {
    ...recorded,
    scenario: "stream_steady",
    entries: [
      ...entries.slice(0, started),
      ...reasoning,
      entries[started]!,
      ...deltas,
      ...rest,
    ].map(withFinalText),
  };
}

const streamSteadyEvents = Effect.gen(function* () {
  const recorded = yield* readProviderReplayTranscript(
    new URL("./fixtures/simple/codex_transcript.ndjson", import.meta.url),
  ).pipe(Effect.provide(NodeServices.layer));
  const transcriptInput = materializeReplayTranscriptRuntimeInstructions(
    streamSteadyTranscript(recorded),
    { driver: ProviderDriverKind.make("codex"), model: CODEX_MODEL_SELECTION.model },
  );
  const workspace = yield* checkpointWorkspace("stream_steady");
  const materialized = yield* materializeFixtureInput({
    scenario: "stream_steady",
    fixtureInput: { steps: [{ type: "message", text: SIMPLE_PROMPT }] },
    driver: ProviderDriverKind.make("codex"),
    modelSelection: CODEX_MODEL_SELECTION,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
    materializeReplayMessageIdentities(
      materializeReplayTranscriptWorkspace(transcriptInput, workspace),
      materialized.commands,
    ),
  );
  // The provider paces its frames in test-clock time, so the clock moves one frame at a time.
  const threadId = materialized.projectionThreadIds[0]!;
  const steps: OrchestratorV2ScenarioStep[] = materialized.steps.map((step) =>
    step.type === "await_thread_idle"
      ? {
          type: "drive_clock_until_thread_idle",
          threadId,
          tick: Duration.millis(stream.intervalMs),
          limit: Duration.millis(manifest.streamDurationMs * 2),
        }
      : step,
  );
  const result = yield* runOrchestratorV2ProviderReplayScenario(
    {
      name: "stream_steady/codex",
      transcript,
      commands: materialized.commands,
      steps,
      projectionThreadIds: materialized.projectionThreadIds,
      runtimePolicyOverride: { cwd: workspace },
    },
    CodexOrchestratorReplayHarness,
    { responseStreamingMode: stream.streamingMode },
  ).pipe(provideDeterministicTestRuntime);
  return { result, threadId };
});

const isAssistantEvent = ({ event }: OrchestrationV2StoredEvent) =>
  (event.type === "turn-item.updated" && event.payload.type === "assistant_message") ||
  (event.type === "message.updated" && event.payload.role === "assistant") ||
  (event.type === "node.updated" && event.payload.kind === "assistant_message");

type Phase = "reasoning" | "assistant";
type Delivery = "transcript" | "events";

/** Feeds one observer's notifications through Main's frame decoder, counted by phase. */
const measureObserver = (
  stored: readonly OrchestrationV2StoredEvent[],
  delivery: Delivery,
  ledger: RuntimeWorkLedger,
) =>
  Effect.gen(function* () {
    let phase: Phase = "reasoning";
    const decoder = createAgentRuntimeFrameDecoder(16 * 1024 * 1024, (frame, bytes) => {
      const described = classifyRuntimeFrame(frame);
      if (described?.kind === "event")
        ledger.record(`${delivery}:${phase}`, described.metric, bytes);
    });
    const observe = makeObservedEventDelivery(SUBSCRIPTION_IDS[delivery], delivery);
    for (const event of stored) {
      if (isAssistantEvent(event)) phase = "assistant";
      const notification = yield* observe(event);
      if (notification !== null)
        decoder.push(new TextEncoder().encode(encodeJsonLine(notification)));
    }
    decoder.finish();
  });

const ITEM_TYPE: Readonly<Record<Phase, string>> = {
  reasoning: "reasoning",
  assistant: "assistant_message",
};

describe("stream-steady Runtime → Main work", () => {
  // oxlint-disable-next-line nodex/no-explicit-test-timeout -- 159 s of provider frames cross the Codex Adapter one test-clock tick at a time.
  it.effect(
    "sends a transcript each streamed byte once, and records whole-event observers",
    () =>
      Effect.gen(function* () {
        const { result, threadId } = yield* streamSteadyEvents;
        const stored = result.storedEvents.filter((event) => event.event.threadId === threadId);
        const ledger = createRuntimeWorkLedger();
        yield* measureObserver(stored, "transcript", ledger);
        yield* measureObserver(stored, "events", ledger);

        const finalBytes: Readonly<Record<Phase, number>> = {
          reasoning: manifest.streamReasoningBytes,
          assistant: manifest.streamAssistantBytes,
        };
        const measured = (delivery: Delivery, phase: Phase) => {
          const reading = ledger.read(`${delivery}:${phase}`);
          const whole = reading[`runtime.event:turn-item.updated:${ITEM_TYPE[phase]}`] ?? {
            count: 0,
            bytes: 0,
            rows: 0,
          };
          const patches = reading["runtime.event:item-patch"] ?? { count: 0, bytes: 0, rows: 0 };
          const all = runtimeWorkTotal(reading, "runtime.event:");
          return {
            frames: all.count,
            bytes: all.bytes,
            item: { whole, patches, bytes: whole.bytes + patches.bytes },
            itemRatio: (whole.bytes + patches.bytes) / finalBytes[phase],
            ratio: all.bytes / finalBytes[phase],
            reading,
          };
        };
        const transcript = {
          reasoning: measured("transcript", "reasoning"),
          assistant: measured("transcript", "assistant"),
        };
        const events = {
          reasoning: measured("events", "reasoning"),
          assistant: measured("events", "assistant"),
        };
        console.info(
          JSON.stringify({
            corpus: { id: manifest.id, revision: manifest.revision, sha256: manifest.sha256 },
            transcript,
            events,
          }),
        );

        // The streamed text arrives whole: the final updates carry every corpus byte.
        const final = (type: "reasoning" | "assistant_message") =>
          stored
            .flatMap(({ event }) =>
              event.type === "turn-item.updated" && event.payload.type === type
                ? [event.payload]
                : [],
            )
            .at(-1);
        assert.strictEqual((final("reasoning") as { text?: string })?.text, reasoningItem.text);
        assert.strictEqual(
          (final("assistant_message") as { text?: string })?.text,
          assistantItem.text,
        );

        for (const phase of ["reasoning", "assistant"] as const) {
          const { item } = transcript[phase];
          // A transcript receives one whole first version of the streamed item, then patches.
          assert.strictEqual(item.whole.count, 1);
          assert.isAbove(item.patches.count, 2);
          // Linear: each appended byte crosses once, plus a bounded envelope per patch.
          assert.isAtMost(
            item.bytes,
            item.whole.bytes + PATCH_OVERHEAD_BYTES * item.patches.count + finalBytes[phase],
          );
          // Regression gates: no more frames or bytes than today's deliveries send.
          assert.isAtMost(transcript[phase].frames, TRANSCRIPT_BASELINE[phase].frames);
          assert.isAtMost(transcript[phase].bytes, TRANSCRIPT_BASELINE[phase].bytes);
          assert.isAtMost(events[phase].frames, WHOLE_EVENT_BASELINE[phase].frames);
          assert.isAtMost(events[phase].bytes, WHOLE_EVENT_BASELINE[phase].bytes);
        }
      }).pipe(Effect.scoped),
    { timeout: 600_000 },
  );
});
