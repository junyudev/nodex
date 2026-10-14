import type { ConversationTextRole } from "@nodex/codex-app-server-protocol";
import type {
  CodexRealtimeVoiceGrant,
  CodexRealtimeVoiceEvent,
  CodexRealtimeVoiceTarget,
  CodexRealtimeVoiceMediaEvidence,
} from "../../../shared/codex-realtime-voice";
import type { MicrophoneAccessResult } from "../../../shared/dictation";
import type {
  RealtimeVoiceMedia,
  RealtimeVoiceMediaInput,
} from "../../lib/realtime-voice/realtime-voice-media";
import { mainRealtimeVoiceClient, type RealtimeVoiceClient } from "./realtime-voice-client";
import { requestMicrophoneAccess } from "../../lib/api";

export interface RealtimeVoiceWindowSnapshot {
  readonly target: CodexRealtimeVoiceTarget | null;
  readonly phase: "inactive" | "preparing" | "starting" | "active" | "stopping";
  readonly microphoneMuted: boolean;
  readonly outputMuted: boolean;
  readonly availabilityRevision: number;
}
interface Attempt {
  readonly target: CodexRealtimeVoiceTarget;
  readonly controller: AbortController;
  grant: CodexRealtimeVoiceGrant | null;
  preparing: Promise<CodexRealtimeVoiceGrant> | null;
  media: RealtimeVoiceMedia | null;
  creatingMedia: Promise<{ readonly offerSdp: string; readonly media: RealtimeVoiceMedia }> | null;
  starting: Promise<void> | null;
  stopping: Promise<void> | null;
  requestedStop: Promise<void> | null;
  stopRequest: Promise<void> | null;
  nativeRevision: number;
  muteWrites: Promise<void>;
  retiredClaimId: string | null;
  pendingMicrophone: { readonly claimId: string; readonly deviceId: string | null } | null;
}
export interface RealtimeVoiceWindowOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: () => RealtimeVoiceWindowSnapshot;
  readonly acquireWindow: () => () => void;
  readonly start: (target: CodexRealtimeVoiceTarget) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly cancelStart: () => Promise<void>;
  readonly setMicrophoneMuted: (muted: boolean) => Promise<void>;
  readonly setOutputMuted: (muted: boolean) => Promise<void>;
  readonly appendText: (role: ConversationTextRole, text: string) => Promise<void>;
}
interface Ports {
  readonly client?: RealtimeVoiceClient;
  readonly createMedia?: (
    input: RealtimeVoiceMediaInput,
  ) => Promise<{ readonly offerSdp: string; readonly media: RealtimeVoiceMedia }>;
  readonly requestMicrophoneAccess?: () => Promise<MicrophoneAccessResult>;
  readonly onError?: (error: unknown) => void;
}
const sameTarget = (left: CodexRealtimeVoiceTarget, right: CodexRealtimeVoiceTarget) =>
  left.hostId === right.hostId && left.threadId === right.threadId;

/** A window retains its call across Thread views. A retired attempt only cleans up its own claim. */
export const createRealtimeVoiceWindowOwner = (ports: Ports = {}): RealtimeVoiceWindowOwner => {
  const client = ports.client ?? mainRealtimeVoiceClient;
  const listeners = new Set<() => void>();
  let leases = 0;
  let unsubscribe: (() => void) | null = null;
  let current: Attempt | null = null;
  const cleanups = new Set<Promise<void>>();
  let snapshot: RealtimeVoiceWindowSnapshot = {
    target: null,
    phase: "inactive",
    microphoneMuted: false,
    outputMuted: false,
    availabilityRevision: 0,
  };
  const publish = (next: RealtimeVoiceWindowSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const active = (attempt: Attempt) =>
    leases > 0 && current === attempt && !attempt.controller.signal.aborted;
  const reportError = (error: unknown) => {
    if (leases > 0) ports.onError?.(error);
  };
  const requestNativeStop = (attempt: Attempt, grant: CodexRealtimeVoiceGrant): Promise<void> => {
    attempt.stopRequest ??= Promise.resolve().then(() => client.stop(grant.claimId));
    return attempt.stopRequest;
  };
  /** Cancellation and authority retirement release resources even when native stop is rejected. */
  const stopAttempt = (attempt: Attempt): Promise<void> => {
    if (attempt.stopping) return attempt.stopping;
    attempt.controller.abort();
    if (current === attempt) publish({ ...snapshot, phase: "stopping" });
    const cleanup = (async () => {
      const grant = attempt.grant ?? (await attempt.preparing?.catch(() => null)) ?? null;
      const native = grant ? requestNativeStop(attempt, grant) : Promise.resolve();
      const resources = (async () => {
        const media =
          attempt.media ?? (await attempt.creatingMedia?.catch(() => null))?.media ?? null;
        await media?.stop();
      })();
      const outcomes = await Promise.allSettled([native, resources]);
      const release = grant
        ? await client.release(grant.claimId).then(
            () => null,
            (error: unknown) => error,
          )
        : null;
      if (current === attempt) {
        current = null;
        publish({
          ...snapshot,
          target: null,
          phase: "inactive",
          microphoneMuted: false,
          outputMuted: false,
        });
      }
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (release !== null) throw release;
    })();
    attempt.stopping = cleanup;
    cleanups.add(cleanup);
    void cleanup.then(
      () => cleanups.delete(cleanup),
      () => cleanups.delete(cleanup),
    );
    return cleanup;
  };
  const requestStop = (attempt: Attempt): Promise<void> => {
    if (attempt.stopping) return attempt.stopping;
    if (attempt.requestedStop) return attempt.requestedStop;
    if (!active(attempt) || !attempt.grant || !attempt.media) return stopAttempt(attempt);
    const grant = attempt.grant;
    const previous = snapshot.phase;
    publish({ ...snapshot, phase: "stopping" });
    const requested = (async () => {
      try {
        await requestNativeStop(attempt, grant);
      } catch (error) {
        if (!active(attempt)) {
          await attempt.stopping?.catch(() => undefined);
          return;
        }
        const status = await client.read(attempt.target).catch(() => undefined);
        if (!active(attempt)) {
          await attempt.stopping?.catch(() => undefined);
          return;
        }
        const session = status?.session;
        if (
          status !== undefined &&
          (!session ||
            !sameTarget(session, attempt.target) ||
            session.claimId !== grant.claimId ||
            session.realtimeSessionId !== grant.realtimeSessionId ||
            session.phase === "stopping")
        ) {
          await stopAttempt(attempt).catch(() => undefined);
          return;
        }
        attempt.stopRequest = null;
        publish({
          ...snapshot,
          phase: session?.phase ?? (snapshot.phase === "stopping" ? previous : snapshot.phase),
        });
        reportError(error);
        throw error;
      }
      await stopAttempt(attempt);
    })();
    attempt.requestedStop = requested;
    const clear = () => {
      if (attempt.requestedStop === requested) attempt.requestedStop = null;
    };
    void requested.then(clear, clear);
    return requested;
  };
  const fail = (attempt: Attempt, error: unknown): void => {
    if (!active(attempt)) return;
    reportError(error);
    void stopAttempt(attempt).catch(() => undefined);
  };
  const report = (attempt: Attempt, evidence: CodexRealtimeVoiceMediaEvidence): void => {
    if (!active(attempt) || !attempt.grant) return;
    void client
      .reportMedia(attempt.grant.claimId, evidence)
      .catch((error: unknown) => fail(attempt, error));
  };
  const applyMicrophonePreference = async (attempt: Attempt): Promise<void> => {
    const preference = attempt.pendingMicrophone;
    if (
      !active(attempt) ||
      !attempt.grant ||
      !attempt.media ||
      !preference ||
      preference.claimId !== attempt.grant.claimId
    )
      return;
    attempt.pendingMicrophone = null;
    try {
      await attempt.media.refreshInput(preference.deviceId);
    } catch {
      if (active(attempt))
        console.warn("Could not update the voice microphone; keeping the current input");
    }
  };
  const receive = (event: CodexRealtimeVoiceEvent): void => {
    if (event.type === "availabilityChanged") {
      publish({ ...snapshot, availabilityRevision: snapshot.availabilityRevision + 1 });
      return;
    }
    const attempt = current;
    if (!attempt || !active(attempt)) return;
    if (!attempt.grant) {
      if (event.type === "terminate") attempt.retiredClaimId = event.claimId;
      if (event.type === "microphoneChanged")
        attempt.pendingMicrophone = { claimId: event.claimId, deviceId: event.deviceId };
      return;
    }
    const claimId = event.type === "snapshot" ? event.snapshot.claimId : event.claimId;
    if (claimId !== attempt.grant.claimId) return;
    if (event.type === "snapshot") {
      const value = event.snapshot;
      if (
        !sameTarget(value, attempt.target) ||
        value.realtimeSessionId !== attempt.grant.realtimeSessionId ||
        value.revision <= attempt.nativeRevision
      )
        return;
      attempt.nativeRevision = value.revision;
      publish({ ...snapshot, phase: value.phase });
      return;
    }
    if (event.type === "terminate") {
      void stopAttempt(attempt).catch(() => undefined);
      return;
    }
    if (event.type === "microphoneChanged") {
      attempt.pendingMicrophone = { claimId: event.claimId, deviceId: event.deviceId };
      void applyMicrophonePreference(attempt);
      return;
    }
    if (event.notification.params.threadId !== attempt.target.threadId) return;
    const notification = event.notification;
    if (notification.method === "thread/realtime/sdp") {
      void attempt.media
        ?.acceptAnswer(notification.params.sdp)
        .catch((error: unknown) => fail(attempt, error));
      return;
    }
    if (notification.method === "thread/realtime/error") {
      fail(attempt, new Error(notification.params.message));
      return;
    }
    if (
      notification.method === "thread/realtime/closed" &&
      notification.params.reason !== "transport_closed"
    ) {
      if (attempt.requestedStop) void stopAttempt(attempt).catch(() => undefined);
      else fail(attempt, new Error("Voice session closed"));
    }
  };
  const start = (target: CodexRealtimeVoiceTarget): Promise<void> => {
    if (leases === 0) return Promise.reject(new Error("The voice window is closed"));
    if (current) {
      if (sameTarget(current.target, target) && !current.controller.signal.aborted)
        return current.starting ?? Promise.resolve();
      return Promise.reject(new Error("Voice is already active"));
    }
    const attempt: Attempt = {
      target: { ...target },
      controller: new AbortController(),
      grant: null,
      preparing: null,
      media: null,
      creatingMedia: null,
      starting: null,
      stopping: null,
      requestedStop: null,
      stopRequest: null,
      nativeRevision: -1,
      muteWrites: Promise.resolve(),
      retiredClaimId: null,
      pendingMicrophone: null,
    };
    current = attempt;
    publish({
      ...snapshot,
      target: attempt.target,
      phase: "preparing",
      microphoneMuted: false,
      outputMuted: false,
    });
    const pending = (async () => {
      try {
        await Promise.allSettled([...cleanups]);
        if (!active(attempt)) return;
        attempt.preparing = client.prepare(attempt.target);
        const grant = await attempt.preparing;
        attempt.grant = grant;
        if (!sameTarget(grant, attempt.target))
          throw new Error("Voice preparation changed its chat");
        if (attempt.retiredClaimId === grant.claimId) {
          await stopAttempt(attempt);
          return;
        }
        if (attempt.pendingMicrophone?.claimId !== grant.claimId) attempt.pendingMicrophone = null;
        if (!active(attempt)) {
          await stopAttempt(attempt);
          return;
        }
        publish({ ...snapshot, phase: "starting" });
        const create =
          ports.createMedia ??
          ((input: RealtimeVoiceMediaInput) =>
            import("../../lib/realtime-voice/realtime-voice-media").then(
              ({ createRealtimeVoiceMedia }) => createRealtimeVoiceMedia(input),
            ));
        attempt.creatingMedia = Promise.resolve().then(() =>
          create({
            grant,
            signal: attempt.controller.signal,
            assertCanCapture: () => active(attempt),
            requestMicrophoneAccess: ports.requestMicrophoneAccess ?? requestMicrophoneAccess,
            onConnected: () => report(attempt, "connected"),
            onInitialized: () => report(attempt, "initialized"),
            onFailure: (error) => fail(attempt, error),
          }),
        );
        const prepared = await attempt.creatingMedia;
        attempt.media = prepared.media;
        if (!active(attempt)) {
          await stopAttempt(attempt);
          return;
        }
        await applyMicrophonePreference(attempt);
        if (!active(attempt)) return;
        await client.start(grant.claimId, prepared.offerSdp);
        if (!active(attempt)) return;
      } catch (error) {
        const wasActive = active(attempt);
        if (wasActive) reportError(error);
        await stopAttempt(attempt).catch(() => undefined);
        if (wasActive) throw error;
      }
    })();
    attempt.starting = pending;
    return pending;
  };
  const setMuted = async (
    kind: "microphoneMuted" | "outputMuted",
    muted: boolean,
  ): Promise<void> => {
    const attempt = current;
    if (!attempt || !active(attempt) || !attempt.grant || !attempt.media) return;
    if (kind === "microphoneMuted") attempt.media.setMicrophoneMuted(muted);
    else attempt.media.setOutputMuted(muted);
    publish({ ...snapshot, [kind]: muted });
    const write = attempt.muteWrites.then(async () => {
      if (!active(attempt) || !attempt.grant) return;
      await client.setMuted({
        claimId: attempt.grant.claimId,
        microphoneMuted: snapshot.microphoneMuted,
        outputMuted: snapshot.outputMuted,
      });
    });
    attempt.muteWrites = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      fail(attempt, error);
      throw error;
    }
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => snapshot,
    acquireWindow: () => {
      leases++;
      if (leases === 1) unsubscribe = client.subscribe(receive);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases--;
        if (leases !== 0) return;
        unsubscribe?.();
        unsubscribe = null;
        if (current) void stopAttempt(current).catch(() => undefined);
      };
    },
    start,
    stop: () => (current ? requestStop(current) : Promise.resolve()),
    cancelStart: () =>
      current
        ? snapshot.phase === "active"
          ? requestStop(current)
          : stopAttempt(current)
        : Promise.resolve(),
    setMicrophoneMuted: (muted) => setMuted("microphoneMuted", muted),
    setOutputMuted: (muted) => setMuted("outputMuted", muted),
    appendText: async (role, text) => {
      const attempt = current;
      if (!attempt || !active(attempt) || !attempt.grant) throw new Error("Voice is not active");
      await client.appendText(attempt.grant.claimId, role, text);
    },
  };
};
