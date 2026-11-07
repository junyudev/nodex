import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePersistedAtomValue, useSetPersistedAtom, persistedAtom } from "@/lib/maitai";
import { queryKeys } from "@/lib/query-keys";
import { invokeRendererQuery } from "@/lib/renderer-command";
import { useDesktopNotificationAuthorization } from "@/lib/desktop-notification-authorization";
import type { ComposerNotice } from "@/features/local-conversation/thread-stage-types";
import {
  INITIAL_FIRST_RUN_STATE,
  decideFirstRun,
  normalizeFirstRunState,
  type FirstRunEntry,
  type FirstRunState,
  type FirstRunStep,
} from "./first-run-model";

const firstRunStateAtom = persistedAtom<FirstRunState>({
  debugLabel: "first-run-state",
  storageKey: "nodex:first-run-state:v1",
  defaultValue: INITIAL_FIRST_RUN_STATE,
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: normalizeFirstRunState,
  encode: (value) => ({ version: 1, ...value }),
});

function useFirstRunWrite() {
  const writeState = useSetPersistedAtom(firstRunStateAtom);
  // A failed write keeps its value for this session, and setup never holds anyone back over it.
  return useCallback(
    (update: Parameters<typeof writeState>[0]) => writeState(update).catch(() => undefined),
    [writeState],
  );
}

export function useFirstRunState() {
  const loadable = usePersistedAtomValue(firstRunStateAtom);
  const write = useFirstRunWrite();
  const hydrated = loadable.status !== "loading";
  const goTo = useCallback(
    (step: FirstRunStep) => write((current) => ({ ...current, step })),
    [write],
  );
  const finish = useCallback(
    () => write((current) => ({ ...current, done: true, step: null })),
    [write],
  );
  return { state: hydrated ? loadable.value : null, goTo, finish };
}

const notificationOfferAtom = persistedAtom<boolean>({
  debugLabel: "first-run-notification-offer",
  storageKey: "nodex:first-run-notification-offer:v1",
  defaultValue: false,
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: (value) => value === true,
});

/**
 * Asks once, when the person has just seen an Agent finish, whether to hear about that next time.
 * Nothing is asked of macOS until they say yes.
 */
export function useNotificationOffer(runFinished: boolean): ComposerNotice | null {
  const offered = usePersistedAtomValue(notificationOfferAtom);
  const markOffered = useSetPersistedAtom(notificationOfferAtom);
  const pending = runFinished && offered.status === "ready" && !offered.value;
  const authorization = useDesktopNotificationAuthorization(pending);
  if (!pending || authorization.query.data !== "not-determined") return null;
  return {
    key: "first-run:notifications",
    tone: "warning",
    title: "Get a notification when an agent finishes?",
    actions: [
      {
        label: "Turn on",
        pendingLabel: "Asking…",
        run: async () => {
          await authorization.request.mutateAsync();
          await markOffered(true);
        },
      },
      { label: "Not now", run: () => markOffered(true).then(() => undefined) },
    ],
  };
}

/** Opens setup from anywhere in the window; the Workbench presents it. */
export function useFirstRunEntry() {
  const write = useFirstRunWrite();
  const open = useCallback(
    (entry: FirstRunEntry) => write({ done: false, step: "agents", entry }),
    [write],
  );
  return {
    runSetupAgain: useCallback(() => open("replay"), [open]),
    connectAgent: useCallback(() => open("connect"), [open]),
  };
}

export function useFirstRunPresentation() {
  const { state, finish } = useFirstRunState();
  const bootstrap = useQuery({
    queryKey: queryKeys.projects.bootstrap(),
    queryFn: () => invokeRendererQuery("projects:bootstrap"),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const workspace = bootstrap.isError ? "unknown" : (bootstrap.data?.status ?? null);
  const decision = decideFirstRun({ state, workspace });
  const [closing, setClosing] = useState(false);
  const showing = decision === "show";
  if (closing && !showing) setClosing(false);
  // Existing work settles the question for good, even if that work is later removed.
  const recordExistingWork = decision === "hide" && state?.done === false && workspace === "ready";
  useEffect(() => {
    if (recordExistingWork) void finish();
  }, [finish, recordExistingWork]);
  return {
    undecided: decision === "undecided",
    showing,
    /** The Workbench is out of reach while setup holds the window. */
    workbenchInert: showing && !closing,
    beginClosing: useCallback(() => setClosing(true), []),
  };
}
