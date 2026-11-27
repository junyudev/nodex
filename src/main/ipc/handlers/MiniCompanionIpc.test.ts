import type { ChatRequest } from "@nodex/mobile-protocol";
import { it } from "@effect/vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EventEmitter } from "node:events";
import { expect } from "vite-plus/test";
import { HostInvocation, LocalCompanionInvocation } from "../../../host/HostInvocation";
import { PhoneRequests } from "../../../host/mobile/PhoneRequests";
import {
  MobileRpc,
  PhoneMember,
  requireCompanionInvocation,
  requirePhoneInvocation,
  type MobileRpcChannel,
  type PushMobileEvent,
} from "../../../host/mobile/rpc";
import { MINI_COMPANION_EVENT_CHANNEL } from "../../../shared/mini";
import { layer as callbacks } from "../../app/ScopedCallbackRuntime";
import { CoreAuthority } from "../../core-runtime/CoreAuthority";
import { CoreModules } from "../../core-runtime/CoreModules";
import { live as companionLive, MiniCompanion } from "../../mini/MiniCompanion";
import { makeInvoke } from "./MiniCompanionIpc";

const pending = {
  kind: "approval",
  runId: "run",
  requestId: "request",
  title: "Run a command?",
  detail: null,
  options: [],
} satisfies ChatRequest;
const inboxWindow = { scope: { kind: "all" }, filter: "inbox" };
const appUrl = "app://-/index.html?initialRoute=%2Fmini";

it.effect("binds a single Mini document to its personal Owner and revokes it on reload", () =>
  Effect.gen(function* () {
    const retired = yield* Deferred.make<void>();
    const sent: unknown[][] = [];
    const nativeSender = Object.assign(new EventEmitter(), {
      id: 1,
      mainFrame: { url: appUrl },
      getType: () => "window",
      isDestroyed: () => false,
      send: (...args: unknown[]) => sent.push(args),
    });
    const sender = nativeSender as unknown as WebContents;
    const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
    const rpcSessions: PushMobileEvent[] = [];
    const core = Layer.succeed(CoreModules, {
      library: {
        read: (input: unknown) =>
          Effect.gen(function* () {
            expect(input).toEqual({ kind: "local_member" });
            expect(yield* HostInvocation).toBeNull();
            return {
              value: {
                kind: "local_member",
                value: { id: "owner", library_id: "personal", role: "owner", lifecycle: "active" },
              },
            };
          }),
      },
    } as unknown as CoreModules["Service"]);
    const authority = Layer.succeed(CoreAuthority, {
      identity: { libraryId: "personal" },
    } as CoreAuthority["Service"]);
    const rpc = Layer.succeed(MobileRpc, {
      notify: () => Effect.die("Mini must never set up push notifications"),
      open: (push) =>
        Effect.gen(function* () {
          yield* requireCompanionInvocation;
          expect(yield* LocalCompanionInvocation).toEqual({ memberId: "owner" });
          expect(yield* PhoneMember).toBeNull();
          expect((yield* Effect.result(requirePhoneInvocation))._tag).toBe("Failure");
          rpcSessions.push(push);
          yield* Effect.addFinalizer(() => Deferred.succeed(retired, undefined));
          const handlers: Pick<MobileRpcChannel["handlers"], "inbox.window" | "chat.respond"> = {
            "inbox.window": () => Effect.succeed({ items: [], nextCursor: null }),
            "chat.respond": ({ sessionId }) =>
              Effect.gen(function* () {
                expect(yield* LocalCompanionInvocation).toEqual({ memberId: "owner" });
                const requests = yield* PhoneRequests;
                expect(yield* requests.filter(sessionId, [pending])).toEqual([pending]);
                return {};
              }),
          };
          return {
            recover: () => Effect.void,
            handlers: handlers as unknown as MobileRpcChannel["handlers"],
          };
        }),
    });
    const layers = companionLive.pipe(
      Layer.provide(Layer.mergeAll(core, authority, rpc, callbacks)),
    );
    yield* Effect.gen(function* () {
      const companion = yield* MiniCompanion;
      let role: string = "mini";
      const invoke = makeInvoke(
        { hasAuxiliaryRole: (id, requested) => id === sender.id && requested === role },
        null,
        companion,
      );

      const unknown = yield* invoke(event, "push.register", {});
      expect(unknown).toMatchObject({ ok: false, error: { code: "unknown_method" } });

      const foreign = { ...event, senderFrame: { url: appUrl } } as IpcMainInvokeEvent;
      expect(yield* invoke(foreign, "inbox.window", inboxWindow)).toMatchObject({
        ok: false,
        error: { code: "rejected" },
      });
      role = "workbench";
      expect(yield* invoke(event, "inbox.window", inboxWindow)).toMatchObject({
        ok: false,
        error: { code: "rejected" },
      });
      expect(rpcSessions).toHaveLength(0);

      role = "capture";
      yield* companion.ready(sender);
      yield* companion.ready(sender);
      expect(yield* invoke(event, "inbox.window", null)).toMatchObject({
        ok: false,
        error: { code: "invalid_params" },
      });
      expect(yield* invoke(event, "inbox.window", inboxWindow)).toEqual({
        ok: true,
        value: { items: [], nextCursor: null },
      });
      expect(
        yield* invoke(event, "chat.respond", {
          sessionId: "chat",
          requestId: pending.requestId,
          runId: pending.runId,
          submissionId: "answer",
          response: { kind: "option", optionId: "once", feedback: null },
        }),
      ).toEqual({ ok: true, value: {} });
      expect(rpcSessions).toHaveLength(1);
      yield* rpcSessions[0]!("changed", { topics: ["chats"] });
      expect(sent).toEqual([
        [MINI_COMPANION_EVENT_CHANNEL, { event: "changed", data: { topics: ["chats"] } }],
      ]);

      nativeSender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      yield* Deferred.await(retired);
      yield* rpcSessions[0]!("changed", { topics: ["chats"] });
      expect(sent).toHaveLength(1);
      role = "mini";
      yield* companion.ready(sender);
      expect(yield* invoke(event, "inbox.window", inboxWindow)).toMatchObject({ ok: true });
      expect(rpcSessions).toHaveLength(2);
    }).pipe(Effect.provide(layers));
  }),
);
