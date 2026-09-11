import type { WorkspaceSearchContext } from "./workspace-search-context";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ProjectSession } from "../../shared/types";
import {
  ScopeProvider,
  appScope,
  defineScope,
  scopedAtom,
  useScopeHandle,
  useScopedAtomValue,
  useSetScopedAtom,
  type ScopeHandle,
} from "./maitai";

export type ThreadScopeStableKey = `draft:${string}` | `session:${string}` | `client:${string}`;

export interface ThreadScopeDescriptor {
  readonly stableKey: ThreadScopeStableKey;
  readonly phase: "new" | "pending" | "attached";
  readonly projectSessionId: string | null;
  readonly clientThreadId: string | null;
  readonly threadId: string | null;
}

export interface RouteScopeDescriptor {
  readonly routeKey: string;
  readonly kind: "thread" | "automations" | "settings" | "pages" | "pending-worktree";
}

export interface ComposerScopeDescriptor {
  readonly identity: string;
  readonly focusComposerNonce: number | null;
}

export const APP_SHELL_ROUTE_THREAD_SCOPE_DESCRIPTOR: ThreadScopeDescriptor = {
  stableKey: "session:app-shell-routes",
  phase: "new",
  projectSessionId: null,
  clientThreadId: null,
  threadId: null,
};

export const ThreadScope = defineScope({
  debugLabel: "ThreadScope",
  parent: appScope,
  retain: { max: 20 },
  getKey: (descriptor: ThreadScopeDescriptor) => descriptor.stableKey,
});

export const RouteScope = defineScope({
  debugLabel: "RouteScope",
  parent: ThreadScope,
  retain: { max: 20 },
  getKey: (descriptor: RouteScopeDescriptor) => descriptor.routeKey,
});

export const ComposerScope = defineScope({
  debugLabel: "ComposerScope",
  parent: RouteScope,
  retain: { max: 100 },
  getKey: (descriptor: ComposerScopeDescriptor) => descriptor.identity,
});

const selectedRouteScopeHandleAtom = scopedAtom<ScopeHandle | null>(appScope, null, {
  debugLabel: "selected-route-scope-handle",
});

export const appShellHeaderContentAtom = scopedAtom<ReactNode>(RouteScope, null, {
  debugLabel: "app-shell-header-content",
});

const workspaceSearchContextAtom = scopedAtom<WorkspaceSearchContext | null>(RouteScope, null, {
  debugLabel: "workspace-search-context",
});

export function WorkspaceSearchContextRegistrar({
  context,
}: {
  readonly context: WorkspaceSearchContext | null;
}) {
  const setContext = useSetScopedAtom(workspaceSearchContextAtom);
  useLayoutEffect(() => {
    setContext(context);
    return () => setContext(null);
  }, [context, setContext]);
  return null;
}

export function useSelectedWorkspaceSearchContext() {
  const selectedRoute = useScopedAtomValue(selectedRouteScopeHandleAtom);
  const subscribe = useCallback(
    (listener: () => void) =>
      selectedRoute?.sub(workspaceSearchContextAtom, listener) ?? (() => undefined),
    [selectedRoute],
  );
  const getSnapshot = useCallback(
    () => selectedRoute?.get(workspaceSearchContextAtom) ?? null,
    [selectedRoute],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export class IdentityPromotionConflict extends Error {
  constructor(readonly stableKeys: readonly ThreadScopeStableKey[]) {
    super(`Thread scope identity promotion conflict: ${stableKeys.join(" versus ")}`);
    this.name = "IdentityPromotionConflict";
  }
}

export interface ThreadScopeIdentityRegistry {
  resolve(input: {
    readonly projectSessionId?: string | null;
    readonly clientThreadId?: string | null;
    readonly threadId?: string | null;
    readonly draftId?: string | null;
  }): ThreadScopeStableKey;
  register(
    stableKey: ThreadScopeStableKey,
    aliases: {
      readonly projectSessionId?: string | null;
      readonly clientThreadId?: string | null;
      readonly threadId?: string | null;
      readonly draftId?: string | null;
    },
  ): void;
}

export function createThreadScopeIdentityRegistry(): ThreadScopeIdentityRegistry {
  const aliases = new Map<string, ThreadScopeStableKey>();
  const aliasKeys = (input: {
    readonly projectSessionId?: string | null;
    readonly clientThreadId?: string | null;
    readonly threadId?: string | null;
    readonly draftId?: string | null;
  }) =>
    [
      input.projectSessionId?.trim() ? `session:${input.projectSessionId.trim()}` : null,
      input.clientThreadId?.trim() ? `client:${input.clientThreadId.trim()}` : null,
      input.threadId?.trim() ? `thread:${input.threadId.trim()}` : null,
      input.draftId?.trim() ? `draft:${input.draftId.trim()}` : null,
    ].filter((value): value is string => value !== null);

  const register = (
    stableKey: ThreadScopeStableKey,
    input: {
      readonly projectSessionId?: string | null;
      readonly clientThreadId?: string | null;
      readonly threadId?: string | null;
      readonly draftId?: string | null;
    },
  ) => {
    const known = new Set(aliasKeys(input).flatMap((alias) => aliases.get(alias) ?? []));
    if (known.size > 0 && (!known.has(stableKey) || known.size > 1)) {
      throw new IdentityPromotionConflict([...known, stableKey]);
    }
    for (const alias of aliasKeys(input)) aliases.set(alias, stableKey);
  };

  return {
    resolve(input) {
      const known = new Set(aliasKeys(input).flatMap((alias) => aliases.get(alias) ?? []));
      if (known.size > 1) throw new IdentityPromotionConflict([...known]);
      const existing = known.values().next().value as ThreadScopeStableKey | undefined;
      if (existing) {
        register(existing, input);
        return existing;
      }
      const clientThreadId = input.clientThreadId?.trim();
      const projectSessionId = input.projectSessionId?.trim();
      const draftId = input.draftId?.trim();
      const stableKey = clientThreadId
        ? (`client:${clientThreadId}` as const)
        : projectSessionId
          ? (`session:${projectSessionId}` as const)
          : draftId
            ? (`draft:${draftId}` as const)
            : null;
      if (!stableKey) {
        throw new Error("Thread scope identity requires a draft, session, or client thread id");
      }
      register(stableKey, input);
      return stableKey;
    },
    register,
  };
}

export function resolveProjectDraftThreadScopeDescriptor(
  registry: ThreadScopeIdentityRegistry,
  draftId: string,
): ThreadScopeDescriptor {
  const normalizedDraftId = draftId.trim();
  if (!normalizedDraftId) {
    throw new Error("Project draft scope identity requires a draft id");
  }
  return {
    stableKey: registry.resolve({ draftId: normalizedDraftId }),
    phase: "new",
    projectSessionId: null,
    clientThreadId: null,
    threadId: null,
  };
}

export function resolveProjectSessionThreadScopeDescriptor(
  registry: ThreadScopeIdentityRegistry,
  session: ProjectSession,
  clientThreadId: string | null = null,
): ThreadScopeDescriptor {
  const threadId = session.thread?.threadId?.trim() || null;
  const normalizedClientThreadId = clientThreadId?.trim() || null;
  return {
    stableKey: registry.resolve({
      projectSessionId: session.id,
      clientThreadId: normalizedClientThreadId,
      threadId,
    }),
    phase: threadId ? "attached" : normalizedClientThreadId ? "pending" : "new",
    projectSessionId: session.id,
    clientThreadId: normalizedClientThreadId,
    threadId,
  };
}

export function resolvePendingThreadScopeDescriptor(
  registry: ThreadScopeIdentityRegistry,
  clientThreadId: string,
  projectSessionId: string | null = null,
): ThreadScopeDescriptor {
  const normalizedClientThreadId = clientThreadId.trim();
  const normalizedProjectSessionId = projectSessionId?.trim() || null;
  if (!normalizedClientThreadId) {
    throw new Error("Pending thread scope identity requires a client thread id");
  }
  return {
    stableKey: registry.resolve({
      projectSessionId: normalizedProjectSessionId,
      clientThreadId: normalizedClientThreadId,
    }),
    phase: "pending",
    projectSessionId: normalizedProjectSessionId,
    clientThreadId: normalizedClientThreadId,
    threadId: null,
  };
}

/**
 * Attach the immutable client id before navigating away from the source route.
 * This keeps one React/maitai owner while a draft or Session becomes a pending
 * task and later receives its server Thread id.
 */
export function promoteThreadScopeToPending(
  registry: ThreadScopeIdentityRegistry,
  current: ThreadScopeDescriptor,
  clientThreadId: string,
  projectSessionId: string | null = current.projectSessionId,
): ThreadScopeDescriptor {
  const normalizedClientThreadId = clientThreadId.trim();
  const normalizedProjectSessionId = projectSessionId?.trim() || null;
  if (!normalizedClientThreadId) {
    throw new Error("Pending thread scope promotion requires a client thread id");
  }
  if (normalizedProjectSessionId !== current.projectSessionId) {
    return resolvePendingThreadScopeDescriptor(
      registry,
      normalizedClientThreadId,
      normalizedProjectSessionId,
    );
  }
  registry.register(current.stableKey, {
    projectSessionId: current.projectSessionId,
    clientThreadId: normalizedClientThreadId,
    threadId: current.threadId,
  });
  return {
    ...current,
    phase: "pending",
    projectSessionId: normalizedProjectSessionId,
    clientThreadId: normalizedClientThreadId,
  };
}

export function resolveComposerScopeIdentity(input: {
  readonly kind: "new-conversation" | "panel-new-conversation" | "preview" | "task";
  readonly stableIdentity?: string | null;
  readonly attachmentIdentity?: string | null;
  readonly focusComposerNonce?: number | null;
}): ComposerScopeDescriptor {
  const base =
    input.kind === "preview"
      ? `preview:${input.attachmentIdentity?.trim() || "empty"}`
      : input.kind === "task"
        ? `task:${input.stableIdentity?.trim() || "unknown"}`
        : input.kind;
  return {
    identity: base,
    focusComposerNonce: input.focusComposerNonce ?? null,
  };
}

export function WorkbenchSessionScopePath({
  thread,
  route,
  selected,
  children,
}: {
  readonly thread: ThreadScopeDescriptor;
  readonly route: RouteScopeDescriptor;
  readonly selected: boolean;
  readonly children: ReactNode;
}) {
  return (
    <ScopeProvider scope={ThreadScope} descriptor={thread}>
      <ScopeProvider scope={RouteScope} descriptor={route}>
        <SelectedRouteScopeRegistrar selected={selected} />
        {children}
      </ScopeProvider>
    </ScopeProvider>
  );
}

export function AppShellHeaderContentRegistrar({ content }: { readonly content: ReactNode }) {
  const setContent = useSetScopedAtom(appShellHeaderContentAtom);
  useLayoutEffect(() => {
    setContent(content);
    return () => setContent(null);
  }, [content, setContent]);
  return null;
}

export function SelectedAppShellHeaderContent() {
  const selectedRoute = useScopedAtomValue(selectedRouteScopeHandleAtom);
  const subscribe = useCallback(
    (listener: () => void) =>
      selectedRoute?.sub(appShellHeaderContentAtom, listener) ?? (() => undefined),
    [selectedRoute],
  );
  const getSnapshot = useCallback(
    () => selectedRoute?.get(appShellHeaderContentAtom) ?? null,
    [selectedRoute],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function SelectedRouteScopeRegistrar({ selected }: { readonly selected: boolean }) {
  const routeHandle = useScopeHandle(RouteScope);
  // Header ownership follows the retained Route identity, not each prepared descriptor snapshot.
  const routeOwnerRef = useRef(routeHandle);
  if (routeOwnerRef.current.path !== routeHandle.path) {
    routeOwnerRef.current = routeHandle;
  }
  const routeOwner = routeOwnerRef.current;
  const setSelectedRoute = useSetScopedAtom(selectedRouteScopeHandleAtom);
  useLayoutEffect(() => {
    if (!selected) return;
    setSelectedRoute(routeOwner);
    return () => {
      setSelectedRoute((current) => (current === routeOwner ? null : current));
    };
  }, [routeOwner, selected, setSelectedRoute]);
  return null;
}
