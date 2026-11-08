import { encodePushKey, PUSH_KEY_BYTES, type PushPreferences } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { Connection } from "./connection";
import { Platform, PlatformFailure, type MobilePush, type PushPermission } from "./platform";
import { createProjection } from "./projection";
import { readStored } from "./storage";

const PREFERENCES_KEY = "nodex.mobile.notifications.preferences.v1";
const HANDLE_KEY = "nodex.mobile.notifications.handle.v1";
const OFFER_KEY = "nodex.mobile.notifications.offer-dismissed.v1";

const OFF: PushPreferences = { needsYou: false, finished: false };
const ON: PushPreferences = { needsYou: true, finished: true };

const wantsAny = ({ needsYou, finished }: PushPreferences): boolean => needsYou || finished;

/** Why notifications that are on can't arrive yet, so it never fails out of sight. */
export type NotificationProblem = "no-address" | "relay" | "desktop";

export interface NotificationState {
  /** Whether this phone can receive notifications from a desktop at all. */
  readonly available: boolean;
  readonly permission: PushPermission;
  readonly preferences: PushPreferences;
  /** The person has answered, or set aside, the one time a chat offers these. */
  readonly offerDismissed: boolean;
  /** Null when the desktop knows where to reach this phone, or nothing is wanted. */
  readonly problem: NotificationProblem | null;
}

type SavedHandle = {
  readonly token: string;
  readonly environment: string;
  readonly handle: string;
};

/**
 * What this phone wants to be told, and telling the active desktop. The desktop hears again on each
 * connection, because the system can change a phone's address at any time. A failure here costs a
 * notification, not anything the person is doing, so it waits for the next connection.
 */
export const makeNotifications = Effect.gen(function* () {
  const platform = yield* Platform;
  const connection = yield* Connection;
  const { push } = platform;
  const state = createProjection<NotificationState>({
    available: push !== null,
    permission: "undetermined",
    preferences: readStored(platform.storage, PREFERENCES_KEY, OFF),
    offerDismissed: readStored(platform.storage, OFFER_KEY, false),
    problem: null,
  });

  const attempt = <T>(run: () => Promise<T>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new PlatformFailure({ cause }) });

  const handleFor = Effect.fn("MobileNotifications.handleFor")(function* (
    capability: MobilePush,
    address: NonNullable<Awaited<ReturnType<MobilePush["address"]>>>,
  ) {
    const saved = readStored<SavedHandle | null>(platform.storage, HANDLE_KEY, null);
    if (saved?.token === address.token && saved.environment === address.environment) {
      return saved.handle;
    }
    const handle = yield* attempt(() =>
      capability.registerAddress({ ...address, bundleId: capability.bundleId }),
    );
    platform.storage.set(HANDLE_KEY, JSON.stringify({ ...address, handle }));
    return handle;
  });

  const keyFor = Effect.fn("MobileNotifications.keyFor")(function* (capability: MobilePush) {
    const existing = capability.readKey();
    if (existing) return existing;
    const key = encodePushKey(platform.randomBytes(PUSH_KEY_BYTES));
    yield* attempt(() => capability.writeKey(key));
    return key;
  });

  const tellDesktop = Effect.gen(function* () {
    const { preferences } = state.getState();
    if (!push || !wantsAny(preferences) || !connection.activeLink()) return;
    const permission = yield* attempt(() => push.permission());
    state.setState({ permission });
    if (permission !== "granted") return;
    const address = yield* attempt(() => push.address()).pipe(Effect.orElseSucceed(() => null));
    if (!address) {
      state.setState({ problem: "no-address" });
      return;
    }
    const handle = yield* handleFor(push, address).pipe(
      Effect.tapError(() => Effect.sync(() => state.setState({ problem: "relay" }))),
    );
    const key = yield* keyFor(push);
    yield* connection.rpc
      .request("push.register", { handle, key, preferences })
      .pipe(Effect.tapError(() => Effect.sync(() => state.setState({ problem: "desktop" }))));
    state.setState({ problem: null });
  }).pipe(Effect.ignore);

  const stopTellingDesktop = Effect.suspend(() =>
    connection.activeLink() ? connection.rpc.request("push.unregister", {}) : Effect.void,
  ).pipe(Effect.ignore);

  const refreshPermission = Effect.gen(function* () {
    if (!push) return;
    const permission = yield* attempt(() => push.permission());
    state.setState({ permission });
  }).pipe(Effect.ignore);

  const store = (preferences: PushPreferences) => {
    platform.storage.set(PREFERENCES_KEY, JSON.stringify(preferences));
    state.setState({ preferences });
  };

  const dismissOffer = Effect.sync(() => {
    platform.storage.set(OFFER_KEY, JSON.stringify(true));
    state.setState({ offerDismissed: true });
  });

  /**
   * A chat read on the desktop, archived or otherwise gone from the chat list needs no notification
   * any more. Only this desktop's notifications are its to judge, a hundred chats at a time. A desktop
   * that cannot answer leaves them in place.
   */
  const tidyDelivered = Effect.gen(function* () {
    const link = connection.activeLink();
    if (!push || !link) return;
    const hostId = link.hello.host.id;
    const delivered = yield* attempt(() => push.delivered());
    const sessionIds = [
      ...new Set(delivered.filter((chat) => chat.hostId === hostId).map((chat) => chat.sessionId)),
    ].slice(0, 100);
    if (sessionIds.length === 0) return;
    const { sessionIds: unread } = yield* connection.rpc.request("chats.unread", { sessionIds });
    const stillUnread = new Set(unread);
    yield* Effect.forEach(
      sessionIds.filter((sessionId) => !stillUnread.has(sessionId)),
      (sessionId) => attempt(() => push.clearDelivered(sessionId)),
      { discard: true },
    );
  }).pipe(Effect.ignore);

  // The runtime is built synchronously, so what the system answers arrives after it.
  yield* refreshPermission.pipe(Effect.forkScoped({ startImmediately: true }));
  yield* connection.state.changes.pipe(
    Stream.runForEach(({ status }) =>
      status === "connected" ? refreshPermission.pipe(Effect.andThen(tellDesktop)) : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  yield* Stream.merge(
    connection.state.changes.pipe(Stream.filter(({ status }) => status === "connected")),
    connection.rpc.events("changed").pipe(Stream.filter(({ topics }) => topics.includes("chats"))),
  ).pipe(
    Stream.debounce("250 millis"),
    Stream.runForEach(() => tidyDelivered),
    Effect.forkScoped({ startImmediately: true }),
  );

  return {
    state,
    /** Asks the system, then turns on everything; the person narrows it in Settings. */
    enable: Effect.gen(function* () {
      yield* dismissOffer;
      if (!push) return;
      const permission = yield* attempt(() => push.requestPermission());
      state.setState({ permission });
      if (permission !== "granted") return;
      store(ON);
      yield* tellDesktop;
    }).pipe(Effect.ignore),
    setPreferences: (patch: Partial<PushPreferences>) =>
      Effect.gen(function* () {
        const preferences = { ...state.getState().preferences, ...patch };
        store(preferences);
        if (wantsAny(preferences)) return yield* tellDesktop;
        state.setState({ problem: null });
        yield* stopTellingDesktop;
      }),
    dismissOffer,
    retry: tellDesktop,
    /** Forgetting a desktop should also stop it, while it can still be told. */
    stopTellingDesktop,
    clearDelivered: (sessionId: string) =>
      push ? attempt(() => push.clearDelivered(sessionId)).pipe(Effect.ignore) : Effect.void,
  };
});
