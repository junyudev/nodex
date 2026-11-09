import {
  decodePushKey,
  encodeDeviceLink,
  PUSH_KEY_BYTES,
  spaceMemberKey,
} from "@nodex/mobile-protocol";
import * as Scheduler from "effect/Scheduler";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeHost, fakePlatform } from "./fake-host.test-support";
import type { DeliveredNotification, MobilePush, PushPermission } from "./platform";
import { createMobileRuntime, type MobileRuntime } from "./runtime";

const route = "https://host-a:3000/";
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
let runtimes: MobileRuntime[] = [];

class FakePush implements MobilePush {
  bundleId = "app.test";
  token = "aa".repeat(32);
  key: string | null = null;
  relayFails = false;
  readonly addressesRegistered: string[] = [];
  readonly dismissed: string[] = [];
  shown: DeliveredNotification[] = [];
  constructor(
    private current: PushPermission,
    private readonly answer: PushPermission = "granted",
  ) {}
  permission = () => Promise.resolve(this.current);
  requestPermission = () => {
    this.current = this.answer;
    return Promise.resolve(this.answer);
  };
  address: MobilePush["address"] = () =>
    Promise.resolve({ token: this.token, environment: "sandbox" as const });
  readKey = () => this.key;
  writeKey = (key: string) => {
    this.key = key;
    return Promise.resolve();
  };
  registerAddress = ({ token }: { readonly token: string }) => {
    if (this.relayFails) return Promise.reject(new Error("relay down"));
    this.addressesRegistered.push(token);
    return Promise.resolve(`handle-for-${token.slice(0, 4)}`);
  };
  delivered = () => Promise.resolve([...this.shown]);
  dismiss = (ids: readonly string[]) => {
    this.dismissed.push(...ids);
    this.shown = this.shown.filter(({ id }) => !ids.includes(id));
    return Promise.resolve();
  };
}

const setup = async (push: FakePush | null, configure?: (host: FakeHost) => void) => {
  const platform = fakePlatform();
  platform.push = push;
  const host = new FakeHost();
  configure?.(host);
  platform.routes.set(route, host);
  const runtime = createMobileRuntime(platform, {
    scheduler: new Scheduler.MixedScheduler("sync"),
  });
  runtimes.push(runtime);
  const paired = runtime.connection.pairWithUri(
    encodeDeviceLink(host.pairingOffer(platform.now() + 60_000)),
  );
  await tick(100);
  await paired;
  await tick(100);
  return { platform, host, runtime };
};

const registrations = (host: FakeHost) => host.requests.filter(({ m }) => m === "push.register");
const removals = (host: FakeHost) => host.requests.filter(({ m }) => m === "push.unregister");
const shown = (
  id: string,
  hostId: string | null,
  about: { readonly sessionId?: string; readonly pageId?: string },
): DeliveredNotification => ({
  id,
  hostId,
  sessionId: about.sessionId ?? null,
  pageId: about.pageId ?? null,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  runtimes = [];
});

afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose();
  vi.useRealTimers();
});

describe("notifications", () => {
  it("are unavailable on a phone that can't receive them", async () => {
    const { runtime, host } = await setup(null);
    expect(runtime.notifications.state.getState().available).toBe(false);
    await runtime.notifications.enable();
    expect(registrations(host)).toEqual([]);
  });

  it("tell the desktop nothing until the person turns them on", async () => {
    const { runtime, host } = await setup(new FakePush("undetermined"));
    expect(runtime.notifications.state.getState()).toMatchObject({
      available: true,
      permission: "undetermined",
      preferences: { needsYou: false, finished: false },
    });
    expect(registrations(host)).toEqual([]);
  });

  it("register a handle and a fresh key when turned on", async () => {
    const push = new FakePush("undetermined");
    const { runtime, host } = await setup(push);
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    const [request] = registrations(host);
    expect(request?.p).toMatchObject({
      handle: "handle-for-aaaa",
      preferences: { needsYou: true, finished: true },
    });
    expect(push.key).toBeTruthy();
    expect((request?.p as { key: string }).key).toBe(push.key);
    expect(decodePushKey(push.key ?? "")).toHaveLength(PUSH_KEY_BYTES);
    expect(runtime.notifications.state.getState().offerDismissed).toBe(true);
  });

  it("stay off and remember the answer when the system refuses", async () => {
    const { runtime, host } = await setup(new FakePush("undetermined", "denied"));
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    expect(registrations(host)).toEqual([]);
    expect(runtime.notifications.state.getState()).toMatchObject({
      permission: "denied",
      offerDismissed: true,
      preferences: { needsYou: false, finished: false },
    });
  });

  it("reuse the handle and key, and ask the relay again only for a new address", async () => {
    const push = new FakePush("granted");
    const { runtime, host } = await setup(push);
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    const key = push.key;
    const change = runtime.notifications.setPreferences({ finished: false });
    await tick(100);
    await change;
    expect(push.addressesRegistered).toHaveLength(1);
    expect(registrations(host).at(-1)?.p).toMatchObject({
      key,
      preferences: { needsYou: true, finished: false },
    });

    push.token = "bb".repeat(32);
    const moved = runtime.notifications.setPreferences({ finished: true });
    await tick(100);
    await moved;
    expect(push.addressesRegistered).toHaveLength(2);
    expect(registrations(host).at(-1)?.p).toMatchObject({ key, handle: "handle-for-bbbb" });
  });

  it("unregister once the person wants neither", async () => {
    const { runtime, host } = await setup(new FakePush("granted"));
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    const off = runtime.notifications.setPreferences({ needsYou: false, finished: false });
    await tick(100);
    await off;
    expect(removals(host)).toHaveLength(1);
  });

  it("wait for the next connection when the relay is unreachable", async () => {
    const push = new FakePush("granted");
    push.relayFails = true;
    const { runtime, host } = await setup(push);
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    expect(registrations(host)).toEqual([]);
    expect(runtime.notifications.state.getState().preferences.needsYou).toBe(true);
  });

  it("say so when the relay is unreachable, and clear it on a retry that works", async () => {
    const push = new FakePush("granted");
    push.relayFails = true;
    const { runtime, host } = await setup(push);
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    expect(runtime.notifications.state.getState().problem).toBe("relay");

    push.relayFails = false;
    const again = runtime.notifications.retry();
    await tick(100);
    await again;
    expect(runtime.notifications.state.getState().problem).toBeNull();
    expect(registrations(host)).toHaveLength(1);
  });

  it("say so when the system gives no address rather than staying quiet", async () => {
    const push = new FakePush("granted");
    push.address = () => Promise.resolve(null);
    const { runtime, host } = await setup(push);
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    expect(runtime.notifications.state.getState().problem).toBe("no-address");
    expect(registrations(host)).toEqual([]);
  });

  it("say so when the Space refuses the registration", async () => {
    const { runtime, host } = await setup(new FakePush("granted"));
    const reply = host.onRequest;
    host.onRequest = (request, respond, fail) => {
      if (request.m === "push.register") fail("Unknown method", false);
      else reply(request, respond, fail);
    };
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    expect(runtime.notifications.state.getState().problem).toBe("space");
  });

  it("register with each Space it connects to and withdraw from each once turned off", async () => {
    const push = new FakePush("granted");
    const { platform, host, runtime } = await setup(push);
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    expect(registrations(host)).toHaveLength(1);

    const second = new FakeHost("host-b", ["https://host-b:3000/"]);
    platform.routes.set("https://host-b:3000/", second);
    const linked = runtime.connection.pairWithUri(
      encodeDeviceLink(second.pairingOffer(platform.now() + 60_000)),
    );
    await tick(100);
    await linked;
    await tick(100);
    expect(registrations(second)).toHaveLength(1);
    expect(registrations(second)[0]?.p).toMatchObject({ key: push.key });

    const off = runtime.notifications.setPreferences({ needsYou: false, finished: false });
    await tick(100);
    await off;
    expect(removals(second)).toHaveLength(1);
    expect(removals(host)).toEqual([]);

    // The first Space still holds the registration, so it hears on the next connection.
    const first = runtime.connection.hosts
      .getState()
      .hosts.find(({ spaceId }) => spaceId === host.id)!;
    runtime.connection.activateHost(first.hostId);
    await tick(100);
    expect(removals(host)).toHaveLength(1);
    runtime.connection.activateHost(
      runtime.connection.hosts.getState().hosts.find(({ spaceId }) => spaceId === second.id)!
        .hostId,
    );
    await tick(100);
    expect(removals(second)).toHaveLength(1);
  });

  it("withdraw from a Space being removed while connected to it", async () => {
    const { host, runtime } = await setup(new FakePush("granted"));
    const on = runtime.notifications.enable();
    await tick(100);
    await on;
    const [saved] = runtime.connection.hosts.getState().hosts;
    const removed = runtime.forgetHost(saved!.hostId);
    await tick(100);
    await removed;
    expect(removals(host)).toHaveLength(1);
  });

  it("clear what this Space no longer stands behind, once connected", async () => {
    const push = new FakePush("granted");
    const here = spaceMemberKey("host-a", "owner");
    push.shown = [
      shown("read", here, { sessionId: "read" }),
      shown("unread", here, { sessionId: "unread" }),
      shown("read-again", here, { sessionId: "read" }),
      shown("turn-moved", here, { pageId: "moved" }),
      // A Turn waiting on a read chat is still the Member's move.
      shown("turn-current", here, { pageId: "current", sessionId: "read" }),
      shown("elsewhere", spaceMemberKey("host-b", "owner"), { sessionId: "elsewhere" }),
      shown("another-member", spaceMemberKey("host-a", "guest"), { pageId: "moved" }),
      shown("unattributed", null, { sessionId: "unattributed" }),
    ];
    const { host } = await setup(push, (host) => {
      const reply = host.onRequest;
      host.onRequest = (request, respond, fail) => {
        if (request.m === "chats.unread") respond({ sessionIds: ["unread"] });
        else if (request.m === "inbox.turns") respond({ pageIds: ["current"] });
        else reply(request, respond, fail);
      };
    });
    await tick(300);
    // Only what this Space sent this Member is its to judge.
    expect(host.requests.filter(({ m }) => m === "chats.unread").map(({ p }) => p)).toEqual([
      { sessionIds: ["read", "unread"] },
    ]);
    expect(host.requests.filter(({ m }) => m === "inbox.turns").map(({ p }) => p)).toEqual([
      { pageIds: ["moved", "current"] },
    ]);
    expect(push.dismissed).toEqual(["read", "read-again", "turn-moved"]);
  });

  it("tidy again when the Space's chats or Inbox change, and leave them to a Space that can't tell", async () => {
    const push = new FakePush("granted");
    const { host } = await setup(push);
    await tick(300);
    const here = spaceMemberKey("host-a", "owner");
    push.shown = [
      shown("chat", here, { sessionId: "read-later" }),
      shown("turn", here, { pageId: "moved-later" }),
    ];
    const reply = host.onRequest;
    host.onRequest = (request, respond, fail) => {
      if (request.m === "chats.unread" || request.m === "inbox.turns")
        fail("Unknown method", false, "unknown_method");
      else reply(request, respond, fail);
    };
    host.emit({ t: "evt", k: "changed", d: { topics: ["chats"] } });
    await tick(300);
    expect(push.dismissed).toEqual([]);
    host.onRequest = (request, respond, fail) => {
      if (request.m === "chats.unread") respond({ sessionIds: [] });
      else if (request.m === "inbox.turns") fail("Unavailable", true, "unavailable");
      else reply(request, respond, fail);
    };
    host.emit({ t: "evt", k: "changed", d: { topics: ["agents"] } });
    await tick(300);
    expect(push.dismissed).toEqual([]);
    host.emit({ t: "evt", k: "changed", d: { topics: ["chats"] } });
    await tick(300);
    // The Space answered for its chats, not its Turns.
    expect(push.dismissed).toEqual(["chat"]);
    host.onRequest = (request, respond, fail) => {
      if (request.m === "inbox.turns") respond({ pageIds: [] });
      else reply(request, respond, fail);
    };
    host.emit({ t: "evt", k: "changed", d: { topics: ["inbox"] } });
    await tick(300);
    expect(push.dismissed).toEqual(["chat", "turn"]);
  });

  it("clear one chat's delivered notifications, including a Turn waiting on it", async () => {
    const push = new FakePush("granted");
    const { runtime } = await setup(push);
    push.shown = [
      shown("chat", "any", { sessionId: "session-1" }),
      shown("turn", "any", { pageId: "page-1", sessionId: "session-1" }),
      shown("other", "any", { sessionId: "session-2" }),
    ];
    runtime.notifications.clearDelivered({ sessionId: "session-1" });
    await tick(10);
    expect(push.dismissed).toEqual(["chat", "turn"]);
  });

  it("clear what was delivered about a Page's Turn when its Inbox message opens", async () => {
    const push = new FakePush("granted");
    const { runtime } = await setup(push);
    push.shown = [
      shown("turn", "any", { pageId: "page-1" }),
      shown("chat", "any", { sessionId: "session-1" }),
      shown("other", "any", { pageId: "page-2" }),
    ];
    runtime.notifications.clearDelivered({ pageId: "page-1", sessionId: "session-1" });
    await tick(10);
    expect(push.dismissed).toEqual(["turn", "chat"]);
  });
});
