import { assert, it } from "@effect/vitest";
import { sanitizeCodexEndpointNotification } from "./CodexEndpoint";

it("keeps the observational endpoint projection free of embedded transcript payloads", () => {
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

it("preserves large completed tool output through endpoint ingress", () => {
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
        aggregatedOutput: "x".repeat(2 * 1024 * 1024 + 1),
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
  assert.strictEqual(sanitized.params.item.type, "commandExecution");
  assert.strictEqual(
    sanitized.params.item.aggregatedOutput,
    generated.params.item.aggregatedOutput,
  );
  assert.strictEqual(sanitized.params.item.status, "failed");
  assert.strictEqual(sanitizeCodexEndpointNotification(raw), raw);
  assert.deepStrictEqual(
    sanitizeCodexEndpointNotification(extensionStart).params.thread.turns as readonly unknown[],
    [],
  );
});
