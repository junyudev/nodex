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
