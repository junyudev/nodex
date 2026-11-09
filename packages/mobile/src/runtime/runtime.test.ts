import {
  encodeDeviceLink,
  LIBRARY_INBOX,
  MOBILE_FILE_CHUNK_BYTES,
  MOBILE_MAX_MESSAGE_BYTES,
  MOBILE_UPLOAD_MAX_BYTES,
  MobileEnvelopeSchema,
  type ChatItem,
  type ChatPatchOp,
  type ChatSnapshot,
  type InboxEntry,
  type MobileMethod,
  type MobileParams,
} from "@nodex/mobile-protocol";
import * as Scheduler from "effect/Scheduler";
import * as Effect from "effect/Effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeHost, fakePlatform } from "./fake-host.test-support";
import type { LocalImage } from "./platform";
import { createMobileRuntime, type MobileRuntime } from "./runtime";

type Platform = ReturnType<typeof fakePlatform>;
const route = "https://host-a:3000/";
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
  return encodeDeviceLink(host.pairingOffer(platform.now() + 60_000, routes));
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

describe("Device enrollment and connection", () => {
  it("stores a Device credential privately before opening the Member stream", async () => {
    const { platform, host, runtime, saved } = await setup();
    expect(saved).toMatchObject({
      spaceId: host.id,
      spaceKind: "personal",
      memberId: "owner",
      hostId: JSON.stringify([host.id, "owner"]),
      deviceId: "device-1",
    });
    expect(runtime.connection.state.getState().status).toBe("connected");
    expect(host.httpRequests.map(({ path }) => path)).toEqual(["/enroll", "/session"]);
    expect(host.httpRequests[0]?.body).toMatchObject({
      form_factor: "phone",
      device_label: "Test phone",
    });
    const privateCatalog = JSON.parse(platform.savedSecrets.get("nodex.mobile.spaces.v1")!);
    expect(privateCatalog.hosts[0].spaceKind).toBe("personal");
    expect(privateCatalog.credentials[saved.hostId]).toMatch(/^[a-f0-9]{64}$/u);
    expect(platform.data.size).toBe(0);
    const upgrade = platform.starts.find(({ socket }) => socket)!;
    expect(upgrade.options.url).toBe("wss://host-a:3000/core/v1/phone");
    expect(upgrade.options.headers.Authorization).toMatch(/^Bearer [a-f0-9]{64}$/u);
  });

  it("learns Space kind from the first hello and refreshes it on reconnect", async () => {
    const platform = fakePlatform();
    const host = new FakeHost();
    host.spaceKind = "team";
    platform.routes.set(route, host);
    const runtime = start(platform);
    const pair = runtime.connection.pairWithUri(pairingUri(platform, host));
    await tick();
    const saved = await pair;
    expect(saved.spaceKind).toBe("team");
    expect(runtime.connection.hosts.getState().hosts[0]?.spaceKind).toBe("team");

    await runtime.dispose();
    const restored = start(platform);
    expect(restored.connection.hosts.getState().hosts[0]?.spaceKind).toBe("team");
    await tick();
    expect(restored.connection.state.getState().status).toBe("connected");
  });

  it("persists a personal Space becoming a team on the next hello", async () => {
    const { platform, host, runtime } = await setup();
    expect(runtime.connection.hosts.getState().hosts[0]?.spaceKind).toBe("personal");
    host.spaceKind = "team";
    runtime.connection.reconnectNow();
    await tick();
    expect(runtime.connection.state.getState().hello?.spaceKind).toBe("team");
    expect(runtime.connection.hosts.getState().hosts[0]?.spaceKind).toBe("team");
    const catalog = JSON.parse(platform.savedSecrets.get("nodex.mobile.spaces.v1")!);
    expect(catalog.hosts[0].spaceKind).toBe("team");
  });

  it("keeps locked credentials closed without sending or overwriting enrollment", async () => {
    const { platform, host, runtime } = await setup();
    await runtime.dispose();
    const saved = [...platform.savedSecrets];
    const read = platform.secrets.get;
    platform.secrets.get = () => {
      throw new Error("Keychain locked");
    };
    const locked = start(platform);
    expect(locked.connection.state.getState().status).toBe("unavailable");
    host.pairingAvailable = true;
    await expect(locked.connection.pairWithUri(pairingUri(platform, host))).rejects.toMatchObject({
      code: "locked",
    });
    expect([...platform.savedSecrets]).toEqual(saved);
    expect(host.httpRequests.filter(({ path }) => path === "/enroll")).toHaveLength(1);
    platform.secrets.get = read;
    locked.connection.reconnectNow();
    await tick();
    expect(locked.connection.state.getState().status).toBe("connected");
  });

  it("rejects invalid, expired and already consumed links without replacing an enrollment", async () => {
    const { platform, host, runtime, saved } = await setup();
    await expect(runtime.connection.pairWithUri("nodex-mobile://pair#bad")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      runtime.connection.pairWithUri(encodeDeviceLink(host.pairingOffer(platform.now()))),
    ).rejects.toMatchObject({ code: "expired" });
    await expect(runtime.connection.pairWithUri(pairingUri(platform, host))).rejects.toMatchObject({
      code: "rejected",
    });
    expect(runtime.connection.hosts.getState().hosts).toEqual([saved]);
    expect(host.credentials.size).toBe(1);
  });

  it("rejects the wrong certificate before enrollment application bytes", async () => {
    const platform = fakePlatform();
    const expected = new FakeHost();
    const other = new FakeHost("other");
    platform.routes.set(route, other);
    const runtime = start(platform);
    await expect(
      runtime.connection.pairWithUri(pairingUri(platform, expected)),
    ).rejects.toMatchObject({ code: "pin" });
    expect(other.httpRequests).toEqual([]);
    expect(runtime.connection.hosts.getState().hosts).toEqual([]);
    expect(platform.savedSecrets.size).toBe(0);
  });

  describe("a tailnet address", () => {
    const tailnet = "https://100.100.228.24:8471/";
    const lan = "https://192.168.31.103:8471/";

    it("links and connects with the host's own pinned certificate alone", async () => {
      const platform = fakePlatform();
      const host = new FakeHost("host-a", [tailnet]);
      platform.routes.set(tailnet, host);
      const runtime = start(platform);
      const pair = runtime.connection.pairWithUri(pairingUri(platform, host));
      await tick();
      await expect(pair).resolves.toMatchObject({ lastConnectedRoute: tailnet });
      expect(runtime.connection.state.getState().status).toBe("connected");
      expect(platform.dials.at(-1)?.route).toBe(tailnet);
    });

    it("is tried after the local address, whatever order the host lists them in", async () => {
      const platform = fakePlatform();
      const host = new FakeHost("host-a", [tailnet, lan]);
      platform.routes.set(tailnet, host);
      platform.routes.set(lan, host);
      const runtime = start(platform);
      const pair = runtime.connection.pairWithUri(pairingUri(platform, host));
      await tick();
      await expect(pair).resolves.toMatchObject({ lastConnectedRoute: lan });
      expect(new URL(platform.starts[0]!.options.url).origin).toBe(new URL(lan).origin);
    });

    it("reaches the host when the local address does not", async () => {
      const platform = fakePlatform();
      const host = new FakeHost("host-a", [lan, tailnet]);
      platform.routes.set(lan, "unreachable");
      platform.routes.set(tailnet, host);
      const runtime = start(platform);
      const pair = runtime.connection.pairWithUri(pairingUri(platform, host));
      await tick(1_000);
      await expect(pair).resolves.toMatchObject({ lastConnectedRoute: tailnet });
      expect(runtime.connection.state.getState().status).toBe("connected");
    });
  });

  it("renews the Device session before expiry and after Core requests renewal", async () => {
    const { host, runtime } = await setup();
    runtime.connection.reconnectNow();
    await tick();
    expect(host.httpRequests.filter(({ path }) => path === "/session")).toHaveLength(1);
    await tick(3_540_000);
    expect(host.httpRequests.filter(({ path }) => path === "/session")).toHaveLength(2);
    expect(runtime.connection.state.getState().status).toBe("connected");
    host.closeAll(4401);
    await tick(1_000);
    expect(host.httpRequests.filter(({ path }) => path === "/session")).toHaveLength(3);
    expect(runtime.connection.state.getState().status).toBe("connected");
  });

  it.each([
    [2, "stall"],
    [3, "stall"],
    [2, "unreachable"],
  ] as const)("renews once while %i saved routes are %s", async (stalls, failure) => {
    const platform = fakePlatform();
    const routes = [
      route,
      "https://host-b:3000/",
      "https://host-c:3000/",
      "https://host-d:3000/",
    ].slice(0, stalls + 1);
    const host = new FakeHost("host-a", routes);
    for (const savedRoute of routes) platform.routes.set(savedRoute, host);
    const original = start(platform);
    const enrollment = original.connection.pairWithUri(pairingUri(platform, host));
    await tick();
    await enrollment;
    await original.dispose();
    for (const savedRoute of routes.slice(0, stalls)) platform.routes.set(savedRoute, failure);
    const request = platform.pinnedTls.request;
    platform.pinnedTls.request = (options) =>
      failure === "stall" &&
      options.url.startsWith(routes.at(-1)!) &&
      options.url.endsWith("/session")
        ? Effect.sleep(1_000).pipe(Effect.flatMap(() => request(options)))
        : request(options);
    const restored = start(platform);
    await tick(3_000);
    expect(restored.connection.state.getState().status).toBe("connected");
    expect(host.httpRequests.filter(({ path }) => path === "/session")).toHaveLength(2);
    expect(platform.dials.at(-1)?.route).toBe(routes.at(-1));
    await tick(60_000);
    expect(restored.connection.state.getState().status).toBe("connected");
  });

  it("uses credential renewal to prove access withdrawal and retains readable caches", async () => {
    const { platform, host, runtime, saved } = await setup();
    host.revoked = true;
    host.closeAll(4401);
    await tick(1_000);
    expect(runtime.connection.state.getState()).toMatchObject({ status: "revoked", hello: null });
    expect(runtime.connection.hosts.getState().hosts).toEqual([saved]);
    const requests = host.httpRequests.length;
    await tick(60_000);
    expect(host.httpRequests).toHaveLength(requests);
    expect(platform.savedSecrets.has("nodex.mobile.spaces.v1")).toBe(true);
  });

  it("shows access revoked as soon as the host refuses renewal on any address", async () => {
    const platform = fakePlatform();
    const routes = [route, "https://host-b:3000/"];
    const host = new FakeHost("host-a", routes);
    for (const savedRoute of routes) platform.routes.set(savedRoute, host);
    const runtime = start(platform);
    const enrollment = runtime.connection.pairWithUri(pairingUri(platform, host));
    await tick();
    await enrollment;
    // The other address never answers, as an unreachable tailnet route does.
    platform.routes.set(routes[1]!, "stall");
    const seen: string[] = [];
    const stop = runtime.connection.state.subscribe(({ status }) => seen.push(status));
    host.revoked = true;
    host.closeAll(4401);
    await tick(300);
    stop();
    expect(runtime.connection.state.getState()).toMatchObject({ status: "revoked" });
    expect(seen).not.toContain("offline");
  });

  it("keeps offline state steady across backoff and reconnects on foreground", async () => {
    const { platform, host, runtime } = await setup();
    const seen: string[] = [];
    const stop = runtime.connection.state.subscribe(({ status }) => seen.push(status));
    platform.routes.set(route, "unreachable");
    host.closeAll();
    await tick(10_000);
    expect(runtime.connection.state.getState().status).toBe("offline");
    platform.setForeground(false);
    platform.routes.set(route, host);
    await tick(30_000);
    platform.setForeground(true);
    await tick();
    stop();
    expect(runtime.connection.state.getState().status).toBe("connected");
    expect(new Set(seen)).toEqual(new Set(["offline", "connected"]));
  });

  it("isolates capture delivery and cached Inbox by Space and Member", async () => {
    const { platform, host, runtime, saved } = await setup();
    const defaultRead = host.onRequest;
    host.onRequest = (_request, reply) =>
      reply({ items: [inboxMessage("owner-entry")], nextCursor: null });
    const ownerList = runtime.lists.inbox(saved.hostId, LIBRARY_INBOX, "inbox");
    const detach = ownerList.attach();
    await tick();
    expect(ownerList.store.getState().items.map(({ id }) => id)).toEqual(["owner-entry"]);
    detach();
    host.onRequest = defaultRead;
    platform.setForeground(false);
    await tick();
    const captureId = runtime.outbox.captureToInbox({
      scope: LIBRARY_INBOX,
      text: "Owner only",
      images: [],
    });
    const ownerCredential = [...host.credentials.entries()][0]!;
    host.credentials.delete(ownerCredential[0]);
    host.tokens.clear();
    host.memberId = "bob";
    host.pairingAvailable = true;
    platform.setForeground(true);
    await tick();
    const enrolled = runtime.connection.pairWithUri(pairingUri(platform, host));
    await tick();
    const bob = await enrolled;
    expect(bob.hostId).not.toBe(saved.hostId);
    expect(bob.memberId).toBe("bob");
    expect(host.admissions.filter(({ request }) => request.m === "inbox.capture")).toEqual([]);
    expect(
      runtime.outbox.store.getState().find((entry) => entry.capture.captureId === captureId)
        ?.hostId,
    ).toBe(saved.hostId);
    const bobList = runtime.lists.inbox(bob.hostId, LIBRARY_INBOX, "inbox");
    expect(bobList.store.getState().items).toEqual([]);
    expect(runtime.connection.hosts.getState().hosts).toHaveLength(2);
    host.credentials.set(...ownerCredential);
    runtime.connection.activateHost(saved.hostId);
    host.onRequest = (request, reply, fail) =>
      request.m === "inbox.message"
        ? fail("Not here", false, "not_found")
        : reply({ pageId: (request.p as { pageId: string }).pageId });
    await tick();
    expect(params(host, "inbox.capture")).toHaveLength(1);
    expect(
      host.admissions
        .filter(({ request }) => request.m === "inbox.capture")
        .map(({ memberId }) => memberId),
    ).toEqual([saved.memberId]);
  });

  it("retains unassigned captures across transport replacement without delivering them", async () => {
    const { platform, host, runtime, saved } = await setup();
    platform.setForeground(false);
    await tick();
    const captureId = runtime.outbox.captureToInbox({
      scope: LIBRARY_INBOX,
      text: "Retained before enrollment",
      images: [],
    });
    const stored = runtime.outbox.store
      .getState()
      .map((entry) => ({ ...entry, hostId: "old-static-host" }));
    platform.data.set("nodex.mobile.outbox.v1", JSON.stringify(stored));
    await runtime.dispose();
    const relaunched = start(platform);
    platform.setForeground(true);
    await tick();
    expect(relaunched.connection.activeHostId()).toBe(saved.hostId);
    expect(relaunched.outbox.store.getState()).toMatchObject([
      { hostId: "old-static-host", capture: { captureId, text: "Retained before enrollment" } },
    ]);
    expect(params(host, "inbox.capture")).toHaveLength(0);
  });

  it("removes just one local Space enrollment without revoking another", async () => {
    const { platform, host, runtime, saved } = await setup();
    const other = new FakeHost("team", ["https://team:3000/"]);
    platform.routes.set(other.routes[0]!, other);
    const enrolled = runtime.connection.pairWithUri(pairingUri(platform, other));
    await tick();
    const team = await enrolled;
    await runtime.forgetHost(saved.hostId);
    expect(runtime.connection.hosts.getState().hosts).toEqual([team]);
    expect(host.revoked).toBe(false);
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

function inboxMessage(pageId: string): InboxEntry {
  return {
    id: pageId,
    rowKind: "intake",
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
  it("keeps an oversized capture as a failed local item instead of retrying its transport", async () => {
    const { host, runtime } = await setup();
    const captureId = runtime.outbox.captureToInbox({
      scope: LIBRARY_INBOX,
      text: "é".repeat(MOBILE_MAX_MESSAGE_BYTES),
      images: [],
    });
    await tick();
    expect(
      runtime.outbox.store.getState().find((entry) => entry.capture.captureId === captureId)
        ?.capture,
    ).toMatchObject({
      state: "failed",
      error: "This request is too large or has invalid details.",
    });
    expect(params(host, "inbox.capture")).toHaveLength(0);
    expect(runtime.connection.state.getState().status).toBe("connected");
    await tick(60_000);
    expect(params(host, "inbox.capture")).toHaveLength(0);
  });

  it("shows every Project's pending capture in Library Home without changing its destination", async () => {
    const { platform, runtime, saved } = await setup();
    platform.setForeground(false);
    await tick();
    runtime.outbox.captureToInbox({
      scope: { kind: "project", projectId: "project" },
      text: "Project capture",
      images: [],
    });
    runtime.outbox.captureToInbox({ scope: { kind: "all" }, text: "Unscoped capture", images: [] });
    await tick();
    expect(
      runtime.outbox
        .visiblePending(saved.hostId, { kind: "all" }, new Set())
        .map((capture) => capture.text),
    ).toEqual(["Project capture", "Unscoped capture"]);
    expect(
      runtime.outbox
        .visiblePending(saved.hostId, { kind: "project", projectId: "project" }, new Set())
        .map((capture) => capture.text),
    ).toEqual(["Project capture"]);
  });

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
    const accepted = new Map<string, InboxEntry>();
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
        const { entryId: pageId } = request.p as MobileParams<"inbox.message">;
        if (pageId === landed) reply(inboxMessage(pageId));
        else fail("Inbox message is unavailable", false, "not_found");
      } else reply({ items: [], nextCursor: null });
    };
    runtime.outbox.captureToInbox({ scope: LIBRARY_INBOX, text: "Landed", images: [image] });
    await tick();
    expect(params(host, "inbox.capture")).toHaveLength(1);
    await tick(1_000);
    expect(params(host, "inbox.message")).toEqual([{ entryId: landed }]);
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
      const messages = new Map<string, InboxEntry>();
      let first = true;
      host.onRequest = (request, reply, fail) => {
        if (request.m === "inbox.message") {
          const { entryId: pageId } = request.p as MobileParams<"inbox.message">;
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
    let message: InboxEntry | null = null;
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
      const ids = new Set(list.store.getState().items.map((item) => item.id));
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
  unavailableImages: [],
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
      stopBlockedReason: null,
      archived: false,
      canManage: true,
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

it("lists archived chats apart and brings a restored one back to the rest", async () => {
  const { host, runtime, saved } = await setup();
  const summary = (sessionId: string, archived: boolean, canManage: boolean) => ({
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
    archived,
    activityAt: null,
    canSend: !archived,
    canManage,
  });
  // Alice archived her chat and Bob's; only her own is hers to restore.
  const archived = new Set(["alice-old", "bob-old"]);
  const chats = () => [
    summary("alice-old", archived.has("alice-old"), true),
    summary("bob-old", archived.has("bob-old"), false),
    summary("current", false, true),
  ];
  host.onRequest = (request, reply) => {
    if (request.m === "chat.setArchived") {
      const { sessionId, archived: next } = request.p as { sessionId: string; archived: boolean };
      if (next) archived.add(sessionId);
      else archived.delete(sessionId);
      reply({});
      return;
    }
    const wanted = (request.p as { archived?: boolean }).archived === true;
    reply({ items: chats().filter((chat) => chat.archived === wanted), nextCursor: null });
  };
  const recent = runtime.lists.chats(saved.hostId, {});
  const archive = runtime.lists.chats(saved.hostId, { archived: true });
  const detachRecent = recent.attach();
  const detachArchive = archive.attach();
  await tick();
  expect(params(host, "chats.list").map(({ archived }) => archived ?? false)).toEqual([
    false,
    true,
  ]);
  const shown = (list: typeof recent) =>
    list.store.getState().items.map(({ sessionId, canManage }) => [sessionId, canManage]);
  expect(shown(recent)).toEqual([["current", true]]);
  expect(shown(archive)).toEqual([
    ["alice-old", true],
    ["bob-old", false],
  ]);

  await runtime.setChatArchived("alice-old", false);
  await tick(60);
  expect(params(host, "chat.setArchived")).toEqual([{ sessionId: "alice-old", archived: false }]);
  expect(shown(recent)).toEqual([
    ["alice-old", true],
    ["current", true],
  ]);
  expect(shown(archive)).toEqual([["bob-old", false]]);
  detachRecent();
  detachArchive();
});

it("refuses an oversized prepared-image batch before opening any upload", async () => {
  const { platform, host, runtime } = await setup();
  const images = ["one", "two"].map((name) => ({
    uri: `file://picker/${name}.jpg`,
    name: `${name}.jpg`,
    mimeType: "image/jpeg",
    width: 4000,
    height: 2500,
  }));
  for (const image of images) platform.contents.set(image.uri, Uint8Array.of(1));
  const readSize = platform.files.size;
  platform.files.size = (uri) =>
    uri.startsWith("file://cache/compressed-") ? MOBILE_UPLOAD_MAX_BYTES / 2 + 1 : readSize(uri);
  const refused = expect(
    runtime.startChat({
      text: "Large batch",
      images,
      projectId: null,
      agent: null,
      location: "local",
    }),
  ).rejects.toMatchObject({
    code: "invalid_params",
    retryable: false,
    message: "These images are too large to send together.",
  });
  await tick();
  await refused;
  expect(params(host, "files.upload.begin")).toHaveLength(0);
  expect(params(host, "chats.start")).toHaveLength(0);
  expect(runtime.connection.state.getState().status).toBe("connected");
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

it("interrupts a pending enrollment and leaves no runtime timers after disposal", async () => {
  const platform = fakePlatform();
  const host = new FakeHost();
  platform.routes.set(route, "stall");
  const runtime = start(platform);
  const pending = expect(
    runtime.connection.pairWithUri(pairingUri(platform, host)),
  ).rejects.toMatchObject({ code: "unreachable" });
  await tick();
  await runtime.dispose();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
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

it("recovers from bounded socket ingress overflow without losing Device credentials", async () => {
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
