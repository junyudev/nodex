import { encodePushKey, PUSH_KEY_BYTES, type PushPreferences } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { Connection } from "./connection";
import {
  Platform,
  PlatformFailure,
  type DeliveredNotification,
  type MobilePush,
  type PushPermission,
} from "./platform";
import { createProjection } from "./projection";
import { readStored } from "./storage";

const PREFERENCES_KEY = "nodex.mobile.notifications.preferences.v1";
const HANDLE_KEY = "nodex.mobile.notifications.handle.v1";
const OFFER_KEY = "nodex.mobile.notifications.offer-dismissed.v1";
/** The enrollments holding this phone's registration, so turning everything off reaches each. */
const SPACES_KEY = "nodex.mobile.notifications.spaces.v1";

const OFF: PushPreferences = { needsYou: false, finished: false };
const ON: PushPreferences = { needsYou: true, finished: true };

const wantsAny = ({ needsYou, finished }: PushPreferences): boolean => needsYou || finished;

/** What delivered notifications to clear are about: their chat, their Page, or either. */
export interface DeliveredNotificationTarget {
  readonly sessionId?: string;
  readonly pageId?: string;
}

/** A Space answers for at most this many of its chats, and as many Pages, at a time. */
const TIDY_BATCH = 100;

/** Why notifications that are on can't arrive yet, so it never fails out of sight. */
export type NotificationProblem = "no-address" | "relay" | "space";

export interface NotificationState {
  /** Whether this phone can receive notifications from its Spaces at all. */
  readonly available: boolean;
  readonly permission: PushPermission;
  readonly preferences: PushPreferences;
  /** The person has answered, or set aside, the one time a chat offers these. */
  readonly offerDismissed: boolean;
  /** Null when the current Space knows where to reach this phone, or nothing is wanted. */
  readonly problem: NotificationProblem | null;
}

type SavedHandle = {
  readonly token: string;
  readonly environment: string;
  readonly handle: string;
};

/**
 * What this phone wants to be told, and telling each Space it connects to. A Space hears again on
 * each connection, because the system can change a phone's address at any time, and so learns a
 * change made while the phone was connected elsewhere. A failure here costs a notification, not
 * anything the person is doing, so it waits for the next connection.
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

  const registered = new Set(readStored<string[]>(platform.storage, SPACES_KEY, []));
  const remember = (hostId: string, holds: boolean) => {
    if (registered.has(hostId) === holds) return;
    if (holds) registered.add(hostId);
    else registered.delete(hostId);
    platform.storage.set(SPACES_KEY, JSON.stringify([...registered]));
  };

  const withdraw = Effect.suspend(() => {
    const link = connection.activeLink();
    if (!link || !registered.has(link.hello.host.id)) return Effect.void;
    return connection.rpc
      .request("push.unregister", {})
      .pipe(Effect.tap(() => Effect.sync(() => remember(link.hello.host.id, false))));
  }).pipe(Effect.ignore);

  const tellSpace = Effect.gen(function* () {
    const { preferences } = state.getState();
    const link = connection.activeLink();
    if (!push || !link) return;
    if (!wantsAny(preferences)) return yield* withdraw;
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
      .pipe(Effect.tapError(() => Effect.sync(() => state.setState({ problem: "space" }))));
    remember(link.hello.host.id, true);
    state.setState({ problem: null });
  }).pipe(Effect.ignore);

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

  /** Which of these a Space no longer stands behind. Nothing, when it can't say. */
  const settledOf = (
    ids: readonly string[],
    standing: (asked: string[]) => Effect.Effect<readonly string[], unknown>,
  ) =>
    Effect.gen(function* () {
      const asked = [...new Set(ids)].slice(0, TIDY_BATCH);
      if (asked.length === 0) return new Set<string>();
      const kept = yield* standing(asked).pipe(
        Effect.map((kept) => new Set(kept)),
        Effect.orElseSucceed(() => new Set(asked)),
      );
      return new Set(asked.filter((id) => !kept.has(id)));
    });

  /**
   * What a Space no longer stands behind leaves Notification Center: a chat its Member has read,
   * archived or that is gone from the chat list, and a Page whose Turn is no longer the Member's,
   * even one that waits on a chat. Each Space judges only what it sent this Member, by that Member's
   * own state, and one that can't answer leaves its notifications in place. Only the notifications
   * judged are dismissed, so one arriving meanwhile stays.
   */
  const tidyDelivered = Effect.gen(function* () {
    const link = connection.activeLink();
    if (!push || !link) return;
    const hostId = link.hello.host.id;
    const sent = (yield* attempt(() => push.delivered())).filter(
      (notification) => notification.hostId === hostId,
    );
    const [readChats, movedTurns] = yield* Effect.all(
      [
        settledOf(
          sent.flatMap(({ pageId, sessionId }) => (!pageId && sessionId ? [sessionId] : [])),
          (sessionIds) =>
            connection.rpc
              .request("chats.unread", { sessionIds })
              .pipe(Effect.map(({ sessionIds }) => sessionIds)),
        ),
        settledOf(
          sent.flatMap(({ pageId }) => (pageId ? [pageId] : [])),
          (pageIds) =>
            connection.rpc
              .request("inbox.turns", { pageIds })
              .pipe(Effect.map(({ pageIds }) => pageIds)),
        ),
      ],
      { concurrency: 2 },
    );
    const settled = sent
      .filter(({ pageId, sessionId }) =>
        pageId ? movedTurns.has(pageId) : sessionId !== null && readChats.has(sessionId),
      )
      .map(({ id }) => id);
    if (settled.length) yield* attempt(() => push.dismiss(settled));
  }).pipe(Effect.ignore);

  // The runtime is built synchronously, so what the system answers arrives after it.
  yield* refreshPermission.pipe(Effect.forkScoped({ startImmediately: true }));
  yield* connection.state.changes.pipe(
    Stream.runForEach(({ status }) =>
      status === "connected" ? refreshPermission.pipe(Effect.andThen(tellSpace)) : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  yield* Stream.merge(
    connection.state.changes.pipe(Stream.filter(({ status }) => status === "connected")),
    connection.rpc
      .events("changed")
      .pipe(Stream.filter(({ topics }) => topics.includes("chats") || topics.includes("inbox"))),
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
      yield* tellSpace;
    }).pipe(Effect.ignore),
    setPreferences: (patch: Partial<PushPreferences>) =>
      Effect.gen(function* () {
        const preferences = { ...state.getState().preferences, ...patch };
        store(preferences);
        if (!wantsAny(preferences)) state.setState({ problem: null });
        yield* tellSpace;
      }),
    dismissOffer,
    retry: tellSpace,
    /**
     * Removing a Space stops its notifications while it can still be told. One that is not connected
     * keeps the registration until this Device is revoked there.
     */
    forgetSpace: (hostId: string) =>
      Effect.gen(function* () {
        if (connection.activeHostId() === hostId) yield* withdraw;
        remember(hostId, false);
      }),
    /** Opening a chat or a Page clears what was delivered about it. */
    clearDelivered: ({ sessionId, pageId }: DeliveredNotificationTarget) =>
      Effect.gen(function* () {
        if (!push) return;
        const about = ({ sessionId: chat, pageId: page }: DeliveredNotification) =>
          (sessionId !== undefined && chat === sessionId) ||
          (pageId !== undefined && page === pageId);
        const ids = (yield* attempt(() => push.delivered())).filter(about).map(({ id }) => id);
        if (ids.length) yield* attempt(() => push.dismiss(ids));
      }).pipe(Effect.ignore),
  };
});
