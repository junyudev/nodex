import { expect, test, vi } from "vite-plus/test";
import { createExactRemoteSubscriptionLifecycle } from "./exact-remote-subscription-lifecycle";

test("terminal invalidation prevents a delayed open from becoming evidence for a new lease", async () => {
  let complete: (value: boolean) => void = () => undefined;
  const open = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
  );
  const lifecycle = createExactRemoteSubscriptionLifecycle({
    hasSubscribers: () => true,
    open,
    isOpenResult: (value) => value,
    alreadyOpenResult: () => true,
    inactiveResult: () => false,
    close: async () => undefined,
    finalize: () => undefined,
  });
  const stale = lifecycle.ensure();
  lifecycle.invalidate();
  complete(true);
  expect(await stale).toBe(false);
  const replacement = lifecycle.ensure();
  expect(open).toHaveBeenCalledTimes(2);
  complete(true);
  expect(await replacement).toBe(true);
  expect(await lifecycle.ensure()).toBe(true);
  expect(open).toHaveBeenCalledTimes(2);
});

test.each(["opening", "open"])(
  "release fences queued commands while %s, including immediate revival",
  async (phase) => {
    let subscribed = true;
    let complete: (value: boolean) => void = () => undefined;
    const open = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const close = vi.fn(async () => undefined);
    const lifecycle = createExactRemoteSubscriptionLifecycle({
      hasSubscribers: () => subscribed,
      open,
      isOpenResult: (value) => value,
      alreadyOpenResult: () => true,
      inactiveResult: () => false,
      close,
      finalize: () => undefined,
    });
    const opening = lifecycle.ensure();
    if (phase === "open") {
      complete(true);
      await opening;
    }
    const send = vi.fn(async () => "sent");
    const run = () => lifecycle.run(async (ready) => (ready ? send() : "inactive"));
    const stale = run();
    subscribed = false;
    lifecycle.releaseIfIdle();
    subscribed = true;
    const secondStale = run();
    subscribed = false;
    lifecycle.releaseIfIdle();
    subscribed = true;
    if (phase === "opening") complete(true);
    expect(await stale).toBe("inactive");
    expect(await secondStale).toBe("inactive");
    expect(send).not.toHaveBeenCalled();
    expect(await run()).toBe("sent");
    expect(close).not.toHaveBeenCalled();
    subscribed = false;
    lifecycle.releaseIfIdle();
    expect(await run()).toBe("inactive");
  },
);
