import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { DictationGesture } from "../../../shared/dictation";
import type {
  GlobalDictationDeclineReason,
  GlobalDictationRendererEvent,
} from "../../../shared/global-dictation";
import { subscribeGlobalDictationCommands } from "@/lib/global-dictation-commands";
import { reportGlobalDictationEvent } from "./dictation-command-runtime";

export interface InAppDictationTarget {
  readonly id: string;
  readonly priority: number;
  readonly admission: () => GlobalDictationDeclineReason | null;
  readonly start: (input: {
    readonly sessionId: string;
    readonly gesture: Extract<DictationGesture, "hold" | "toggle">;
    readonly release: () => void;
  }) => Promise<void>;
  readonly stop: () => void;
  readonly cancel: () => void;
}

interface InAppDictationTargetRegistry {
  readonly register: (target: InAppDictationTarget) => () => void;
}

interface ActiveRoute {
  readonly sessionId: string;
  readonly requestId: string;
  readonly target: InAppDictationTarget;
  pendingTerminal: "stop" | "cancel" | null;
}

const InAppDictationTargetContext = createContext<InAppDictationTargetRegistry | null>(null);

const report = async (event: GlobalDictationRendererEvent): Promise<boolean> =>
  await reportGlobalDictationEvent(event);

const selectTarget = (
  targets: ReadonlyMap<string, InAppDictationTarget>,
):
  | { readonly type: "accepted"; readonly target: InAppDictationTarget }
  | { readonly type: "declined"; readonly reason: GlobalDictationDeclineReason } => {
  let reason: GlobalDictationDeclineReason = "unavailable";
  for (const target of [...targets.values()].sort(
    (left, right) => right.priority - left.priority,
  )) {
    const rejection = target.admission();
    if (!rejection) return { type: "accepted", target };
    reason = rejection;
  }
  return { type: "declined", reason };
};

/** The sole Main-command subscriber in an app renderer; composers only register capabilities. */
export function InAppDictationRouter({ children }: { readonly children: ReactNode }) {
  const targetsRef = useRef(new Map<string, InAppDictationTarget>());
  const activeRef = useRef<ActiveRoute | null>(null);
  const registryRef = useRef<InAppDictationTargetRegistry | null>(null);
  registryRef.current ??= {
    register: (target) => {
      targetsRef.current.set(target.id, target);
      return () => {
        if (targetsRef.current.get(target.id) === target) targetsRef.current.delete(target.id);
        const active = activeRef.current;
        if (active?.target !== target) return;
        active.target.cancel();
        activeRef.current = null;
        void report({ type: "cancelled", sessionId: active.sessionId }).catch(() => undefined);
      };
    },
  };

  useEffect(() => {
    return subscribeGlobalDictationCommands((command) => {
      if (command.type === "start") {
        if (activeRef.current) {
          void report({
            type: "declined",
            sessionId: command.sessionId,
            requestId: command.requestId,
            reason: "busy",
          }).catch(() => undefined);
          return;
        }
        if (Date.now() > command.deadlineAtMs) {
          void report({
            type: "declined",
            sessionId: command.sessionId,
            requestId: command.requestId,
            reason: "deadline-expired",
          }).catch(() => undefined);
          return;
        }
        const selected = selectTarget(targetsRef.current);
        if (selected.type === "declined") {
          void report({
            type: "declined",
            sessionId: command.sessionId,
            requestId: command.requestId,
            reason: selected.reason,
          }).catch(() => undefined);
          return;
        }
        const route: ActiveRoute = {
          sessionId: command.sessionId,
          requestId: command.requestId,
          target: selected.target,
          pendingTerminal: null,
        };
        activeRef.current = route;
        void report({
          type: "accepted",
          sessionId: command.sessionId,
          requestId: command.requestId,
          targetId: selected.target.id,
        })
          .then(async (accepted) => {
            if (!accepted || activeRef.current !== route) {
              if (activeRef.current === route) activeRef.current = null;
              return;
            }
            try {
              await route.target.start({
                sessionId: command.sessionId,
                gesture: command.gesture,
                release: () => {
                  if (activeRef.current === route) activeRef.current = null;
                },
              });
            } catch {
              if (activeRef.current === route) activeRef.current = null;
              route.target.cancel();
              void report({ type: "cancelled", sessionId: route.sessionId }).catch(() => undefined);
              return;
            }
            if (activeRef.current !== route) return;
            if (route.pendingTerminal === "stop") route.target.stop();
            if (route.pendingTerminal === "cancel") route.target.cancel();
          })
          .catch(() => {
            if (activeRef.current === route) activeRef.current = null;
          });
        return;
      }

      const active = activeRef.current;
      if (!active || active.sessionId !== command.sessionId) return;
      if (command.type === "stop") {
        active.pendingTerminal = "stop";
        active.target.stop();
        return;
      }
      if (command.type === "cancel") {
        active.pendingTerminal = "cancel";
        active.target.cancel();
        activeRef.current = null;
      }
    });
  }, []);

  return (
    <InAppDictationTargetContext.Provider value={registryRef.current}>
      {children}
    </InAppDictationTargetContext.Provider>
  );
}

export function useInAppDictationTarget(target: InAppDictationTarget): void {
  const registry = useContext(InAppDictationTargetContext);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(
    () =>
      registry?.register({
        id: target.id,
        priority: target.priority,
        admission: () => targetRef.current.admission(),
        start: (input) => targetRef.current.start(input),
        stop: () => targetRef.current.stop(),
        cancel: () => targetRef.current.cancel(),
      }),
    [registry, target.id, target.priority],
  );
}
