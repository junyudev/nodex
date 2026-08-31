import { describe, expect, test } from "vite-plus/test";
import {
  advanceRendererDeliveryAcknowledgment,
  advanceRendererDeliveryAssembler,
  createRendererDeliveryAssemblerState,
  encodeRendererDelivery,
  parseRendererDeliveryEnvelope,
  releaseRendererDeliveryTarget,
  RENDERER_DELIVERY_CHUNK_BYTES,
  RENDERER_DELIVERY_INLINE_MAX_BYTES,
  RENDERER_DELIVERY_MAX_ACTIVE_TRANSFERS,
  RENDERER_DELIVERY_MAX_APPROXIMATE_PAYLOAD_BYTES,
  RENDERER_DELIVERY_MAX_CHUNKS,
  RENDERER_DELIVERY_MAX_ENCODED_BYTES,
  RENDERER_DELIVERY_MAX_JSON_DEPTH,
  RENDERER_DELIVERY_MAX_REASSEMBLY_BYTES,
  RENDERER_DELIVERY_WIRE_VERSION,
  RendererDeliveryTransportError,
  type RendererDeliveryAssemblerState,
  type RendererDeliveryCompletedPayload,
  type RendererDeliveryDispatch,
  type RendererDeliveryTransferStartEnvelope,
} from "./renderer-delivery-transport";

const TARGET = { targetId: "renderer:thread:one", generation: 7 } as const;

function expectError(code: RendererDeliveryTransportError["code"], run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RendererDeliveryTransportError);
    expect((error as RendererDeliveryTransportError).code).toBe(code);
    return;
  }
  throw new Error(`Expected RendererDeliveryTransportError(${code})`);
}

function transferDispatch(payload: unknown, transferId = "transfer:one") {
  const dispatch = encodeRendererDelivery({ target: TARGET, transferId, payload });
  if (dispatch.kind !== "transfer") throw new Error("Expected a chunked transfer");
  return dispatch;
}

function startEnvelope(input: {
  readonly targetId?: string;
  readonly generation?: number;
  readonly transferId: string;
  readonly encodedBytes?: number;
}): RendererDeliveryTransferStartEnvelope {
  const encodedBytes = input.encodedBytes ?? RENDERER_DELIVERY_INLINE_MAX_BYTES + 1;
  return {
    version: RENDERER_DELIVERY_WIRE_VERSION,
    kind: "transferStart",
    targetId: input.targetId ?? TARGET.targetId,
    generation: input.generation ?? TARGET.generation,
    transferId: input.transferId,
    sequence: 0,
    encodedBytes,
    chunkCount: Math.ceil(encodedBytes / RENDERER_DELIVERY_CHUNK_BYTES),
  };
}

function assemble(dispatch: RendererDeliveryDispatch): {
  readonly delivery: RendererDeliveryCompletedPayload;
  readonly state: RendererDeliveryAssemblerState;
} {
  let state = createRendererDeliveryAssemblerState();
  let acknowledgment = dispatch.acknowledgment;
  let delivery: RendererDeliveryCompletedPayload | null = null;
  for (const envelope of dispatch.envelopes) {
    const transition = advanceRendererDeliveryAssembler(state, envelope);
    state = transition.state;
    if (transition.kind === "complete") delivery = transition.delivery;
    if (transition.kind === "aborted" || !transition.acknowledgment || !acknowledgment) continue;
    const result = advanceRendererDeliveryAcknowledgment(acknowledgment, transition.acknowledgment);
    acknowledgment = result.state;
  }
  if (!delivery) throw new Error("Expected a completed delivery");
  if (acknowledgment) throw new Error("Expected every transfer frame to be acknowledged");
  return { delivery, state };
}

describe("renderer delivery payload codec", () => {
  test("round-trips a bounded inline JSON payload", () => {
    const payload = {
      title: "长线程 🚀",
      turns: [1, true, null, { text: "finished" }],
    };
    const dispatch = encodeRendererDelivery({
      target: TARGET,
      transferId: "unused:inline",
      payload,
    });

    expect(dispatch.kind).toBe("inline");
    const envelope = parseRendererDeliveryEnvelope(dispatch.envelopes[0]);
    expect(envelope.kind).toBe("inline");
    const assembled = assemble(dispatch);
    expect(assembled.delivery).toEqual({ ...TARGET, transferId: null, payload });
    expect(assembled.state).toMatchObject({ activeTransferCount: 0, reassemblyBytes: 0 });
  });

  test("uses the exact 4 MiB UTF-8 inline threshold", () => {
    const exact = encodeRendererDelivery({
      target: TARGET,
      transferId: "threshold:inline",
      payload: "a".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES - 2),
    });
    expect(exact.kind).toBe("inline");
    if (exact.kind !== "inline") throw new Error("Expected inline threshold payload");
    expect(exact.envelopes[0].encodedBytes).toBe(RENDERER_DELIVERY_INLINE_MAX_BYTES);

    const over = encodeRendererDelivery({
      target: TARGET,
      transferId: "threshold:transfer",
      payload: "a".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES - 1),
    });
    expect(over.kind).toBe("transfer");
  });

  test("counts JSON escaping and UTF-8 bytes before serialization", () => {
    const payload = {
      ascii: 'quote " slash \\ newline\n',
      unicode: "长线程 🚀",
      loneSurrogate: "\ud800",
      numbers: [-0, 1.5, 1e100],
    };
    const dispatch = encodeRendererDelivery({
      target: TARGET,
      transferId: "exact:encoded-size",
      payload,
    });
    const expected = new TextEncoder().encode(JSON.stringify(payload)).byteLength;

    expect(dispatch.envelopes[0]).toMatchObject({ encodedBytes: expected });
  });

  test("rejects cyclic, unsupported, non-finite, accessor, and over-deep payloads", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const withAccessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "hidden work",
    });
    let tooDeep: unknown = "leaf";
    for (let depth = 0; depth <= RENDERER_DELIVERY_MAX_JSON_DEPTH; depth += 1) {
      tooDeep = [tooDeep];
    }

    for (const payload of [
      cyclic,
      { value: undefined },
      { value: Number.POSITIVE_INFINITY },
      new Date(0),
      withAccessor,
      tooDeep,
    ]) {
      expectError("invalidPayload", () =>
        encodeRendererDelivery({ target: TARGET, transferId: "invalid", payload }),
      );
    }
  });

  test("rejects an oversized object graph before walking or stringifying it", () => {
    const sparse = new Array(Math.floor(RENDERER_DELIVERY_MAX_APPROXIMATE_PAYLOAD_BYTES / 8) + 1);

    expectError("payloadTooLarge", () =>
      encodeRendererDelivery({
        target: TARGET,
        transferId: "oversized:preflight",
        payload: sparse,
      }),
    );
  });

  test("strictly parses envelope shape, byte metadata, and transfer budgets", () => {
    const inlineDispatch = encodeRendererDelivery({
      target: TARGET,
      transferId: "inline",
      payload: { ok: true },
    });
    if (inlineDispatch.kind !== "inline") throw new Error("Expected inline payload");
    const inline = inlineDispatch.envelopes[0];
    expectError("invalidEnvelope", () =>
      parseRendererDeliveryEnvelope({ ...inline, unexpected: true }),
    );
    expectError("invalidEnvelope", () =>
      parseRendererDeliveryEnvelope({ ...inline, encodedBytes: inline.encodedBytes + 1 }),
    );
    expectError("invalidEnvelope", () =>
      parseRendererDeliveryEnvelope(
        startEnvelope({
          transferId: "oversized",
          encodedBytes: RENDERER_DELIVERY_MAX_ENCODED_BYTES + 1,
        }),
      ),
    );
    expect(RENDERER_DELIVERY_MAX_CHUNKS).toBe(
      RENDERER_DELIVERY_MAX_ENCODED_BYTES / RENDERER_DELIVERY_CHUNK_BYTES,
    );
    expectError("payloadTooLarge", () =>
      encodeRendererDelivery({
        target: TARGET,
        transferId: "payload:oversized",
        payload: "a".repeat(RENDERER_DELIVERY_MAX_ENCODED_BYTES - 1),
      }),
    );
  });

  test("rejects malformed UTF-8, malformed JSON, and parsed non-finite numbers", () => {
    const inline = (payloadUtf8: Uint8Array) => ({
      version: RENDERER_DELIVERY_WIRE_VERSION,
      kind: "inline",
      targetId: TARGET.targetId,
      generation: TARGET.generation,
      encodedBytes: payloadUtf8.byteLength,
      payloadUtf8,
    });

    expectError("invalidUtf8", () =>
      advanceRendererDeliveryAssembler(
        createRendererDeliveryAssemblerState(),
        inline(new Uint8Array([0xff])),
      ),
    );
    expectError("invalidJson", () =>
      advanceRendererDeliveryAssembler(
        createRendererDeliveryAssemblerState(),
        inline(new TextEncoder().encode("{")),
      ),
    );
    expectError("invalidPayload", () =>
      advanceRendererDeliveryAssembler(
        createRendererDeliveryAssemblerState(),
        inline(new TextEncoder().encode("1e400")),
      ),
    );
  });
});

describe("renderer delivery transfer state machine", () => {
  test("assembles ordered chunks, validates every ACK, and releases all bytes", () => {
    const payload = {
      prefix: "chunked",
      body: "界".repeat(Math.ceil(RENDERER_DELIVERY_INLINE_MAX_BYTES / 3)),
    };
    const dispatch = transferDispatch(payload);
    const chunks = dispatch.envelopes.filter((envelope) => envelope.kind === "transferChunk");

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => chunk.payloadUtf8.byteLength <= RENDERER_DELIVERY_CHUNK_BYTES),
    ).toBe(true);
    const assembled = assemble(dispatch);
    expect(assembled.delivery).toEqual({ ...TARGET, transferId: "transfer:one", payload });
    expect(assembled.state).toMatchObject({ activeTransferCount: 0, reassemblyBytes: 0 });
  });

  test("rejects wrong identity, reordered chunks, and an end with missing fragments", () => {
    const dispatch = transferDispatch("a".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES));
    const [start, firstChunk, secondChunk, ...remaining] = dispatch.envelopes;
    const end = remaining.at(-1);
    if (
      start?.kind !== "transferStart" ||
      firstChunk?.kind !== "transferChunk" ||
      secondChunk?.kind !== "transferChunk" ||
      end?.kind !== "transferEnd"
    ) {
      throw new Error("Expected transfer frame ordering");
    }
    const started = advanceRendererDeliveryAssembler(createRendererDeliveryAssemblerState(), start);

    expectError("unknownTransfer", () =>
      advanceRendererDeliveryAssembler(started.state, {
        ...firstChunk,
        generation: firstChunk.generation + 1,
      }),
    );
    expectError("unexpectedSequence", () =>
      advanceRendererDeliveryAssembler(started.state, secondChunk),
    );

    const afterFirst = advanceRendererDeliveryAssembler(started.state, firstChunk);
    expectError("unexpectedSequence", () =>
      advanceRendererDeliveryAssembler(afterFirst.state, end),
    );
  });

  test("validates ACK identity and exact sequence without advancing on mismatch", () => {
    const dispatch = transferDispatch("a".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES));
    const start = dispatch.envelopes[0];
    if (start?.kind !== "transferStart") throw new Error("Expected transfer start");
    const accepted = advanceRendererDeliveryAssembler(
      createRendererDeliveryAssemblerState(),
      start,
    );
    if (accepted.kind !== "accepted") throw new Error("Expected accepted transfer start");

    expectError("acknowledgmentMismatch", () =>
      advanceRendererDeliveryAcknowledgment(dispatch.acknowledgment, {
        ...accepted.acknowledgment,
        targetId: "renderer:other",
      }),
    );
    expectError("acknowledgmentMismatch", () =>
      advanceRendererDeliveryAcknowledgment(dispatch.acknowledgment, {
        ...accepted.acknowledgment,
        sequence: 1,
      }),
    );
    const advanced = advanceRendererDeliveryAcknowledgment(
      dispatch.acknowledgment,
      accepted.acknowledgment,
    );
    expect(advanced).toMatchObject({ complete: false, state: { expectedSequence: 1 } });
    expectError("acknowledgmentMismatch", () =>
      advanceRendererDeliveryAcknowledgment(advanced.state!, accepted.acknowledgment),
    );
  });

  test("bounds active transfers before accepting payload bytes", () => {
    let state = createRendererDeliveryAssemblerState();
    for (let index = 0; index < RENDERER_DELIVERY_MAX_ACTIVE_TRANSFERS; index += 1) {
      state = advanceRendererDeliveryAssembler(
        state,
        startEnvelope({ transferId: `active:${index}` }),
      ).state;
    }
    expect(state.activeTransferCount).toBe(RENDERER_DELIVERY_MAX_ACTIVE_TRANSFERS);
    expectError("activeTransferLimit", () =>
      advanceRendererDeliveryAssembler(state, startEnvelope({ transferId: "active:overflow" })),
    );
  });

  test("bounds aggregate reassembly bytes and releases a target generation", () => {
    const fullStart = startEnvelope({
      transferId: "full",
      encodedBytes: RENDERER_DELIVERY_MAX_REASSEMBLY_BYTES,
    });
    const otherStart = startEnvelope({
      transferId: "other-generation",
      generation: TARGET.generation + 1,
    });
    let state = advanceRendererDeliveryAssembler(
      createRendererDeliveryAssemblerState(),
      fullStart,
    ).state;
    state = advanceRendererDeliveryAssembler(state, otherStart).state;
    const reusableChunk = new Uint8Array(RENDERER_DELIVERY_CHUNK_BYTES);
    for (let sequence = 1; sequence <= fullStart.chunkCount; sequence += 1) {
      state = advanceRendererDeliveryAssembler(state, {
        version: RENDERER_DELIVERY_WIRE_VERSION,
        kind: "transferChunk",
        targetId: fullStart.targetId,
        generation: fullStart.generation,
        transferId: fullStart.transferId,
        sequence,
        payloadUtf8: reusableChunk,
      }).state;
    }
    expect(state.reassemblyBytes).toBe(RENDERER_DELIVERY_MAX_REASSEMBLY_BYTES);
    expectError("reassemblyLimit", () =>
      advanceRendererDeliveryAssembler(state, {
        version: RENDERER_DELIVERY_WIRE_VERSION,
        kind: "transferChunk",
        targetId: otherStart.targetId,
        generation: otherStart.generation,
        transferId: otherStart.transferId,
        sequence: 1,
        payloadUtf8: reusableChunk,
      }),
    );

    const released = releaseRendererDeliveryTarget(state, TARGET);
    expect(released.releasedTransferIds).toEqual(["full"]);
    expect(released.state).toMatchObject({ activeTransferCount: 1, reassemblyBytes: 0 });
    const afterRelease = advanceRendererDeliveryAssembler(released.state, {
      version: RENDERER_DELIVERY_WIRE_VERSION,
      kind: "transferChunk",
      targetId: otherStart.targetId,
      generation: otherStart.generation,
      transferId: otherStart.transferId,
      sequence: 1,
      payloadUtf8: reusableChunk,
    });
    expect(afterRelease.state.reassemblyBytes).toBe(RENDERER_DELIVERY_CHUNK_BYTES);
  });

  test("protects installed bytes from sender mutation", () => {
    const payload = "a".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES);
    const dispatch = transferDispatch(payload);
    const start = dispatch.envelopes[0];
    const firstChunk = dispatch.envelopes[1];
    if (start?.kind !== "transferStart" || firstChunk?.kind !== "transferChunk") {
      throw new Error("Expected transfer start and chunk");
    }
    let transition = advanceRendererDeliveryAssembler(
      createRendererDeliveryAssemblerState(),
      start,
    );
    transition = advanceRendererDeliveryAssembler(transition.state, firstChunk);
    firstChunk.payloadUtf8.fill(0);

    let delivery: RendererDeliveryCompletedPayload | null = null;
    for (const envelope of dispatch.envelopes.slice(2)) {
      transition = advanceRendererDeliveryAssembler(transition.state, envelope);
      if (transition.kind === "complete") delivery = transition.delivery;
    }
    expect(delivery?.payload).toBe(payload);
  });

  test("honors transfer abort and releases its buffered bytes", () => {
    const dispatch = transferDispatch("a".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES));
    const start = dispatch.envelopes[0];
    const chunk = dispatch.envelopes[1];
    if (start?.kind !== "transferStart" || chunk?.kind !== "transferChunk") {
      throw new Error("Expected transfer start and chunk");
    }
    let transition = advanceRendererDeliveryAssembler(
      createRendererDeliveryAssemblerState(),
      start,
    );
    transition = advanceRendererDeliveryAssembler(transition.state, chunk);
    const aborted = advanceRendererDeliveryAssembler(transition.state, {
      version: RENDERER_DELIVERY_WIRE_VERSION,
      kind: "transferAbort",
      targetId: start.targetId,
      generation: start.generation,
      transferId: start.transferId,
      reason: "superseded",
    });
    expect(aborted).toMatchObject({
      kind: "aborted",
      transferId: start.transferId,
      reason: "superseded",
      state: { activeTransferCount: 0, reassemblyBytes: 0 },
    });
  });
});
