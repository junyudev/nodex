import { assert, it } from "@effect/vitest";
import { CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES } from "../../shared/codex-conversation-state/codex-live-turn-residency";
import { sanitizeCodexEndpointNotification } from "./CodexEndpoint";

it("strips transcript payloads at the endpoint before inbox and event-hub fan-out", () => {
  const input = {
    protocol: "generated",
    method: "thread/started",
    params: {
      thread: {
        id: "thread-large",
        turns: [{ id: "turn-large", items: new Array<unknown>(100_000_000) }],
      },
    },
  } as const;

  const sanitized = sanitizeCodexEndpointNotification(input);

  assert.notStrictEqual(sanitized, input);
  assert.deepStrictEqual((sanitized.params.thread as unknown as { turns: unknown[] }).turns, []);
});

it("bounds giant lifecycle items at the endpoint while leaving raw notifications untouched", () => {
  const generated = {
    protocol: "generated",
    method: "item/completed",
    params: {
      threadId: "thread-large",
      turnId: "turn-large",
      completedAtMs: 1,
      item: {
        type: "commandExecution",
        id: "command-large",
        status: "failed",
        aggregatedOutput: "x".repeat(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES + 1),
      },
    },
  } as const;
  const raw = { protocol: "raw", method: "custom/event", params: { value: "unchanged" } } as const;
  const extensionStart = {
    protocol: "extension",
    method: "thread/started",
    params: { thread: { id: "thread-extension", turns: ["must-not-fan-out"] } },
  } as const;

  const sanitized = sanitizeCodexEndpointNotification(generated);

  assert.strictEqual(sanitized.params.item.id, "command-large");
  assert.strictEqual(sanitized.params.item.type, "agentMessage");
  assert.strictEqual(sanitized.params.item.status, "failed");
  assert.strictEqual(sanitizeCodexEndpointNotification(raw), raw);
  assert.deepStrictEqual(
    sanitizeCodexEndpointNotification(extensionStart).params.thread.turns as readonly unknown[],
    [],
  );
});
