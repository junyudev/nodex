import { expect, it } from "vitest";
import { QueuedMessageLocks } from "./codex-queued-message-locks";
it("recovers expired sends without allowing a stale release to unlock the replacement", () => {
  let now = 0;
  const locks = new QueuedMessageLocks(() => now);
  const first = { conversationId: "thread", messageId: "message", lockId: "first" };
  const second = { ...first, lockId: "second" };
  expect(locks.tryAcquire(first)).toBe(true);
  expect(locks.tryAcquire(second)).toBe(false);
  now = 120_000;
  expect(locks.tryAcquire(second)).toBe(true);
  locks.release({ ...first, sent: false });
  expect(locks.tryAcquire({ ...first, messageId: "another" })).toBe(false);
  locks.release({ ...second, sent: true });
  expect(locks.tryAcquire(first)).toBe(false);
  expect(locks.tryAcquire({ ...first, messageId: "another" })).toBe(true);
  now += 600_000;
  expect(locks.tryAcquire(first)).toBe(true);
});
