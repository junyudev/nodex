import { describe, expect, test, vi } from "vite-plus/test";
import type { CodexHostMessagePart } from "../../shared/codex-host-chunked-message";
import { CodexHostChunkedMessageSender } from "./CodexHostChunkedMessageSender";

type Target = { readonly id: number };
type Message = { readonly name: string; readonly payload: unknown };
type Delivery = { readonly message: Message; readonly part: CodexHostMessagePart | null };

const makeSender = (input: {
  readonly delivered: Delivery[];
  readonly onSendError?: (error: unknown) => void;
  readonly deliver?: (message: Message, part: CodexHostMessagePart | null) => void;
  readonly subscribe?: (callbacks: {
    readonly onDestroyed: () => void;
    readonly onLoaded: () => void;
    readonly onLoading: () => void;
  }) => () => void;
  readonly retryDelayMs?: number;
}) =>
  new CodexHostChunkedMessageSender<Target, Message>({
    batchTargetBytes: 128,
    inlineThresholdBytes: 128,
    deliver: (_target, message, part) => {
      input.deliver?.(message, part);
      input.delivered.push({ message, part });
    },
    getPayload: (message) => message.payload,
    onSendError: (_target, error) => input.onSendError?.(error),
    retryDelayMs: input.retryDelayMs,
    scheduleRetry: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    subscribe: input.subscribe ? (_target, callbacks) => input.subscribe!(callbacks) : undefined,
  });

const acknowledgeToEnd = (
  sender: CodexHostChunkedMessageSender<Target, Message>,
  target: Target,
  delivered: Delivery[],
): void => {
  for (;;) {
    const current = delivered.at(-1)?.part;
    if (!current) throw new Error("Expected an active chunked-message part");
    sender.acknowledge(target, current.transferId, current.sequence);
    if (current.kind === "end") return;
  }
};

describe("CodexHostChunkedMessageSender", () => {
  test("gates a target FIFO on exact ACKs while critical inline messages bypass a normal transfer", () => {
    const delivered: Delivery[] = [];
    const sender = makeSender({ delivered });
    const target = { id: 1 };
    const large = { name: "large", payload: { text: "x".repeat(256) } };
    const queued = { name: "queued", payload: { type: "queued" } };
    const critical = { name: "critical", payload: { type: "approval" } };

    sender.send(target, large);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.part?.kind).toBe("start");
    sender.send(target, queued);
    sender.sendCritical(target, critical);
    expect(delivered.map((entry) => entry.message.name)).toEqual(["large", "critical"]);
    expect(delivered[1]?.part).toBeNull();

    const start = delivered[0]!.part!;
    sender.acknowledge(target, start.transferId, start.sequence + 1);
    sender.acknowledge(target, "wrong-transfer", start.sequence);
    expect(delivered).toHaveLength(2);

    sender.acknowledge(target, start.transferId, start.sequence);
    acknowledgeToEnd(sender, target, delivered);
    expect(delivered.at(-1)).toEqual({ message: queued, part: null });
  });

  test("restarts an active transfer after a target loading cycle", () => {
    const delivered: Delivery[] = [];
    let callbacks:
      | {
          readonly onDestroyed: () => void;
          readonly onLoaded: () => void;
          readonly onLoading: () => void;
        }
      | undefined;
    const sender = makeSender({
      delivered,
      subscribe: (value) => {
        callbacks = value;
        return () => undefined;
      },
    });
    const target = { id: 2 };
    const large = { name: "large", payload: { text: "y".repeat(256) } };

    sender.send(target, large);
    const first = delivered[0]?.part;
    expect(first?.kind).toBe("start");
    callbacks?.onLoading();
    if (!first) throw new Error("Missing first transfer part");
    sender.acknowledge(target, first.transferId, first.sequence);
    expect(delivered).toHaveLength(1);

    callbacks?.onLoaded();
    const restarted = delivered[1]?.part;
    expect(restarted?.kind).toBe("start");
    expect(restarted?.transferId).not.toBe(first.transferId);
  });

  test("retries the same undelivered part after the configured send-error delay", () => {
    vi.useFakeTimers();
    try {
      const delivered: Delivery[] = [];
      const errors: unknown[] = [];
      let attempts = 0;
      const sender = makeSender({
        delivered,
        retryDelayMs: 1_000,
        onSendError: (error) => errors.push(error),
        deliver: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient send failure");
        },
      });
      const target = { id: 3 };

      sender.send(target, { name: "large", payload: { text: "z".repeat(256) } });
      expect(attempts).toBe(1);
      expect(delivered).toHaveLength(0);
      expect(errors).toHaveLength(1);

      vi.advanceTimersByTime(999);
      expect(attempts).toBe(1);
      vi.advanceTimersByTime(1);
      expect(attempts).toBe(2);
      expect(delivered[0]?.part?.kind).toBe("start");
    } finally {
      vi.useRealTimers();
    }
  });

  test("drops target state on destruction", () => {
    const delivered: Delivery[] = [];
    let onDestroyed: (() => void) | undefined;
    const sender = makeSender({
      delivered,
      subscribe: (callbacks) => {
        onDestroyed = callbacks.onDestroyed;
        return () => undefined;
      },
    });
    const target = { id: 4 };

    sender.send(target, { name: "large", payload: { text: "q".repeat(256) } });
    sender.send(target, { name: "queued", payload: { type: "queued" } });
    expect(delivered).toHaveLength(1);
    onDestroyed?.();
    const first = delivered[0]?.part;
    if (!first) throw new Error("Missing first transfer part");
    sender.acknowledge(target, first.transferId, first.sequence);
    expect(delivered).toHaveLength(1);
  });
});
