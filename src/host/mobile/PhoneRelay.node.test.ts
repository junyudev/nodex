import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import type { CoreClient } from "../../main/core-client/core-client";
import { layer as shutdown } from "../../main/app/MainShutdown";
import type { PushTargets } from "./push-delivery";
import type { MobileHandlers, PushMethod } from "./rpc";
import { startPhoneRelay } from "./PhoneRelay";

it.effect("sends Hello before an observer can publish its first event", () =>
  Effect.gen(function* () {
    const opened = yield* Deferred.make<void>();
    const published: { t: string }[] = [];
    let polled = false;
    const client = {
      handshake: { library_id: "space" },
      pollPhone: () => {
        if (polled) return new Promise(() => {});
        polled = true;
        return Promise.resolve({
          kind: "open",
          channel_id: "channel",
          credential: "observation",
          space_id: "space",
          member_id: "Bob",
          device_id: "phone",
          space_name: "Team",
          space_kind: "team",
          routes: [],
        });
      },
      publishPhone: (input: { envelope: { t: string } }) => {
        published.push(input.envelope);
        return Promise.resolve(true);
      },
    } as unknown as CoreClient;
    yield* startPhoneRelay({
      client,
      lease: { token: "lease" },
      hostMetadata: { platform: "test", appVersion: "1" },
      rpc: {
        notify: () => Effect.void,
        open: (push) =>
          Effect.gen(function* () {
            yield* push("changed", { topics: ["inbox"] });
            yield* Deferred.succeed(opened, undefined);
            return { handlers: {} as Omit<MobileHandlers, PushMethod>, recover: () => Effect.void };
          }),
      },
    });
    yield* Deferred.await(opened);
    expect(published.map(({ t }) => t)).toEqual(["hello", "evt"]);
    expect(published[0]).toMatchObject({
      d: { spaceId: "space", spaceKind: "team", memberId: "Bob", deviceId: "phone" },
    });
  }).pipe(Effect.provide(shutdown)),
);

it.effect(
  "notifies the Devices Core names, skips one with a live channel, and names each enrollment",
  () =>
    Effect.gen(function* () {
      const targets = yield* Deferred.make<PushTargets>();
      const asked: unknown[] = [];
      const forgotten: unknown[] = [];
      const registration = (handle: string) => ({
        handle,
        key: "k".repeat(43),
        preferences: { needsYou: true, finished: true },
      });
      let polled = false;
      const client = {
        handshake: { library_id: "space" },
        pollPhone: () => {
          if (polled) return new Promise(() => {});
          polled = true;
          return Promise.resolve({
            kind: "open",
            channel_id: "channel",
            credential: "observation",
            space_id: "space",
            member_id: "alice",
            device_id: "alice-tablet",
            space_name: "Team",
            space_kind: "team",
            routes: [],
          });
        },
        publishPhone: () => Promise.resolve(true),
        phonePushRecipients: (input: unknown) => {
          asked.push(input);
          return Promise.resolve([
            { device_id: "alice-phone", member_id: "alice", registration: registration("phone") },
            { device_id: "alice-tablet", member_id: "alice", registration: registration("tablet") },
          ]);
        },
        forgetPhonePush: (input: unknown) => {
          forgotten.push(input);
          return Promise.resolve(true);
        },
        memberPresence: (input: { member_id: string; token: string }) =>
          input.token === "lease" && input.member_id === "alice"
            ? Promise.resolve({ idle_ms: 4_000 })
            : Promise.reject(new Error("unavailable")),
      } as unknown as CoreClient;
      const opened = yield* Deferred.make<void>();
      yield* startPhoneRelay({
        client,
        lease: { token: "lease" },
        hostMetadata: { platform: "test", appVersion: "1" },
        rpc: {
          notify: (received) => Deferred.succeed(targets, received).pipe(Effect.asVoid),
          open: () =>
            Deferred.succeed(opened, undefined).pipe(
              Effect.as({
                handlers: {} as Omit<MobileHandlers, PushMethod>,
                recover: () => Effect.void,
              }),
            ),
        },
      });
      const push = yield* Deferred.await(targets);
      yield* Deferred.await(opened);
      const recipients = yield* push.recipients("chat", {
        kind: "request",
        run_id: "run",
        request: "question",
      });
      expect(asked).toEqual([
        {
          token: "lease",
          session_id: "chat",
          audience: { kind: "request", run_id: "run", request: "question" },
        },
      ]);
      // The tablet is open on this Space, so only the phone is told, as the enrollment it knows.
      expect(recipients).toEqual([
        {
          deviceId: "alice-phone",
          memberId: "alice",
          hostId: JSON.stringify(["space", "alice"]),
          registration: registration("phone"),
        },
      ]);
      expect(yield* push.isCurrent(recipients[0]!)).toBe(true);
      expect(yield* push.isCurrent({ ...recipients[0]!, deviceId: "alice-tablet" })).toBe(false);
      yield* push.forget(recipients[0]!);
      expect(forgotten).toEqual([{ token: "lease", device_id: "alice-phone", handle: "phone" }]);
      // Core reads what Alice's desktops report under the Host's lease; a failed read is no one.
      expect(yield* push.presence("alice")).toBe(4_000);
      expect(yield* push.presence("bob")).toBeNull();
    }).pipe(Effect.provide(shutdown)),
);
