import type { MobileEvent, RpcError } from "@nodex/mobile-protocol";
import type { WebContents } from "electron";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HostInvocation, LocalCompanionInvocation } from "../../host/HostInvocation";
import { PhoneRequests, type PhoneRequestEntitlement } from "../../host/mobile/PhoneRequests";
import {
  MobileRpc,
  PhoneMember,
  internal,
  invokeMobileRpc,
  rpcError,
  unavailable,
  type PushMobileEvent,
} from "../../host/mobile/rpc";
import {
  MINI_COMPANION_EVENT_CHANNEL,
  type MiniCompanionEvent,
  type MiniCompanionMethod,
} from "../../shared/mini";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreRequestClass } from "../core-runtime/CoreRequestClass";
import { safeSendToWebContents } from "../ipc-safe-send";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";

const sessionUnavailable = () => unavailable("The Mini companion session is unavailable.");
const timedOut = () => unavailable("The Space Host is taking too long.");
const sessionFailure = (cause: Cause.Cause<RpcError>) =>
  Option.getOrElse(Cause.findErrorOption(cause), sessionUnavailable);

// The desktop's personal Space Owner may answer every pending request the
// shared companion contract can present. Core and the Runtime still bind the
// answer to the exact live request. Phone channels keep their Core filter.
const ownerRequests: PhoneRequestEntitlement = {
  filter: (_sessionId, requests) => Effect.succeed([...requests]),
};

export const makeMiniCompanion = Effect.gen(function* () {
  const core = yield* CoreModules;
  const { identity } = yield* CoreAuthority;
  const rpc = yield* MobileRpc;
  const owner = yield* Scope.Scope;
  const destruction = yield* WebContentsDestructionSubscriptions;
  const callbacks = yield* ScopedCallbackRuntime;
  const lane = yield* Semaphore.make(1);

  const open = Effect.fn("MiniCompanion.open")(function* (push: PushMobileEvent) {
    const result = yield* core.library
      .read({ kind: "local_member" })
      .pipe(
        Effect.mapError(sessionUnavailable),
        Effect.provideService(HostInvocation, null),
        Effect.provideService(CoreApplicationAgent, null),
      );
    if (
      result.value.kind !== "local_member" ||
      result.value.value.role !== "owner" ||
      result.value.value.lifecycle !== "active" ||
      result.value.value.library_id !== identity.libraryId
    )
      return yield* Effect.fail(rpcError("rejected", "Mini requires the personal Space Owner."));

    const local = Context.make(LocalCompanionInvocation, { memberId: result.value.value.id }).pipe(
      Context.add(HostInvocation, null),
      Context.add(PhoneMember, null),
      Context.add(CoreApplicationAgent, null),
      Context.add(PhoneRequests, ownerRequests),
    );
    const channel = yield* rpc
      .open(push)
      .pipe(Effect.provide(local), Effect.provideService(CoreRequestClass, "background"));
    const watches = yield* Semaphore.make(1);
    const invoke = (method: MiniCompanionMethod, params: unknown) => {
      const call = invokeMobileRpc(channel.handlers, method, params).pipe(
        Effect.flatMap((value) =>
          method === "chat.open"
            ? (value as Effect.Effect<unknown, RpcError>)
            : Effect.succeed(value),
        ),
        Effect.provide(local),
      );
      return method === "chat.open" || method === "chat.close" ? watches.withPermit(call) : call;
    };
    return { invoke };
  });

  type Session = {
    readonly scope: Scope.Closeable;
    readonly channel: Fiber.Fiber<Effect.Success<ReturnType<typeof open>>, RpcError>;
  };
  const sessions = new Map<WebContents, Session>();
  const ensure = Effect.fn("MiniCompanion.ensure")(function* (sender: WebContents) {
    return yield* lane.withPermit(
      Effect.gen(function* () {
        const existing = sessions.get(sender);
        if (existing) return existing;
        if (sender.isDestroyed()) return yield* Effect.fail(sessionUnavailable());

        const scope = yield* Scope.fork(owner);
        const push: PushMobileEvent = (event, data) =>
          Effect.sync(() => {
            if (sessions.get(sender)?.scope !== scope || !isMiniEvent(event)) return;
            const packet = { event, data } as MiniCompanionEvent;
            safeSendToWebContents(sender, MINI_COMPANION_EVENT_CHANNEL, [packet]);
          });
        const channel = yield* open(push).pipe(
          Effect.catchDefect(() => Effect.fail(internal())),
          Scope.provide(scope),
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () => Effect.fail(timedOut()),
          }),
          Effect.interruptible,
          Effect.forkIn(scope),
        );
        const session = { scope, channel };
        sessions.set(sender, session);
        const forget = () => {
          if (sessions.get(sender) !== session) return;
          sessions.delete(sender);
          callbacks.fork(Scope.close(scope, Exit.void));
        };
        const navigation = (details: Electron.WebContentsDidStartNavigationEventParams) => {
          if (details.isMainFrame && !details.isSameDocument) forget();
        };
        sender.on("did-start-navigation", navigation);
        sender.once("render-process-gone", forget);
        const unsubscribe = destruction.subscribe(sender, forget);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            if (sessions.get(sender) === session) sessions.delete(sender);
            unsubscribe();
            sender.removeListener("did-start-navigation", navigation);
            sender.removeListener("render-process-gone", forget);
          }),
        );
        return session;
      }).pipe(Effect.uninterruptible),
    );
  });

  const invoke = Effect.fn("MiniCompanion.invoke")(function* (
    sender: WebContents,
    method: MiniCompanionMethod,
    params: unknown,
  ) {
    const session = yield* ensure(sender);
    const opened = yield* Fiber.await(session.channel);
    if (Exit.isFailure(opened)) {
      yield* Scope.close(session.scope, Exit.void);
      return yield* Effect.fail(sessionFailure(opened.cause));
    }
    if (sessions.get(sender) !== session) return yield* Effect.fail(sessionUnavailable());
    const running = yield* opened.value.invoke(method, params).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(timedOut()),
      }),
      Effect.catchDefect(() => Effect.fail(internal())),
      Effect.forkIn(session.scope),
    );
    const answered = yield* Fiber.await(running);
    if (Exit.isSuccess(answered)) return answered.value;
    return yield* Effect.fail(sessionFailure(answered.cause));
  });

  return { ready: (sender: WebContents) => ensure(sender).pipe(Effect.ignore), invoke };
});

const isMiniEvent = (event: MobileEvent): event is MiniCompanionEvent["event"] =>
  event === "changed" ||
  event === "chat.activity" ||
  event === "chat.patch" ||
  event === "chat.snapshot";

export class MiniCompanion extends Context.Service<
  MiniCompanion,
  Effect.Success<typeof makeMiniCompanion>
>()("nodex/main/mini/MiniCompanion") {}

export const live = Layer.effect(MiniCompanion, makeMiniCompanion).pipe(
  Layer.provide(WebContentsDestructionSubscriptions.live),
);
