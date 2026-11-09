import {
  MOBILE_PROTOCOL_REVISION,
  PUSH_KEY_BYTES,
  decodePushKey,
  spaceMemberKey,
  type MobileEnvelope,
  type PushRegistration,
  type RpcError,
} from "@nodex/mobile-protocol";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { components } from "@nodex/core-protocol";
import type { CoreClient } from "../../main/core-client/core-client";
import { MainShutdown } from "../../main/app/MainShutdown";
import { CoreApplicationAgent } from "../../main/core-runtime/CoreApplicationAgent";
import { HostInvocation } from "../HostInvocation";
import { PhoneRequests, type PhoneRequestEntitlement } from "./PhoneRequests";
import type { PushRecipient } from "./push-delivery";
import {
  MobileRpc,
  internal,
  invalid,
  invokeMobileRpc,
  PhoneMember,
  requirePhoneInvocation,
  unavailable,
  type MobileHandlers,
  type MobileRpcChannel,
  type PushMethod,
} from "./rpc";

type Channel = {
  readonly deviceId: string;
  readonly scope: Scope.Closeable;
  readonly rpc: MobileRpcChannel;
  readonly entitlement: PhoneRequestEntitlement;
  readonly writer: Semaphore.Semaphore;
  readonly requests: Semaphore.Semaphore;
  readonly lifecycle: Semaphore.Semaphore;
  readonly send: (envelope: MobileEnvelope) => Effect.Effect<void>;
  readonly publish: (envelope: MobileEnvelope) => Effect.Effect<void>;
};

/** Core alone opens channels and issues invocation proofs. No network or phone JSON reaches this owner directly. */
export const startPhoneRelay = Effect.fn("PhoneRelay.start")(function* (input: {
  readonly client: CoreClient;
  readonly lease: components["schemas"]["HostLease"];
  readonly hostMetadata: { readonly platform: string; readonly appVersion: string };
  readonly rpc: MobileRpc["Service"];
  readonly onFailure?: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}) {
  const parent = yield* Scope.Scope;
  const shutdown = yield* MainShutdown;
  const channels = new Map<string, Channel>();
  const close = Effect.fn("PhoneRelay.close")(function* (id: string) {
    const channel = channels.get(id);
    channels.delete(id);
    if (channel) yield* Scope.close(channel.scope, Exit.void);
  });
  const space = input.client.handshake.library_id;
  const live = (deviceId: string) =>
    [...channels.values()].some((channel) => channel.deviceId === deviceId);
  // Core commits the phone's own request to its own Device; this relay chooses neither.
  const commitPush = Effect.gen(function* () {
    const credential = yield* requirePhoneInvocation;
    yield* Effect.tryPromise((signal) =>
      input.client.commitPhonePush({ credential }, { signal }),
    ).pipe(Effect.mapError(() => unavailable("This Space could not save notifications.")));
    return {};
  });
  const pushHandlers = {
    "push.register": (registration: PushRegistration) =>
      Effect.gen(function* () {
        const valid = yield* Effect.try({
          try: () => decodePushKey(registration.key).length === PUSH_KEY_BYTES,
          catch: () => invalid("The notification key is invalid."),
        });
        if (!valid) return yield* Effect.fail(invalid("The notification key is invalid."));
        return yield* commitPush;
      }),
    "push.unregister": () => commitPush,
  } satisfies Pick<MobileHandlers, PushMethod>;
  yield* input.rpc
    .notify({
      recipients: (sessionId, audience) =>
        Effect.tryPromise((signal) =>
          input.client.phonePushRecipients(
            { token: input.lease.token, session_id: sessionId, audience },
            { signal },
          ),
        ).pipe(
          Effect.map((recipients) =>
            recipients.flatMap(({ device_id, member_id, registration }): PushRecipient[] =>
              live(device_id)
                ? []
                : [
                    {
                      deviceId: device_id,
                      memberId: member_id,
                      hostId: spaceMemberKey(space, member_id),
                      registration,
                    },
                  ],
            ),
          ),
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed([]) }),
          Effect.orElseSucceed(() => []),
        ),
      presence: (memberId) =>
        Effect.tryPromise((signal) =>
          input.client.memberPresence(
            { token: input.lease.token, member_id: memberId },
            { signal },
          ),
        ).pipe(
          Effect.map(({ idle_ms }) => idle_ms ?? null),
          // A presence Core cannot answer for never silences a phone.
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(null) }),
          Effect.orElseSucceed(() => null),
        ),
      isCurrent: ({ deviceId }) => Effect.sync(() => !live(deviceId)),
      forget: ({ deviceId, registration }) =>
        Effect.tryPromise((signal) =>
          input.client.forgetPhonePush(
            { token: input.lease.token, device_id: deviceId, handle: registration.handle },
            { signal },
          ),
        ).pipe(Effect.ignore),
    })
    .pipe(Scope.provide(parent));
  const poll = Effect.gen(function* () {
    const event = yield* Effect.tryPromise((signal) =>
      input.client.pollPhone(input.lease, { signal }),
    );
    if (!event) return;
    const id = event.channel_id;
    if (event.kind === "close") return yield* close(id);
    if (event.kind === "open") {
      yield* close(id);
      const scope = yield* Scope.fork(parent);
      const writer = yield* Semaphore.make(1);
      const publish = (envelope: MobileEnvelope) =>
        Effect.tryPromise((signal) =>
          input.client.publishPhone(
            {
              ...input.lease,
              channel_id: id,
              envelope,
            },
            { signal },
          ),
        ).pipe(Effect.asVoid, Effect.ignore);
      const send = (envelope: MobileEnvelope) => writer.withPermit(publish(envelope));
      yield* send({
        t: "hello",
        d: {
          protocol: MOBILE_PROTOCOL_REVISION,
          host: {
            id: spaceMemberKey(event.space_id, event.member_id),
            name: event.space_name,
            ...input.hostMetadata,
          },
          spaceId: event.space_id,
          spaceKind: event.space_kind,
          memberId: event.member_id,
          deviceId: event.device_id,
          routes: [...event.routes],
        },
      });
      const entitlement: PhoneRequestEntitlement = {
        filter: (sessionId, requests) =>
          Effect.gen(function* () {
            if (!requests.length) return [];
            const proof = yield* HostInvocation;
            if (!proof) return [];
            const allowed = yield* Effect.tryPromise((signal) =>
              input.client.phoneResponseEntitlement(
                {
                  credential: proof,
                  session_id: sessionId,
                  requests: requests
                    .slice(0, 32)
                    .map(({ runId, requestId }) => ({ run_id: runId, request_id: requestId })),
                },
                { signal },
              ),
            ).pipe(Effect.orElseSucceed(() => []));
            const ids = new Set(allowed);
            return requests.filter((request) => ids.has(request.requestId));
          }),
      };
      const rpc = yield* input.rpc
        .open((k, d) => send({ t: "evt", k, d }))
        .pipe(
          Effect.provideService(PhoneRequests, entitlement),
          Effect.provideService(CoreApplicationAgent, null),
          Effect.provideService(HostInvocation, event.credential),
          Effect.provideService(PhoneMember, event.member_id),
          Scope.provide(scope),
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        );
      channels.set(id, {
        deviceId: event.device_id,
        scope,
        rpc,
        entitlement,
        writer,
        send,
        publish,
        requests: yield* Semaphore.make(4),
        lifecycle: yield* Semaphore.make(1),
      });
      return;
    }
    const channel = channels.get(id);
    if (!channel) return;
    const { id: requestId, method, params, credential } = event;
    const invoke = invokeMobileRpc(
      { ...channel.rpc.handlers, ...pushHandlers },
      method,
      params,
    ).pipe(
      Effect.provideService(PhoneRequests, channel.entitlement),
      Effect.provideService(CoreApplicationAgent, null),
      Effect.provideService(HostInvocation, credential),
      Effect.catchDefect(() => Effect.fail(internal())),
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(unavailable("The Space Host is taking too long.")),
      }),
    );
    const answer = invoke.pipe(
      Effect.flatMap((result) =>
        method === "chat.open"
          ? channel.writer.withPermit(
              (result as Effect.Effect<unknown, RpcError>).pipe(
                Effect.flatMap((value) =>
                  channel.publish({ t: "res", id: requestId, ok: true, r: value }),
                ),
              ),
            )
          : channel.send({ t: "res", id: requestId, ok: true, r: result }),
      ),
      Effect.catch((e) => channel.send({ t: "res", id: requestId, ok: false, e })),
      Effect.provideService(PhoneRequests, channel.entitlement),
      Effect.provideService(CoreApplicationAgent, null),
      Effect.provideService(HostInvocation, credential),
    );
    yield* (
      method === "chat.open" || method === "chat.close" ? channel.lifecycle : channel.requests
    )
      .withPermit(answer)
      .pipe(Effect.forkIn(channel.scope), Effect.asVoid);
  });
  yield* Effect.forever(poll).pipe(
    Effect.catchCause(
      input.onFailure ??
        ((cause) =>
          shutdown
            .request({ _tag: "RuntimeFatal", subsystem: "phone-relay", cause })
            .pipe(Effect.asVoid)),
    ),
    Effect.forkScoped,
  );
});
