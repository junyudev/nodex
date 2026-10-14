import { realtimeVoiceAvailabilityQueryOptions } from "./realtime-voice-client";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodexRealtimeVoiceTarget } from "../../../shared/codex-realtime-voice";
import { toast } from "../../components/ui/toast";
import {
  createRealtimeVoiceWindowOwner,
  type RealtimeVoiceWindowOwner,
  type RealtimeVoiceWindowSnapshot,
  type RealtimeVoiceContextOrigin,
} from "./realtime-voice-window-owner";
import { ScopeContextBridge } from "../../lib/maitai";
import type { ComposerAppModelContextRecipient } from "../local-conversation/view/composer/composer-app-model-context";

const OwnerContext = createContext<RealtimeVoiceWindowOwner | null>(null);
const idle: RealtimeVoiceWindowSnapshot = {
  target: null,
  phase: "inactive",
  microphoneMuted: false,
  outputMuted: false,
  availabilityRevision: 0,
};
const readIdle = () => idle;
const subscribeIdle = () => () => undefined;

function CommittedContextOrigin({ origin }: { readonly origin: RealtimeVoiceContextOrigin }) {
  useEffect(() => origin.commit(), [origin]);
  return null;
}

/** Voice resources belong to the renderer window, independently of its visible Thread subtree. */
export function RealtimeVoiceWindowProvider({
  children,
  owner: provided,
}: {
  readonly children: ReactNode;
  readonly owner?: RealtimeVoiceWindowOwner;
}) {
  const [owner] = useState(
    () =>
      provided ??
      createRealtimeVoiceWindowOwner({
        onError: (error) =>
          toast.danger(error instanceof Error ? error.message : "Could not start voice"),
        onWarning: (message) => {
          toast.warning(message);
        },
      }),
  );
  const queryClient = useQueryClient();
  const snapshot = useSyncExternalStore(owner.subscribe, owner.read, owner.read);
  useLayoutEffect(() => {
    let revision = owner.read().availabilityRevision;
    const invalidate = () => {
      const next = owner.read().availabilityRevision;
      if (next === revision) return;
      revision = next;
      void queryClient.invalidateQueries({ queryKey: ["realtime-voice-availability"] });
    };
    const unsubscribe = owner.subscribe(invalidate);
    const release = owner.acquireWindow();
    invalidate();
    return () => {
      unsubscribe();
      release();
    };
  }, [owner, queryClient]);
  return (
    <OwnerContext.Provider value={owner}>
      {children}
      {snapshot.contextOrigin ? (
        <ScopeContextBridge handle={snapshot.contextOrigin.recipient.scope}>
          <CommittedContextOrigin origin={snapshot.contextOrigin} />
        </ScopeContextBridge>
      ) : null}
    </OwnerContext.Provider>
  );
}

/** The Composer only presents an explicitly bound, policy-admitted native Codex target. */
export function useComposerRealtimeVoice(
  target: CodexRealtimeVoiceTarget | null,
  recipient?: ComposerAppModelContextRecipient | null,
) {
  const owner = useContext(OwnerContext);
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? subscribeIdle,
    owner?.read ?? readIdle,
    readIdle,
  );
  const query = useQuery({
    ...realtimeVoiceAvailabilityQueryOptions(owner ? target : null),
    enabled: owner !== null && target !== null,
  });
  const visible =
    owner !== null &&
    (snapshot.phase !== "inactive" || (target !== null && query.data?.available === true));
  const busy =
    snapshot.phase === "inactive" &&
    query.data?.session !== null &&
    query.data?.session !== undefined;
  return {
    visible,
    busy,
    phase: snapshot.phase,
    microphoneMuted: snapshot.microphoneMuted,
    outputMuted: snapshot.outputMuted,
    start: () => (owner && target ? owner.start(target, recipient) : Promise.resolve()),
    stop: () => owner?.stop() ?? Promise.resolve(),
    cancelStart: () => owner?.cancelStart() ?? Promise.resolve(),
    setMicrophoneMuted: (muted: boolean) => owner?.setMicrophoneMuted(muted) ?? Promise.resolve(),
    setOutputMuted: (muted: boolean) => owner?.setOutputMuted(muted) ?? Promise.resolve(),
  };
}
