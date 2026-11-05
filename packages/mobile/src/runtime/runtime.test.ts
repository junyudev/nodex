import {
  CHANNEL_CLOSE,
  encodePairingUri,
  LIBRARY_INBOX,
  MOBILE_FILE_CHUNK_BYTES,
  MOBILE_PROTOCOL_REVISION,
  MobileEnvelopeSchema,
  type ChatItem,
  type ChatPatchOp,
  type ChatSnapshot,
  type InboxMessage,
  type MobileMethod,
  type MobileParams,
} from "@nodex/mobile-protocol";
import * as Scheduler from "effect/Scheduler";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeHost, fakePlatform } from "./fake-host.test-support";
import type { LocalImage } from "./platform";
import { createMobileRuntime, type MobileRuntime } from "./runtime";

type Platform = ReturnType<typeof fakePlatform>;
const route = "ws://host-a:3000/mobile";
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
let runtimes: MobileRuntime[] = [];

beforeAll(() => {
  expect(MobileEnvelopeSchema.parse({ t: "ping" })).toEqual({ t: "ping" });
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

function start(platform: Platform) {
  const runtime = createMobileRuntime(platform, {
    scheduler: new Scheduler.MixedScheduler("sync"),
  });
  runtimes.push(runtime);
  return runtime;
}

function pairingUri(platform: Platform, host: FakeHost, routes?: string[]) {
  return encodePairingUri(host.pairingOffer(platform.now() + 60_000, routes));
}

async function setup() {
  const platform = fakePlatform();
  const host = new FakeHost();
  platform.routes.set(route, host);
  const runtime = start(platform);
  const pair = runtime.connection.pairWithUri(pairingUri(platform, host));
  await tick();
  const saved = await pair;
  return { platform, host, runtime, saved };
}

function params<M extends MobileMethod>(host: FakeHost, method: M) {
  return host.requests
    .filter((request) => request.m === method)
    .map((request) => request.p as MobileParams<M>);
}

describe("pairing and connection", () => {
  it("saves the phone key before pairing and publishes the Host after hello", async () => {
    const platform = fakePlatform();
    const host = new FakeHost();
    host.allowHello = false;
    platform.routes.set(route, host);
    const runtime = start(platform);
    const secretCountsAtSend: number[] = [];
    const socket = platform.socket;
    platform.socket = (address) => {
      const link = socket(address);
      return {
        ...link,
        send(bytes) {
          secretCountsAtSend.push(platform.savedSecrets.size);
          link.send(bytes);
        },
      };
    };
    const pending = runtime.connection.pairWithUri(pairingUri(platform, host));
    await tick();
    expect(host.trace).toEqual(["handshake.reply", "ping"]);
    expect(host.firstEnvelopes).toEqual([{ t: "ping" }]);
    expect(host.metadata).toEqual([
      {
        protocol: MOBILE_PROTOCOL_REVISION,
        deviceName: "Test phone",
        platform: "ios",
        appVersion: "1.0.0",
      },
    ]);
    expect(secretCountsAtSend).toEqual([0, 1]);
    expect(platform.savedSecrets.size).toBe(1);
    expect(runtime.connection.hosts.getState().hosts).toEqual([]);
    expect(runtime.connection.state.getState().status).toBe("idle");
    host.emit({
      t: "hello",
      d: {
        protocol: MOBILE_PROTOCOL_REVISION,
        host: { id: host.id, name: host.id, platform: "macOS", appVersion: "1" },
        deviceId: "device-1",
        routes: [],
      },
    });
    host.emit({ t: "pong" });
    await tick();
    await expect(pending).resolves.toMatchObject({
      hostId: host.id,
      routes: [route],
      lastConnectedRoute: route,
    });
    expect(platform.savedSecrets.size).toBe(1);
    expect(platform.data.size).toBe(0);
    expect(runtime.connection.state.getState().status).toBe("connected");
    host.allowHello = true;
    runtime.connection.reconnectNow();
    await tick();
    expect(host.firstEnvelopes).toEqual([{ t: "ping" }, { t: "ping" }]);
    expect(host.metadata[1]).toEqual(host.metadata[0]);
    expect(host.trace.slice(-4)).toEqual(["handshake.reply", "ping", "hello", "pong"]);
    expect(runtime.connection.state.getState().status).toBe("connected");
  });

  it("distinguishes invalid, expired, rejected, unreachable and incompatible offers", async () => {
    const platform = fakePlatform();
    const host = new FakeHost();
    const runtime = start(platform);
    const pair = runtime.connection.pairWithUri;
    await expect(pair("nodex-mobile://pair#bad")).rejects.toMatchObject({ code: "invalid" });
    await expect(pair(encodePairingUri(host.pairingOffer(platform.now())))).rejects.toMatchObject({
      code: "expired",
    });
    expect(platform.dials).toHaveLength(0);
    platform.routes.set(route, host);
    host.pairingAvailable = false;
    await expect(pair(pairingUri(platform, host))).rejects.toMatchObject({ code: "rejected" });
    platform.routes.set(route, "stall");
    const unreachable = expect(pair(pairingUri(platform, host))).rejects.toMatchObject({
      code: "unreachable",
    });
    await tick(7_999);
    expect(platform.dials.at(-1)?.closed).toBe(false);
    await tick(1);
    await unreachable;
    host.pairingAvailable = true;
    host.protocol++;
    platform.routes.set(route, host);
    await expect(pair(pairingUri(platform, host))).rejects.toMatchObject({ code: "incompatible" });
    expect([...platform.savedSecrets.values()].join("")).not.toContain("secretKey");
  });

  it("recovers a consumed pairing on the same device key when the first hello is lost", async () => {
    const platform = fakePlatform();
    const host = new FakeHost();
    host.onPaired = () => host.closeAll();
    platform.routes.set(route, host);
    const runtime = start(platform);
    const pair = runtime.connection.pairWithUri(pairingUri(platform, host));
    await tick();
    await expect(pair).resolves.toMatchObject({ deviceId: "device-1", hostId: host.id });
    expect(host.pairingAvailable).toBe(false);
    expect(host.pairingKeys).toHaveLength(1);
    expect(host.firstEnvelopes).toEqual([{ t: "ping" }, { t: "ping" }]);
    expect(runtime.connection.state.getState().status).toBe("connected");
  });

  it("shares one phone identity across racing pairing routes", async () => {
    const platform = fakePlatform();
    const alternate = "ws://host-a:4000/mobile";
    const host = new FakeHost("host-a", [route, alternate]);
    host.handshakeReplyDelay = 500;
    platform.routes.set(route, host);
    platform.routes.set(alternate, host);
    const runtime = start(platform);
    const pair = runtime.connection.pairWithUri(pairingUri(platform, host));
    await tick(500);
    await expect(pair).resolves.toMatchObject({ deviceId: "device-1" });
    expect(host.pairingKeys).toHaveLength(2);
    expect(new Set(host.pairingKeys).size).toBe(1);
  });

  it.each([false, true])(
    "recovers a pending identity before reusing the code (expired: %s)",
    async (expired) => {
      const platform = fakePlatform();
      const host = new FakeHost();
      host.onPaired = () => {
        platform.routes.set(route, "unreachable");
        host.closeAll();
      };
      platform.routes.set(route, host);
      const runtime = start(platform);
      const uri = pairingUri(platform, host);
      await expect(runtime.connection.pairWithUri(uri)).rejects.toMatchObject({
        code: "unreachable",
      });
      expect(platform.dials).toHaveLength(2);
      expect(runtime.connection.hosts.getState().hosts).toEqual([]);
      expect([...platform.savedSecrets.values()].join("")).toContain("secretKey");
      if (expired) await tick(60_000);
      host.onPaired = undefined;
      platform.routes.set(route, host);
      await expect(runtime.connection.pairWithUri(uri)).resolves.toMatchObject({
        deviceId: "device-1",
      });
      expect(host.pairingKeys).toHaveLength(1);
    },
  );

  it.each([true, false])(
    "retries a pending pairing across launches and foreground returns (reachable: %s)",
    async (reachable) => {
      const platform = fakePlatform();
      const host = new FakeHost();
      host.allowHello = false;
      platform.routes.set(route, host);
      const runtime = start(platform);
      const interrupted = expect(
        runtime.connection.pairWithUri(pairingUri(platform, host)),
      ).rejects.toMatchObject({ code: "unreachable" });
      await tick();
      expect(host.pairingAvailable).toBe(false);
      expect(runtime.connection.hosts.getState().hosts).toEqual([]);
      await runtime.dispose();
      await interrupted;
      host.allowHello = true;
      if (!reachable) platform.routes.set(route, "unreachable");

      const restarted = start(platform);
      expect(restarted.connection.hosts.getState().hosts).toEqual([]);
      await tick();
      expect(platform.dials).toHaveLength(2);
      if (reachable) {
        expect(restarted.connection.hosts.getState().hosts).toMatchObject([
          { deviceId: "device-1" },
        ]);
        expect(restarted.connection.state.getState().status).toBe("connected");
        return;
      }
      expect(restarted.connection.hosts.getState().hosts).toEqual([]);
      expect([...platform.savedSecrets.values()].join("")).toContain("secretKey");
      await restarted.dispose();
      const retried = start(platform);
      await tick();
      expect(platform.dials).toHaveLength(3);
      platform.setForeground(false);
      await tick();
      platform.routes.set(route, host);
      platform.setForeground(true);
      await tick();
      expect(retried.connection.state.getState().status).toBe("connected");
      expect(host.pairingKeys).toHaveLength(1);
    },
  );

  it("replaces an unfinished identity when pairing with another desktop", async () => {
    const platform = fakePlatform();
    const first = new FakeHost();
    first.onPaired = () => {
      platform.routes.set(route, "unreachable");
      first.closeAll();
    };
    platform.routes.set(route, first);
    const runtime = start(platform);
    await expect(runtime.connection.pairWithUri(pairingUri(platform, first))).rejects.toMatchObject(
      { code: "unreachable" },
    );
    const secondRoute = "ws://host-b:3000/mobile";
    const second = new FakeHost("host-b", [secondRoute]);
    platform.routes.set(secondRoute, second);
    await expect(
      runtime.connection.pairWithUri(pairingUri(platform, second)),
    ).resolves.toMatchObject({ hostId: second.id });
    expect(first.pairingKeys).toHaveLength(1);
    expect(second.pairingKeys).toHaveLength(1);
    expect(second.pairingKeys[0]).not.toBe(first.pairingKeys[0]);
    expect(JSON.parse([...platform.savedSecrets.values()][0]!).pendingPairing).toBeUndefined();
    expect(runtime.connection.hosts.getState().hosts.map((host) => host.hostId)).toEqual([
      second.id,
    ]);
  });

  it.each([CHANNEL_CLOSE.unknownDevice, CHANNEL_CLOSE.pairingRejected])(
    "clears a pending identity when recovery is refused (%s)",
    async (code) => {
      const platform = fakePlatform();
      const host = new FakeHost();
      host.allowHello = false;
      platform.routes.set(route, host);
      const runtime = start(platform);
      const interrupted = expect(
        runtime.connection.pairWithUri(pairingUri(platform, host)),
      ).rejects.toMatchObject({ code: "unreachable" });
      await tick();
      await runtime.dispose();
      await interrupted;
      platform.routes.set(route, code);
      start(platform);
      await tick();
      expect([...platform.savedSecrets.values()].join("")).not.toContain("secretKey");
    },
  );

  it("races routes 250 ms apart, rejects a different Host, and closes the losers", async () => {
    const { platform, host, runtime } = await setup();
    const stale = "ws://stale:3000/mobile";
    const winner = "ws://host-a:4000/mobile";
    host.routes = [stale, winner, route];
    runtime.connection.reconnectNow();
    await tick();
    expect(runtime.connection.hosts.getState().hosts[0]?.routes).toEqual([stale, winner, route]);
    platform.routes.set(route, "stall");
    platform.routes.set(stale, new FakeHost("different"));
    platform.routes.set(winner, host);
    host.routes = ["ws://next:3000/mobile"];
    const since = platform.now();
    const offset = platform.dials.length;
    runtime.connection.reconnectNow();
    await tick(249);
    expect(platform.dials.slice(offset).map((attempt) => attempt.route)).toEqual([route]);
    await tick(1);
    expect(platform.dials.at(-1)?.route).toBe(stale);
    await tick(250);
    expect(
      platform.dials
        .slice(offset)
        .map(({ route: address, at, closed }) => [address, at - since, closed]),
    ).toEqual([
      [route, 0, true],
      [stale, 250, true],
      [winner, 500, false],
    ]);
    expect(runtime.connection.hosts.getState().hosts[0]).toMatchObject({
      routes: ["ws://next:3000/mobile", winner],
      lastConnectedRoute: winner,
    });
  });

  it("backs off on repeated failure and resets on foreground before refreshing", async () => {
    const { platform, host, runtime } = await setup();
    const projects = runtime.lists.projectReads.attach();
    await tick();
    expect(params(host, "projects.list")).toHaveLength(1);
    platform.routes.set(route, "unreachable");
    host.closeAll();
    await tick();
    const dials = platform.dials.length;
    await tick(999);
    expect(platform.dials).toHaveLength(dials);
    await tick(1);
    expect(platform.dials).toHaveLength(dials + 1);
    await tick(1_999);
    expect(platform.dials).toHaveLength(dials + 1);
    await tick(1);
    expect(platform.dials).toHaveLength(dials + 2);
    platform.setForeground(false);
    await tick(30_000);
    expect(platform.dials).toHaveLength(dials + 2);
    platform.setForeground(true);
    await tick();
    expect(platform.dials).toHaveLength(dials + 3);
    platform.routes.set(route, host);
    await tick(1_000);
    expect(runtime.connection.state.getState().status).toBe("connected");
    expect(params(host, "projects.list")).toHaveLength(2);
    projects();
  });

  it.each([
    [CHANNEL_CLOSE.unknownDevice, "revoked"],
    [CHANNEL_CLOSE.revoked, "revoked"],
    [CHANNEL_CLOSE.protocolMismatch, "incompatible"],
  ])("automatically recovers from unauthenticated close hint %i", async (code, status) => {
    const { platform, host, runtime, saved } = await setup();
    const secrets = [...platform.savedSecrets];
    platform.routes.set(route, code);
    host.closeAll();
    await tick(1_000);
    expect(platform.dials).toHaveLength(2);
    expect(runtime.connection.state.getState()).toMatchObject({ status, hello: null });
    expect(runtime.connection.hosts.getState().hosts).toEqual([saved]);
    expect([...platform.savedSecrets]).toEqual(secrets);
    platform.routes.set(route, "unreachable");
    await tick(2_000);
    expect(runtime.connection.state.getState().status).toBe(status);
    platform.routes.set(route, host);
    await tick(3_999);
    expect(platform.dials).toHaveLength(3);
    await tick(1);
    expect(runtime.connection.state.getState().status).toBe("connected");
  });

  it("lets a chosen code take over from a recovery still trying another desktop", async () => {
    const platform = fakePlatform();
    const earlier = new FakeHost();
    earlier.allowHello = false;
    platform.routes.set(route, earlier);
    const first = start(platform);
    const interrupted = expect(
      first.connection.pairWithUri(pairingUri(platform, earlier)),
    ).rejects.toMatchObject({ code: "unreachable" });
    await tick();
    await first.dispose();
    await interrupted;
    platform.routes.set(route, "stall");

    const relaunched = start(platform);
    await tick();
    const chosenRoute = "ws://host-b:3000/mobile";
    const chosen = new FakeHost("host-b", [chosenRoute]);
    platform.routes.set(chosenRoute, chosen);
    const paired = relaunched.connection.pairWithUri(pairingUri(platform, chosen));
    await tick();
    await expect(paired).resolves.toMatchObject({ lastConnectedRoute: chosenRoute });
    expect(relaunched.connection.state.getState().status).toBe("connected");
    expect(relaunched.connection.hosts.getState().hosts).toHaveLength(1);
  });

  it("does not report a forged close while another route is still authenticating", async () => {
    const { platform, host, runtime } = await setup();
    const alternate = "ws://host-a:4000/mobile";
    host.routes = [route, alternate];
    runtime.connection.reconnectNow();
    await tick();
    host.closeAll();
    platform.routes.set(route, CHANNEL_CLOSE.revoked);
    platform.routes.set(alternate, host);
    host.handshakeReplyDelay = 500;
    await tick(1_749);
    expect(runtime.connection.state.getState().status).toBe("offline");
    await tick(1);
    expect(runtime.connection.state.getState().status).toBe("connected");
  });

  it("says offline steadily across retries until the desktop is back", async () => {
    const { platform, host, runtime } = await setup();
    const seen: string[] = [];
    const stop = runtime.connection.state.subscribe(({ status }) => seen.push(status));
    platform.routes.set(route, "unreachable");
    host.closeAll();
    await tick(10_000);
    expect(platform.dials.length).toBeGreaterThan(3);
    platform.routes.set(route, host);
    await tick(35_000);
    stop();
    expect(new Set(seen)).toEqual(new Set(["offline", "connected"]));
    expect(seen.at(-1)).toBe("connected");
  });

  it("retries an authenticated protocol mismatch only at the capped delay", async () => {
    const { platform, host, runtime } = await setup();
    host.closeAll();
    host.protocol++;
    await tick(1_000);
    expect(runtime.connection.state.getState().status).toBe("incompatible");
    expect(platform.dials).toHaveLength(2);
    await tick(29_999);
    expect(platform.dials).toHaveLength(2);
    await tick(1);
    expect(platform.dials).toHaveLength(3);
    expect(runtime.connection.state.getState().status).toBe("incompatible");
    host.protocol = MOBILE_PROTOCOL_REVISION;
    await tick(30_000);
    expect(runtime.connection.state.getState().status).toBe("connected");
  });

  it("drops a silent channel after a 20 second ping and a 10 second pong deadline", async () => {
    const { host, runtime } = await setup();
    host.pong = false;
    await tick(29_999);
    expect(runtime.connection.state.getState().status).toBe("connected");
    await tick(1);
    expect(runtime.connection.state.getState().status).toBe("offline");
  });
});

describe("RPC", () => {
  it("validates params, results and events while tolerating newer event names", async () => {
    const { host, runtime } = await setup();
    const rpc = runtime.connection.rpc;
    await expect(
      rpc.request("files.read", { ref: "file", offset: -1, length: 1 }),
    ).rejects.toMatchObject({ code: "invalid_params", retryable: false });
    await expect(rpc.request("not.real" as MobileMethod, {})).rejects.toMatchObject({
      code: "unknown_method",
      retryable: false,
    });
    expect(host.requests).toEqual([]);
    host.onRequest = (_request, reply) => reply({ unexpected: 1 });
    await expect(rpc.request("projects.list", {})).rejects.toMatchObject({
      code: "invalid_result",
      retryable: false,
    });
    const topics: string[] = [];
    const unsubscribe = rpc.on("changed", (event) => topics.push(...event.topics));
    host.emit({ t: "evt", k: "changed", d: { topics: 7 } });
    host.emit({ t: "evt", k: "future.event", d: { future: true } });
    host.emit({ t: "evt", k: "changed", d: { topics: ["inbox"], future: true } });
    await tick();
    expect(rpc.droppedEvents).toBe(2);
    expect(topics).toEqual(["inbox"]);
    expect(runtime.connection.state.getState().status).toBe("connected");
    unsubscribe();
  });

  it("fails on deadline and rejects pending calls as retryable on disconnect", async () => {
    const { host, runtime } = await setup();
    host.onRequest = () => {};
    const rpc = runtime.connection.rpc;
    const deadline = expect(rpc.request("projects.list", {})).rejects.toMatchObject({
      code: "deadline",
      retryable: true,
    });
    await tick(30_000);
    await deadline;
    const dropped = expect(rpc.request("agents.catalog", {})).rejects.toMatchObject({
      code: "disconnected",
      retryable: true,
    });
    host.closeAll();
    await tick();
    await dropped;
    await expect(rpc.request("projects.list", {})).rejects.toMatchObject({
      code: "disconnected",
      retryable: true,
    });
  });
});

function inboxMessage(pageId: string): InboxMessage {
  return {
    pageId,
    pageKey: null,
    title: "Capture",
    body: "Captured text",
    bodyTruncated: false,
    submittedAt: new Date().toISOString(),
    source: { kind: "user", label: null },
    important: false,
    state: "open",
    outcome: null,
    suggestion: { state: "none", error: null },
    proposal: null,
    chatSessionId: null,
    scope: LIBRARY_INBOX,
    revision: 1,
  };
}

describe("Inbox outbox", () => {
  it("survives restart with owned originals, retries the same identities and uploads afresh in order", async () => {
    const { platform, host, runtime, saved } = await setup();
    platform.setForeground(false);
    host.closeAll();
    await tick();
    const image: LocalImage = {
      uri: "file://picker/source.png",
      name: "source.png",
      mimeType: "image/png",
      width: 4000,
      height: 2500,
    };
    const size = MOBILE_FILE_CHUNK_BYTES + 17;
    platform.contents.set(image.uri, new Uint8Array(size).fill(7));
    const firstId = runtime.outbox.captureToInbox({
      scope: LIBRARY_INBOX,
      text: "first",
      images: [image],
    });
    const secondId = runtime.outbox.captureToInbox({
      scope: LIBRARY_INBOX,
      text: "second",
      images: [],
    });
    expect(platform.compression).toHaveLength(0);
    expect(runtime.outbox.store.getState()[0]?.capture.images[0]?.uri).toMatch(
      /^file:\/\/documents\//u,
    );
    platform.contents.delete(image.uri);
    await runtime.dispose();
    const restarted = start(platform);
    expect(
      restarted.outbox
        .visiblePending(saved.hostId, LIBRARY_INBOX, new Set())
        .map((item) => item.captureId),
    ).toEqual([firstId, secondId]);
    const accepted = new Map<string, InboxMessage>();
    let lostReply = false;
    let uploadId = 0;
    host.onRequest = (request, reply, fail) => {
      if (request.m === "files.upload.begin") reply({ uploadId: String(++uploadId) });
      else if (request.m === "files.upload.chunk") reply({});
      else if (request.m === "files.upload.commit")
        reply({
          ref: `nodex://files/${uploadId}`,
          name: "source.jpg",
          mimeType: "image/jpeg",
          size,
        });
      else if (request.m === "inbox.window")
        reply({ items: [...accepted.values()].reverse(), nextCursor: null });
      else if (request.m === "inbox.capture") {
        const capture = request.p as MobileParams<"inbox.capture">;
        if (!lostReply) {
          lostReply = true;
          host.closeAll();
          return;
        }
        if (!accepted.has(capture.operationId))
          accepted.set(capture.operationId, inboxMessage(capture.pageId));
        reply({ pageId: capture.pageId });
      } else if (request.m === "inbox.message") {
        fail("Inbox message is unavailable", false, "not_found");
      }
    };
    platform.setForeground(true);
    await tick();
    const [firstAttempt] = params(host, "inbox.capture");
    expect(firstAttempt?.text).toBe("first");
    expect(firstAttempt?.operationId).not.toBe(firstId);
    await tick(1_000);
    const attempts = params(host, "inbox.capture");
    expect(attempts.map((request) => request.text)).toEqual(["first", "first", "second"]);
    expect(attempts[1]?.operationId).toBe(firstAttempt?.operationId);
    expect(attempts[2]?.operationId).not.toBe(secondId);
    expect(attempts[2]?.operationId).not.toBe(firstAttempt?.operationId);
    expect(attempts[0]).toMatchObject({ ...attempts[1], fileRefs: ["nodex://files/1"] });
    expect(attempts[1]?.fileRefs).toEqual(["nodex://files/2"]);
    expect(accepted.size).toBe(2);
    expect(platform.compression.map(({ longestSide, quality }) => [longestSide, quality])).toEqual([
      [2560, 0.8],
    ]);
    expect(params(host, "files.upload.chunk").map(({ offset }) => offset)).toEqual([
      0,
      MOBILE_FILE_CHUNK_BYTES,
      0,
      MOBILE_FILE_CHUNK_BYTES,
    ]);
    const list = restarted.lists.inbox(saved.hostId, LIBRARY_INBOX, "inbox");
    const detach = list.attach();
    await tick();
    expect(list.store.getState().items.map((item) => item.pageId)).toEqual(
      [...accepted.values()].map((item) => item.pageId),
    );
    expect(restarted.outbox.store.getState()).toEqual([]);
    expect(platform.contents.size).toBe(0);
    detach();
  });

  it("does not upload or resend a capture whose answer was lost after it landed", async () => {
    const { platform, host, runtime } = await setup();
    const image: LocalImage = {
      uri: "file://picker/landed.png",
      name: "landed.png",
      mimeType: "image/png",
      width: 100,
      height: 100,
    };
    platform.contents.set(image.uri, new Uint8Array(32).fill(3));
    let landed: string | null = null;
    host.onRequest = (request, reply, fail) => {
      if (request.m === "files.upload.begin") reply({ uploadId: "1" });
      else if (request.m === "files.upload.chunk") reply({});
      else if (request.m === "files.upload.commit")
        reply({ ref: "nodex://files/1", name: "landed.jpg", mimeType: "image/jpeg", size: 32 });
      else if (request.m === "inbox.capture") {
        landed = (request.p as MobileParams<"inbox.capture">).pageId;
        host.closeAll();
      } else if (request.m === "inbox.message") {
        const { pageId } = request.p as MobileParams<"inbox.message">;
        if (pageId === landed) reply(inboxMessage(pageId));
        else fail("Inbox message is unavailable", false, "not_found");
      } else reply({ items: [], nextCursor: null });
    };
    runtime.outbox.captureToInbox({ scope: LIBRARY_INBOX, text: "Landed", images: [image] });
    await tick();
    expect(params(host, "inbox.capture")).toHaveLength(1);
    await tick(1_000);
    expect(params(host, "inbox.message")).toEqual([{ pageId: landed }]);
    expect(params(host, "inbox.capture")).toHaveLength(1);
    expect(params(host, "files.upload.begin")).toHaveLength(1);
    expect(runtime.outbox.store.getState()[0]?.delivered).toBe(true);
  });

  it("mints and persists the delivery identity after a capture has waited offline for days", async () => {
    const { platform, host, runtime } = await setup();
    platform.setForeground(false);
    host.closeAll();
    await tick();
    const createdAt = platform.now();
    runtime.outbox.captureToInbox({ scope: LIBRARY_INBOX, text: "Offline", images: [] });
    const [draft] = runtime.outbox.store.getState();
    expect(draft?.delivery).toBeNull();
    expect(params(host, "inbox.capture")).toHaveLength(0);
    await runtime.dispose();
    vi.setSystemTime(createdAt + 8 * 24 * 60 * 60 * 1_000);
    let persistedAtDelivery: unknown;
    host.onRequest = (request, reply) => {
      const capture = request.p as MobileParams<"inbox.capture">;
      const outbox = platform.data.get("nodex.mobile.outbox.v1");
      persistedAtDelivery = outbox && JSON.parse(outbox)[0].delivery;
      reply({ pageId: capture.pageId });
    };
    start(platform);
    platform.setForeground(true);
    await tick();
    const [capture] = params(host, "inbox.capture");
    expect(capture).toMatchObject({
      pageId: draft?.pageId,
      documentId: draft?.documentId,
      issuedAt: platform.now(),
    });
    expect(persistedAtDelivery).toEqual({
      operationId: capture?.operationId,
      issuedAt: capture?.issuedAt,
    });
  });

  it.each([true, false])(
    "manually retries an expired delivery without duplicating its message (committed: %s)",
    async (committed) => {
      const { platform, host, runtime, saved } = await setup();
      const expiry =
        "This operation is outside Core's retained idempotency window; do not replay it implicitly";
      const windowMs = 7 * 24 * 60 * 60 * 1_000;
      const messages = new Map<string, InboxMessage>();
      let first = true;
      host.onRequest = (request, reply, fail) => {
        if (request.m === "inbox.message") {
          const { pageId } = request.p as MobileParams<"inbox.message">;
          const existing = messages.get(pageId);
          if (existing) reply(existing);
          else fail("Inbox message is unavailable", false, "not_found");
          return;
        }
        const capture = request.p as MobileParams<"inbox.capture">;
        if (platform.now() - capture.issuedAt >= windowMs) {
          fail(expiry, false);
          return;
        }
        if (messages.has(capture.pageId)) {
          fail(`Copied Block identity is not fresh: ${capture.pageId}`, false);
          return;
        }
        if (!first || committed) messages.set(capture.pageId, inboxMessage(capture.pageId));
        if (first) {
          first = false;
          host.closeAll();
        } else reply({ pageId: capture.pageId });
      };
      const id = runtime.outbox.captureToInbox({
        scope: LIBRARY_INBOX,
        text: "Unconfirmed",
        images: [],
      });
      await tick();
      const [initial] = params(host, "inbox.capture");
      await runtime.dispose();
      vi.setSystemTime(platform.now() + windowMs);
      const restarted = start(platform);
      await tick();
      if (committed) {
        // What landed is found on the way back, with nothing to resend or to fail.
        expect(params(host, "inbox.capture")).toEqual([initial]);
        expect([...messages.keys()]).toEqual([initial?.pageId]);
        expect(restarted.outbox.store.getState()[0]?.delivered).toBe(true);
        return;
      }
      expect(params(host, "inbox.capture")).toEqual([initial, initial]);
      expect(
        restarted.outbox.visiblePending(saved.hostId, LIBRARY_INBOX, new Set())[0],
      ).toMatchObject({
        state: "failed",
        error: expiry,
      });
      await tick(60_000);
      expect(params(host, "inbox.capture")).toHaveLength(2);
      restarted.outbox.retryCapture(id);
      await tick();
      const attempts = params(host, "inbox.capture");
      expect(attempts).toHaveLength(3);
      expect(attempts[2]).toMatchObject({
        pageId: initial?.pageId,
        documentId: initial?.documentId,
        issuedAt: platform.now(),
      });
      expect(attempts[2]?.operationId).not.toBe(initial?.operationId);
      expect([...messages.keys()]).toEqual([initial?.pageId]);
      expect(restarted.outbox.store.getState()[0]?.delivered).toBe(true);
    },
  );

  it("backs off on a retryable response and keeps a rejection until manually retried", async () => {
    const { host, runtime, saved } = await setup();
    let attempts = 0;
    host.onRequest = (request, reply, fail) => {
      if (request.m === "inbox.message") return fail("Unavailable", false, "not_found");
      const capture = request.p as MobileParams<"inbox.capture">;
      if (++attempts === 1) fail("Try again later", true);
      else if (attempts === 2) fail("Inbox is locked", false);
      else reply({ pageId: capture.pageId });
    };
    const id = runtime.outbox.captureToInbox({ scope: LIBRARY_INBOX, text: "Capture", images: [] });
    await tick(999);
    expect(attempts).toBe(1);
    await tick(1);
    expect(runtime.outbox.visiblePending(saved.hostId, LIBRARY_INBOX, new Set())[0]).toMatchObject({
      captureId: id,
      state: "failed",
      error: "Inbox is locked",
    });
    await tick(60_000);
    expect(attempts).toBe(2);
    runtime.outbox.retryCapture(id);
    await tick();
    expect(attempts).toBe(3);
    expect(params(host, "inbox.capture")).toEqual(Array(3).fill(params(host, "inbox.capture")[0]));
    runtime.outbox.discardCapture(id);
    expect(runtime.outbox.store.getState()).toEqual([]);
  });

  it("keeps acknowledged captures visible until the matching page is in the window", async () => {
    const { host, runtime, saved } = await setup();
    let message: InboxMessage | null = null;
    let visible = false;
    host.onRequest = (request, reply) => {
      if (request.m === "inbox.capture") {
        const { pageId } = request.p as MobileParams<"inbox.capture">;
        message = inboxMessage(pageId);
        reply({ pageId });
      } else reply({ items: visible && message ? [message] : [], nextCursor: null });
    };
    const list = runtime.lists.inbox(saved.hostId, LIBRARY_INBOX, "inbox");
    const detach = list.attach();
    await tick();
    runtime.outbox.captureToInbox({ scope: LIBRARY_INBOX, text: "Still here", images: [] });
    await tick(60);
    const countRows = () => {
      const ids = new Set(list.store.getState().items.map((item) => item.pageId));
      return ids.size + runtime.outbox.visiblePending(saved.hostId, LIBRARY_INBOX, ids).length;
    };
    expect(countRows()).toBe(1);
    expect(list.store.getState().items).toEqual([]);
    const seen: number[] = [];
    const listeners = [
      list.store.subscribe(() => seen.push(countRows())),
      runtime.outbox.store.subscribe(() => seen.push(countRows())),
    ];
    visible = true;
    host.emit({ t: "evt", k: "changed", d: { topics: ["inbox"] } });
    await tick(60);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual(Array(seen.length).fill(1));
    expect(list.store.getState().items).toEqual([message]);
    expect(runtime.outbox.store.getState()).toEqual([]);
    for (const stop of listeners) stop();
    detach();
  });
});

const assistant = (id: string, text: string): ChatItem => ({
  kind: "assistant",
  id,
  text,
  at: new Date().toISOString(),
  streaming: true,
  truncated: false,
});

function snapshot(
  items: ChatItem[],
  historyCursor: string | null = null,
  revision = 1,
): ChatSnapshot {
  return {
    sessionId: "chat",
    revision,
    title: "Chat",
    projectName: null,
    items,
    historyCursor,
    state: {
      status: "running",
      activeRunId: "run",
      queuedCount: 0,
      requests: [],
      agentLabel: null,
      sendBlockedReason: null,
    },
  };
}

describe("Chat stream", () => {
  it("batches ordered patches, preserves unchanged items, reopens on a mismatch and replaces overflow snapshots", async () => {
    const { host, runtime, saved } = await setup();
    let current = snapshot([assistant("fixed", "Hello"), assistant("live", "A😀")], "older");
    host.onRequest = (request, reply) => {
      if (request.m === "chat.open") reply(current);
      else if (request.m === "chat.history")
        reply({ items: [assistant("earlier", "Before"), current.items[0]], historyCursor: null });
      else reply({});
    };
    const chat = runtime.chats.get(saved.hostId, "chat");
    const detach = chat.attach();
    await tick();
    const fixed = chat.store.getState().chat?.items[0];
    let updates = 0;
    const unsubscribe = chat.store.subscribe(() => updates++);
    host.emit({
      t: "evt",
      k: "chat.patch",
      d: {
        sessionId: "chat",
        revision: 2,
        ops: [
          { op: "append", itemId: "live", offset: 3, text: "B" },
          { op: "title", title: "New title" },
        ],
      },
    });
    host.emit({
      t: "evt",
      k: "chat.patch",
      d: {
        sessionId: "chat",
        revision: 3,
        ops: [
          { op: "append", itemId: "live", offset: 4, text: "C" },
          { op: "upsert", item: assistant("later", "Later") },
          { op: "remove", itemId: "later" },
        ],
      },
    });
    await tick(59);
    expect(updates).toBe(0);
    await tick(1);
    expect(updates).toBe(1);
    expect(chat.store.getState().chat).toMatchObject({
      title: "New title",
      items: [fixed, { text: "A😀BC" }],
    });
    expect(chat.store.getState().chat?.items[0]).toBe(fixed);
    chat.loadOlder();
    await tick();
    expect(chat.store.getState().chat?.items.map((item) => item.id)).toEqual([
      "earlier",
      "fixed",
      "live",
    ]);
    expect(chat.store.getState().hasOlder).toBe(false);
    current = snapshot([assistant("fixed", "Hello"), assistant("live", "Resynced")], null, 4);
    host.emit({
      t: "evt",
      k: "chat.patch",
      d: {
        sessionId: "chat",
        revision: 4,
        ops: [{ op: "append", itemId: "live", offset: 900, text: "wrong" }],
      },
    });
    await tick();
    expect(params(host, "chat.open")).toHaveLength(2);
    expect(chat.store.getState().chat?.items[1]).toMatchObject({ text: "Resynced" });
    host.emit({
      t: "evt",
      k: "chat.snapshot",
      d: snapshot([assistant("replacement", "Overflow")], null, 5),
    });
    await tick();
    expect(chat.store.getState().chat?.items.map((item) => item.id)).toEqual(["replacement"]);
    unsubscribe();
    detach();
  });

  it.each([false, true])(
    "ignores stale snapshots on one connection (buffered: %s)",
    async (buffered) => {
      const { host, runtime, saved } = await setup();
      const fresh = snapshot([assistant("live", "Current")], null, 9);
      let replyOpen: ((value: ChatSnapshot) => void) | undefined;
      host.onRequest = (request, reply) => {
        if (request.m === "chat.open") replyOpen = reply;
        else reply({});
      };
      const chat = runtime.chats.get(saved.hostId, "chat");
      const detach = chat.attach();
      await tick();
      const stale = {
        ...snapshot([assistant("live", "Old")], null, 8),
        state: { ...fresh.state, status: "idle" as const, activeRunId: null },
      };
      if (buffered) {
        host.emit({ t: "evt", k: "chat.snapshot", d: stale });
        await tick();
      }
      replyOpen?.(fresh);
      await tick();
      if (!buffered) {
        host.emit({ t: "evt", k: "chat.snapshot", d: stale });
        await tick();
      }
      expect(chat.store.getState().chat).toEqual(fresh);
      const recovery = { ...fresh, title: "Recovered" };
      host.emit({ t: "evt", k: "chat.snapshot", d: recovery });
      await tick();
      expect(chat.store.getState().chat).toEqual(recovery);
      detach();
    },
  );

  it("drops stale patches, advances contiguous revisions and reopens on a gap", async () => {
    const { host, runtime, saved } = await setup();
    let current = snapshot([assistant("live", "Original")], null, 4);
    let reopen: ((value: ChatSnapshot) => void) | undefined;
    host.onRequest = (request, reply) => {
      if (request.m !== "chat.open") reply({});
      else if (params(host, "chat.open").length === 1) reply(current);
      else reopen = reply;
    };
    const patch = (revision: number, ops: ChatPatchOp[]) =>
      host.emit({ t: "evt", k: "chat.patch", d: { sessionId: "chat", revision, ops } });
    const chat = runtime.chats.get(saved.hostId, "chat");
    const detach = chat.attach();
    await tick();
    const original = chat.store.getState().chat;
    patch(3, [{ op: "title", title: "Old title" }]);
    patch(4, [{ op: "append", itemId: "live", offset: 0, text: "invalid but stale" }]);
    await tick(60);
    expect(chat.store.getState().chat).toBe(original);
    expect(params(host, "chat.open")).toHaveLength(1);

    patch(5, []);
    patch(6, [{ op: "title", title: "Current title" }]);
    await tick(60);
    expect(chat.store.getState().chat).toMatchObject({ revision: 6, title: "Current title" });
    expect(params(host, "chat.open")).toHaveLength(1);

    patch(8, [{ op: "title", title: "Gap" }]);
    await tick();
    expect(params(host, "chat.open")).toHaveLength(2);
    current = snapshot([assistant("live", "Resynced")], null, 9);
    patch(8, [{ op: "title", title: "Buffered stale title" }]);
    patch(10, [{ op: "title", title: "Buffered live title" }]);
    host.emit({ t: "evt", k: "chat.snapshot", d: { ...current, revision: 3, title: "Old watch" } });
    await tick();
    reopen?.(current);
    await tick();
    current = { ...current, revision: 10, title: "Buffered live title" };
    expect(chat.store.getState().chat).toEqual(current);

    patch(8, [{ op: "title", title: "Late stale title" }]);
    await tick(60);
    expect(chat.store.getState().chat).toEqual(current);
    expect(params(host, "chat.open")).toHaveLength(2);

    host.emit({ t: "evt", k: "chat.snapshot", d: { ...current, revision: 12 } });
    patch(12, [{ op: "title", title: "Snapshot revision already seen" }]);
    patch(13, [{ op: "title", title: "After snapshot" }]);
    await tick(60);
    expect(chat.store.getState().chat).toMatchObject({ revision: 13, title: "After snapshot" });
    expect(params(host, "chat.open")).toHaveLength(2);
    detach();
  });

  it("shares subscriptions, cancels a pending close on reattach and reopens on reconnect", async () => {
    const { host, runtime, saved } = await setup();
    let current = snapshot([assistant("first", "Before disconnect")], null, 9);
    host.onRequest = (request, reply) => reply(request.m === "chat.open" ? current : {});
    const chat = runtime.chats.get(saved.hostId, "chat");
    const detachFirst = chat.attach();
    const detachSecond = chat.attach();
    await tick();
    expect(params(host, "chat.open")).toHaveLength(1);
    expect(params(host, "chat.markRead")).toHaveLength(1);
    detachFirst();
    await tick(1_000);
    expect(params(host, "chat.close")).toHaveLength(0);
    detachSecond();
    await tick(500);
    const detachThird = chat.attach();
    await tick(500);
    expect(params(host, "chat.open")).toHaveLength(1);
    expect(params(host, "chat.close")).toHaveLength(0);
    current = snapshot([assistant("second", "After reconnect")]);
    host.closeAll();
    await tick();
    await tick(1_000);
    expect(params(host, "chat.open")).toHaveLength(2);
    expect(chat.store.getState().chat?.items.map((item) => item.id)).toEqual(["second"]);
    detachThird();
    await tick(750);
    expect(params(host, "chat.close")).toHaveLength(1);
  });
});

it.each([false, true])(
  "deduplicates file reads and resumes a pinned partial file (restart: %s)",
  async (restart) => {
    const { platform, host, runtime, saved } = await setup();
    const ref = "nodex://files/asset";
    const totalBytes = MOBILE_FILE_CHUNK_BYTES + 11;
    let interrupted = false;
    host.onRequest = (request, reply) => {
      const { offset, length } = request.p as MobileParams<"files.read">;
      if (offset && !interrupted) {
        interrupted = true;
        host.closeAll();
        return;
      }
      reply({
        base64: Buffer.alloc(Math.min(length, totalBytes - offset), 7).toString("base64"),
        totalBytes,
        mimeType: "image/png",
        name: "asset.png",
        version: "asset-v1",
      });
    };
    const file = runtime.files.get(saved.hostId, ref);
    const detach = file.attach();
    const detachSecond = runtime.files.get(saved.hostId, ref).attach();
    await tick();
    expect(file.store.getState().uri).toBeNull();
    expect([...platform.contents.values()][0]?.length).toBe(MOBILE_FILE_CHUNK_BYTES);
    let resumed = file;
    let detachRestarted: (() => void) | undefined;
    if (restart) {
      await runtime.dispose();
      resumed = start(platform).files.get(saved.hostId, ref);
      detachRestarted = resumed.attach();
    }
    await tick(1_000);
    const uri = resumed.store.getState().uri;
    expect(uri).toMatch(/\.png$/u);
    expect(platform.contents.get(uri ?? "")).toHaveLength(totalBytes);
    expect(params(host, "files.read").map(({ offset, version }) => [offset, version])).toEqual([
      [0, undefined],
      [MOBILE_FILE_CHUNK_BYTES, "asset-v1"],
      [MOBILE_FILE_CHUNK_BYTES, "asset-v1"],
    ]);
    detach();
    detachSecond();
    detachRestarted?.();
  },
);

it.each([false, true])(
  "restarts a version-conflicted file from zero (keeps changing: %s)",
  async (keepsChanging) => {
    const { platform, host, runtime, saved } = await setup();
    let version = 1;
    host.onRequest = (request, reply, fail) => {
      const { offset, version: expected } = request.p as MobileParams<"files.read">;
      if (offset && (version === 1 || keepsChanging)) version++;
      if (offset && expected !== String(version)) {
        fail("This file changed", false, "conflict");
        return;
      }
      reply({
        base64: Buffer.from([version]).toString("base64"),
        totalBytes: 2,
        mimeType: "image/png",
        name: "asset.png",
        version: String(version),
      });
    };
    const file = runtime.files.get(saved.hostId, "nodex://files/asset");
    const detach = file.attach();
    await tick();
    if (keepsChanging) {
      expect(file.store.getState()).toMatchObject({
        uri: null,
        loading: false,
        error: "This file changed",
      });
      await expect(runtime.resolveFileUri("nodex://files/asset")).rejects.toMatchObject({
        code: "conflict",
        message: "This file changed",
        retryable: false,
      });
      expect(platform.contents.size).toBe(0);
      runtime.connection.reconnectNow();
      await tick();
    } else {
      const { uri } = file.store.getState();
      expect(uri && Array.from(platform.contents.get(uri) ?? [])).toEqual([2, 2]);
    }
    expect(params(host, "files.read").map(({ offset, version }) => [offset, version])).toEqual([
      [0, undefined],
      [1, "1"],
      [0, undefined],
      [1, "2"],
      ...(keepsChanging
        ? [
            [0, undefined],
            [1, "3"],
          ]
        : []),
    ]);
    detach();
  },
);

it("restarts a partial file without a version after reconnect", async () => {
  const { platform, host, runtime, saved } = await setup();
  let interrupted = false;
  host.onRequest = (request, reply) => {
    const { offset } = request.p as MobileParams<"files.read">;
    if (offset && !interrupted) {
      interrupted = true;
      host.closeAll();
      return;
    }
    reply({
      base64: Buffer.from([interrupted ? 2 : 1]).toString("base64"),
      totalBytes: 2,
      mimeType: null,
      name: null,
      version: null,
    });
  };
  const file = runtime.files.get(saved.hostId, "nodex://files/asset");
  const detach = file.attach();
  await tick(1_000);
  const { uri } = file.store.getState();
  expect(uri && Array.from(platform.contents.get(uri) ?? [])).toEqual([2, 2]);
  expect(params(host, "files.read").map(({ offset, version }) => [offset, version])).toEqual([
    [0, undefined],
    [1, null],
    [0, undefined],
    [1, null],
  ]);
  detach();
});

it("revalidates the Inbox window without reusing stale pages and hydrates the first page offline", async () => {
  const { platform, host, runtime, saved } = await setup();
  const older = inboxMessage("older");
  const middle = inboxMessage("middle");
  const latest = inboxMessage("latest");
  let changed = false;
  host.onRequest = (request, reply) => {
    const { after } = request.p as MobileParams<"inbox.window">;
    if (after === "before-middle")
      reply({ items: changed ? [] : [middle, older], nextCursor: null });
    else reply({ items: changed ? [latest] : [latest, middle], nextCursor: "before-middle" });
  };
  const list = runtime.lists.inbox(saved.hostId, LIBRARY_INBOX, "inbox");
  const detach = list.attach();
  await tick();
  const latestRow = list.store.getState().items.at(-1);
  list.loadMore();
  await tick();
  expect(list.store.getState().items.map((item) => item.pageId)).toEqual([
    "older",
    "middle",
    "latest",
  ]);
  expect(list.store.getState().items.at(-1)).toBe(latestRow);
  changed = true;
  host.emit({ t: "evt", k: "changed", d: { topics: ["inbox"] } });
  host.emit({ t: "evt", k: "changed", d: { topics: ["inbox"] } });
  await tick(60);
  expect(params(host, "inbox.window").map(({ after }) => after)).toEqual([
    null,
    "before-middle",
    null,
    "before-middle",
  ]);
  expect(list.store.getState().items).toEqual([latestRow]);
  detach();
  platform.setForeground(false);
  await runtime.dispose();
  const restarted = start(platform);
  const hydrated = restarted.lists.inbox(saved.hostId, LIBRARY_INBOX, "inbox");
  expect(hydrated.store.getState()).toMatchObject({ items: [latest], loading: false });
});

it("updates chat activity in place and accepts list order on refresh", async () => {
  const { host, runtime, saved } = await setup();
  const summary = (sessionId: string) => ({
    sessionId,
    title: sessionId,
    preview: "",
    projectId: null,
    projectName: null,
    agentLabel: null,
    status: "idle",
    pendingRequestCount: 0,
    attention: null,
    unread: false,
    pinned: false,
    archived: false,
    activityAt: null,
    canSend: true,
  });
  let items = [summary("first"), summary("second")];
  host.onRequest = (_request, reply) => reply({ items, nextCursor: null });
  const list = runtime.lists.chats(saved.hostId, {});
  const detach = list.attach();
  await tick();
  const first = list.store.getState().items[0];
  host.emit({
    t: "evt",
    k: "chat.activity",
    d: {
      sessionId: "second",
      status: "waiting",
      pendingRequestCount: 1,
      attention: "Approval needed",
    },
  });
  await tick();
  expect(params(host, "chats.list")).toHaveLength(1);
  expect(list.store.getState().items[0]).toBe(first);
  expect(list.store.getState().items[1]).toMatchObject({ sessionId: "second", status: "waiting" });
  items = [...items].reverse();
  list.refresh();
  await tick(60);
  expect(list.store.getState().items.map(({ sessionId, status }) => [sessionId, status])).toEqual([
    ["second", "idle"],
    ["first", "idle"],
  ]);
  expect(list.store.getState().items[1]).toBe(first);
  detach();
});

it("retries start, send and answers with stable identities and remembers successful launch preferences", async () => {
  const { platform, host, runtime, saved } = await setup();
  const image: LocalImage = {
    uri: "file://picker/source.jpg",
    name: "source.jpg",
    mimeType: "image/jpeg",
    width: 4000,
    height: 2500,
  };
  platform.contents.set(image.uri, new Uint8Array(17));
  const received = new Set<string>();
  let uploads = 0;
  host.onRequest = ({ m, p }, reply, fail) => {
    if (m === "files.upload.begin") return reply({ uploadId: String(++uploads) });
    if (m === "files.upload.chunk") return reply({});
    if (m === "files.upload.commit")
      return reply({
        ref: "nodex://files/stable",
        name: image.name,
        mimeType: image.mimeType,
        size: 17,
      });
    if (!received.has(m)) {
      received.add(m);
      fail("Try again", true);
      return;
    }
    reply(m === "chats.start" ? { sessionId: (p as MobileParams<"chats.start">).sessionId } : {});
  };
  const preference = { projectId: "project", location: "worktree" as const, agent: null };
  const launched = runtime.startChat({ ...preference, text: "Launch", images: [image] });
  await tick(1_000);
  const { sessionId } = await launched;
  expect(params(host, "chats.start")).toEqual(Array(2).fill(params(host, "chats.start")[0]));
  expect(runtime.getPreferences(saved.hostId).getState()).toMatchObject(preference);
  expect(uploads).toBe(2);
  expect(platform.compression).toHaveLength(1);
  expect([...platform.contents.keys()]).toEqual([image.uri]);
  const chat = runtime.chats.get(saved.hostId, sessionId);
  const sent = chat.send("Follow-up", [], "steer");
  const answer = { kind: "option" as const, optionId: "allow", feedback: null };
  const responded = chat.respond("request", "run", answer);
  await tick(1_000);
  await Promise.all([sent, responded]);
  expect(params(host, "chat.send")).toEqual(Array(2).fill(params(host, "chat.send")[0]));
  await chat.respond("request", "run", answer);
  expect(params(host, "chat.respond")).toEqual(Array(3).fill(params(host, "chat.respond")[0]));
  host.closeAll();
  await tick();
  await expect(
    runtime.startChat({ ...preference, text: "Offline", images: [] }),
  ).rejects.toMatchObject({ code: "disconnected", retryable: true });
  expect(params(host, "chats.start")).toHaveLength(2);
});

it("keeps synchronous commands usable with the native scheduler", async () => {
  vi.useRealTimers();
  const platform = fakePlatform();
  const host = new FakeHost();
  platform.routes.set(route, host);
  const runtime = createMobileRuntime(platform);
  runtimes.push(runtime);
  await runtime.connection.pairWithUri(pairingUri(platform, host));
  expect(() => runtime.connection.reconnectNow()).not.toThrow();
  const id = runtime.outbox.captureToInbox({ scope: LIBRARY_INBOX, text: "Durable", images: [] });
  expect(typeof id).toBe("string");
  const stored = JSON.parse(platform.data.get("nodex.mobile.outbox.v1") ?? "[]");
  expect(stored[0].capture.captureId).toBe(id);
});

it("interrupts every pending pairing route and leaves no runtime timers after disposal", async () => {
  const platform = fakePlatform();
  const host = new FakeHost();
  const alternate = "ws://host-a:4000/mobile";
  platform.routes.set(route, "stall");
  platform.routes.set(alternate, "stall");
  const runtime = start(platform);
  const paired = expect(
    runtime.connection.pairWithUri(pairingUri(platform, host, [route, alternate])),
  ).rejects.toMatchObject({ code: "unreachable" });
  await tick(250);
  expect(platform.dials).toHaveLength(2);
  await runtime.dispose();
  await paired;
  expect(platform.dials.every((dial) => dial.closed)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  platform.setForeground(false);
  platform.setForeground(true);
  await tick(60_000);
  expect(platform.dials).toHaveLength(2);
});

it("disposes a subscribed chat and an unanswered RPC without waiting for the Host", async () => {
  const { host, platform, runtime, saved } = await setup();
  host.onRequest = (request, reply) => {
    if (request.m === "chat.open") reply(snapshot([assistant("live", "Reply")]));
  };
  const detach = runtime.chats.get(saved.hostId, "chat").attach();
  await tick();
  const pending = expect(runtime.connection.rpc.request("projects.list", {})).rejects.toMatchObject(
    { code: "disconnected", retryable: true },
  );
  await tick();
  await runtime.dispose();
  await pending;
  expect(platform.dials.every((dial) => dial.closed)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(() => detach()).not.toThrow();
});

it.each(["nodex://files/asset", "chat-attachment:asset"])(
  "shares an imperative file read with the mounted view and cache: %s",
  async (ref) => {
    const { platform, host, runtime, saved } = await setup();
    const replies: ((result: unknown) => void)[] = [];
    host.onRequest = (_request, reply) => {
      replies.push(reply);
    };
    const file = runtime.files.get(saved.hostId, ref);
    const detach = file.attach();
    const first = runtime.resolveFileUri(ref);
    const second = runtime.resolveFileUri(ref);
    await tick();
    expect(params(host, "files.read")).toHaveLength(1);
    replies.shift()?.({
      base64: Buffer.from([1]).toString("base64"),
      totalBytes: 2,
      mimeType: "image/png",
      name: "asset.png",
      version: "v1",
    });
    await tick();
    expect(params(host, "files.read")).toMatchObject([{ offset: 0 }, { offset: 1, version: "v1" }]);
    replies.shift()?.({
      base64: Buffer.from([2]).toString("base64"),
      totalBytes: 2,
      mimeType: "image/png",
      name: "asset.png",
      version: "v1",
    });
    await tick();
    const uri = await first;
    await expect(second).resolves.toBe(uri);
    expect(file.store.getState().uri).toBe(uri);
    expect(Array.from(platform.contents.get(uri) ?? [])).toEqual([1, 2]);
    await expect(runtime.resolveFileUri(ref)).resolves.toBe(uri);
    expect(params(host, "files.read")).toHaveLength(2);
    detach();
  },
);

it("rejects an imperative file read the Host refuses", async () => {
  const { host, runtime } = await setup();
  host.onRequest = (_request, _reply, fail) => fail("File is unavailable", false, "not_found");
  await expect(runtime.resolveFileUri("nodex://files/missing")).rejects.toMatchObject({
    code: "not_found",
    message: "File is unavailable",
    retryable: false,
  });
});

it("holds an imperative file read until the phone is connected again", async () => {
  const { platform, host, runtime } = await setup();
  host.onRequest = (_request, reply) =>
    reply({
      base64: Buffer.from([7]).toString("base64"),
      totalBytes: 1,
      mimeType: "image/png",
      name: "offline.png",
      version: "v1",
    });
  platform.routes.set(route, "unreachable");
  host.closeAll();
  await tick();
  let settled = false;
  const pending = runtime.resolveFileUri("nodex://files/offline").finally(() => {
    settled = true;
  });
  await tick(10_000);
  expect(settled).toBe(false);
  expect(params(host, "files.read")).toEqual([]);
  platform.routes.set(route, host);
  await tick(40_000);
  const uri = await pending;
  expect(params(host, "files.read")).toHaveLength(1);
  expect(Array.from(platform.contents.get(uri) ?? [])).toEqual([7]);
});

it("rejects a file resolver when native cache access fails", async () => {
  const { platform, host, runtime } = await setup();
  host.onRequest = (_request, reply) =>
    reply({
      base64: Buffer.from([1]).toString("base64"),
      totalBytes: 1,
      mimeType: null,
      name: null,
      version: "v1",
    });
  platform.files.uri = () => {
    throw new Error("Storage unavailable");
  };
  await expect(runtime.resolveFileUri("nodex://files/unreadable")).rejects.toMatchObject({
    code: "internal",
    retryable: false,
  });
});

it("cleans up an image whose native compression completes during disposal", async () => {
  const { platform, runtime } = await setup();
  const image: LocalImage = {
    uri: "file://picker/original.png",
    name: "original.png",
    mimeType: "image/png",
    width: 100,
    height: 100,
  };
  const temporary = "file://cache/compressed.jpg";
  platform.contents.set(image.uri, Uint8Array.of(1));
  let finish: ((image: LocalImage) => void) | undefined;
  platform.compressImage = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const sent = expect(
    runtime.startChat({
      text: "Send",
      images: [image],
      projectId: null,
      agent: null,
      location: "local",
    }),
  ).rejects.toMatchObject({ code: "disconnected", retryable: true });
  await tick();
  expect(finish).toBeDefined();
  const disposed = runtime.dispose();
  platform.contents.set(temporary, Uint8Array.of(1));
  finish?.({ ...image, uri: temporary });
  await disposed;
  await sent;
  expect([...platform.contents.keys()]).toEqual([image.uri]);
  expect(vi.getTimerCount()).toBe(0);
});

it("recovers from bounded socket ingress overflow without losing pairing keys", async () => {
  const { host, platform, runtime } = await setup();
  const keys = [...platform.savedSecrets];
  for (let index = 0; index < 140; index++)
    host.emit({ t: "evt", k: "changed", d: { topics: ["inbox"] } });
  await tick();
  expect(runtime.connection.state.getState().status).toBe("offline");
  expect(platform.dials[0]?.closed).toBe(true);
  expect([...platform.savedSecrets]).toEqual(keys);
  await tick(1_000);
  expect(runtime.connection.state.getState().status).toBe("connected");
  expect(platform.dials).toHaveLength(2);
});

it("evicts idle files within the cache size limit and preserves mounted files", async () => {
  const { platform, host, runtime, saved } = await setup();
  host.onRequest = (request, reply) => {
    const { ref } = request.p as MobileParams<"files.read">;
    const bytes = ref === "nodex://files/new" ? [1, 2, 3] : [1];
    reply({
      base64: Buffer.from(bytes).toString("base64"),
      totalBytes: bytes.length,
      mimeType: null,
      name: null,
      version: "v1",
    });
  };
  const mountedUri = await runtime.resolveFileUri("nodex://files/mounted");
  const idleUri = await runtime.resolveFileUri("nodex://files/idle");
  await runtime.dispose();
  // The native fixture represents large complete files without allocating their bytes in the test.
  const stored = JSON.parse(platform.data.get("nodex.mobile.file-cache.v1") ?? "{}") as Record<
    string,
    { uri: string; size: number; usedAt: number }
  >;
  const limit = 64 * 1024 * 1024;
  for (const entry of Object.values(stored)) {
    entry.size = entry.uri === mountedUri ? limit - 2 : 2;
    entry.usedAt = entry.uri === idleUri ? 0 : 1;
  }
  platform.data.set("nodex.mobile.file-cache.v1", JSON.stringify(stored));
  const nativeSize = platform.files.size;
  platform.files.size = (uri) => {
    if (!platform.contents.has(uri)) return null;
    if (uri === mountedUri) return limit - 2;
    if (uri === idleUri) return 2;
    return nativeSize(uri);
  };
  const restarted = start(platform);
  await tick();
  const detach = restarted.files.get(saved.hostId, "nodex://files/mounted").attach();
  await expect(restarted.resolveFileUri("nodex://files/new")).rejects.toMatchObject({
    code: "invalid_result",
    retryable: false,
  });
  expect(platform.contents.has(mountedUri)).toBe(true);
  expect(platform.contents.has(idleUri)).toBe(false);
  detach();
  const uri = await restarted.resolveFileUri("nodex://files/new");
  expect(Array.from(platform.contents.get(uri) ?? [])).toEqual([1, 2, 3]);
  expect(platform.contents.has(mountedUri)).toBe(false);
});

it("recovers a pending pairing after returning to the foreground on the same phone key", async () => {
  const platform = fakePlatform();
  const host = new FakeHost();
  host.allowHello = false;
  platform.routes.set(route, host);
  const runtime = start(platform);
  const pending = expect(
    runtime.connection.pairWithUri(pairingUri(platform, host)),
  ).rejects.toMatchObject({ code: "unreachable" });
  await tick();
  expect(host.pairingKeys).toHaveLength(1);
  platform.setForeground(false);
  await tick();
  await pending;
  host.allowHello = true;
  platform.setForeground(true);
  await tick();
  expect(runtime.connection.state.getState().status).toBe("connected");
  expect(host.pairingKeys).toHaveLength(1);
  expect(runtime.connection.hosts.getState().hosts).toMatchObject([
    { hostId: host.id, deviceId: "device-1" },
  ]);
});

it("closes a transport immediately when its native send fails", async () => {
  const platform = fakePlatform();
  const host = new FakeHost();
  platform.routes.set(route, host);
  const socket = platform.socket;
  let failSend = false;
  platform.socket = (route) => {
    const native = socket(route);
    return {
      ...native,
      send(bytes) {
        if (failSend) throw new Error("Socket cannot send");
        native.send(bytes);
      },
    };
  };
  const runtime = start(platform);
  await runtime.connection.pairWithUri(pairingUri(platform, host));
  failSend = true;
  await expect(runtime.connection.rpc.request("projects.list", {})).rejects.toMatchObject({
    code: "disconnected",
    retryable: true,
  });
  await tick();
  expect(runtime.connection.state.getState().status).toBe("offline");
  expect(platform.dials[0]?.closed).toBe(true);
});
