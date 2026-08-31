import { describe, expect, test } from "vite-plus/test";
import {
  RENDERER_DELIVERY_INLINE_MAX_BYTES,
  encodeRendererDelivery,
  type RendererDeliveryJsonValue,
  type RendererDeliveryTransferAckEnvelope,
} from "./renderer-delivery-transport";
import { createRendererDeliveryPreloadBridge } from "./renderer-delivery-preload-bridge";

const target = (generation: number, targetId = "renderer:one") => ({ targetId, generation });

const dispatch = (payload: RendererDeliveryJsonValue, generation = 1, targetId = "renderer:one") =>
  encodeRendererDelivery({
    target: target(generation, targetId),
    transferId: "transfer:one",
    payload,
  });

describe("renderer delivery preload bridge", () => {
  test("replays inline deliveries through the original channel without an ACK", () => {
    const acknowledgments: RendererDeliveryTransferAckEnvelope[] = [];
    const received: unknown[][] = [];
    const bridge = createRendererDeliveryPreloadBridge({
      acknowledge: (acknowledgment) => acknowledgments.push(acknowledgment),
      reportError: (message) => {
        throw new Error(message);
      },
    });
    bridge.subscribe("codex:event", (...args) => received.push([...args]));

    const encoded = dispatch({ channel: "codex:event", args: [{ type: "threadStarted" }] });
    expect(encoded.kind).toBe("inline");
    bridge.receive(encoded.envelopes[0]);

    expect(received).toEqual([[{ type: "threadStarted" }]]);
    expect(acknowledgments).toEqual([]);
  });

  test("ACKs every chunk in order and dispatches before the final ACK", () => {
    const timeline: string[] = [];
    const acknowledgments: RendererDeliveryTransferAckEnvelope[] = [];
    const bridge = createRendererDeliveryPreloadBridge({
      acknowledge: (acknowledgment) => {
        acknowledgments.push(acknowledgment);
        timeline.push(`ack:${acknowledgment.sequence}`);
      },
      reportError: (message) => {
        throw new Error(message);
      },
    });
    bridge.subscribe("codex:host-message", () => timeline.push("delivered"));
    const encoded = dispatch({
      channel: "codex:host-message",
      args: [{ type: "snapshot", value: "x".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES + 1) }],
    });
    expect(encoded.kind).toBe("transfer");

    for (const envelope of encoded.envelopes) bridge.receive(envelope);

    expect(acknowledgments.map((acknowledgment) => acknowledgment.sequence)).toEqual(
      encoded.envelopes.map((envelope) => (envelope.kind === "inline" ? -1 : envelope.sequence)),
    );
    expect(timeline.at(-2)).toBe("delivered");
    expect(timeline.at(-1)).toBe(`ack:${acknowledgments.at(-1)?.sequence}`);
  });

  test("fences stale generations and another target in the active generation", () => {
    const received: string[] = [];
    const bridge = createRendererDeliveryPreloadBridge({
      acknowledge: () => undefined,
      reportError: (message) => {
        throw new Error(message);
      },
    });
    bridge.subscribe("codex:event", (value) => received.push(value as string));
    const deliver = (value: string, generation: number, targetId = "renderer:one") => {
      const encoded = dispatch({ channel: "codex:event", args: [value] }, generation, targetId);
      bridge.receive(encoded.envelopes[0]);
    };

    deliver("generation-two", 2);
    deliver("stale-generation", 1);
    deliver("wrong-target", 2, "renderer:other");
    deliver("generation-three", 3, "renderer:three");

    expect(received).toEqual(["generation-two", "generation-three"]);
  });

  test("unsubscribes routed listeners without affecting valid ACKs", () => {
    const received: unknown[] = [];
    const errors: string[] = [];
    const bridge = createRendererDeliveryPreloadBridge({
      acknowledge: () => undefined,
      reportError: (message) => errors.push(message),
    });
    const unsubscribe = bridge.subscribe("codex:event", (value) => received.push(value));
    unsubscribe();
    const encoded = dispatch({ channel: "codex:event", args: [1] });
    bridge.receive(encoded.envelopes[0]);

    expect(received).toEqual([]);
    expect(errors).toEqual([]);
  });
});
