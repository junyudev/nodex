import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  isAppContextJsonObject,
  isCodexAppModelContextVisible,
  parseCodexAppModelContextContent,
  parseCodexAppModelContextAttachments,
  type CodexAppModelContextAttachment,
} from "../../../../../shared/codex-untrusted-app-input";
import { areStructurallyEqual } from "../../../../../shared/structural-equality";
import {
  scopedAtom,
  scopedAtomWithInitializer,
  useScopeHandle,
  useScopedAtomValue,
  type ScopeHandle,
} from "../../../../lib/maitai";
import { ComposerScope, RouteScope } from "../../../../lib/workbench-ui-scopes";

export interface ComposerAppModelContextTarget {
  readonly hostId: string;
  readonly threadId: string;
}
export interface ComposerAppModelContextProvenance {
  readonly id: string;
  readonly server: string;
  readonly sourceName: string;
}
export interface ComposerAppModelContextRecipient {
  readonly target: ComposerAppModelContextTarget;
  readonly scope: ScopeHandle;
  isCurrent(): boolean;
  publish(
    provenance: ComposerAppModelContextProvenance,
    update: unknown,
  ): { readonly updateId?: string };
  submit<T>(
    deliver: (attachments: readonly CodexAppModelContextAttachment[]) => Promise<T>,
  ): Promise<T>;
  injectHidden(
    deliver: (attachments: readonly CodexAppModelContextAttachment[]) => Promise<unknown>,
  ): Promise<void>;
}

const attachmentsAtom = scopedAtom<readonly CodexAppModelContextAttachment[]>(ComposerScope, [], {
  debugLabel: "composer-app-model-context",
});
const targetAtom = scopedAtom<ComposerAppModelContextTarget | null>(ComposerScope, null, {
  debugLabel: "composer-app-model-context-target",
});
const claimsAtom = scopedAtomWithInitializer(
  ComposerScope,
  () => new Set<readonly CodexAppModelContextAttachment[]>(),
  { debugLabel: "composer-app-model-context-claims" },
);
const recipientsAtom = scopedAtom<readonly ComposerAppModelContextRecipient[]>(RouteScope, [], {
  debugLabel: "composer-app-model-context-recipients",
});
const RecipientsContext = createContext<{
  readonly recipients: readonly ComposerAppModelContextRecipient[];
  readonly readCommitted: () => readonly ComposerAppModelContextRecipient[];
}>({ recipients: [], readCommitted: () => [] });

/** Draft transfers capture this value; the Composer remains its only writable owner. */
export function readComposerAppModelContext(
  scope: ScopeHandle,
): readonly CodexAppModelContextAttachment[] {
  return scope.get(attachmentsAtom);
}

export function restoreComposerAppModelContextSnapshot(
  scope: ScopeHandle,
  attachments: readonly CodexAppModelContextAttachment[],
): void {
  scope.set(attachmentsAtom, parseCodexAppModelContextAttachments(attachments) ?? []);
}

/** Editing a captured app submission creates message attachments; Voice must not claim them again. */
export function restoreComposerAppModelContext(
  scope: ScopeHandle,
  input: unknown,
  append: boolean,
): void {
  const attachments = (parseCodexAppModelContextAttachments(input) ?? []).map((entry) => {
    if (entry.kind === "message") return entry;
    const { modelContextUpdateId: _updateId, ...rest } = entry;
    return { ...rest, id: crypto.randomUUID(), kind: "message" as const };
  });
  scope.set(attachmentsAtom, (current) => (append ? [...current, ...attachments] : attachments));
}

/** The real route composition supplies committed capabilities to its transcript subtree. */
export function ComposerAppModelContextProvider({ children }: { readonly children: ReactNode }) {
  const recipients = useScopedAtomValue(recipientsAtom);
  const route = useScopeHandle(RouteScope);
  const readCommitted = useCallback(() => route.get(recipientsAtom), [route]);
  return createElement(
    RecipientsContext.Provider,
    { value: { readCommitted, recipients } },
    children,
  );
}

async function deliverComposerAppModelContext<T>(
  scope: ScopeHandle,
  hiddenOnly: boolean,
  send: (attachments: readonly CodexAppModelContextAttachment[]) => Promise<T>,
  assertRecipientCurrent?: () => void,
): Promise<T> {
  assertRecipientCurrent?.();
  const claims = scope.get(claimsAtom);
  const attachments = scope
    .get(attachmentsAtom)
    .filter(
      (attachment) =>
        (!hiddenOnly ||
          (attachment.kind !== "message" && !isCodexAppModelContextVisible(attachment))) &&
        !Array.from(claims).some((claimed) =>
          claimed.some((entry) => areStructurallyEqual(entry, attachment)),
        ),
    );
  claims.add(attachments);
  try {
    const result = await send(attachments);
    assertRecipientCurrent?.();
    scope.set(attachmentsAtom, (current) =>
      current.filter(
        (entry) => !attachments.some((captured) => areStructurallyEqual(captured, entry)),
      ),
    );
    return result;
  } finally {
    claims.delete(attachments);
  }
}

function createRecipient(
  scope: ScopeHandle,
  target: ComposerAppModelContextTarget,
): ComposerAppModelContextRecipient {
  const isCurrent = () => {
    try {
      return scope.get(targetAtom) === target;
    } catch {
      return false;
    }
  };
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("The context composer is unavailable");
  };
  return {
    target,
    scope,
    isCurrent,
    publish(provenance, value) {
      assertCurrent();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid MCP model context params");
      const update = value as Record<string, unknown>;
      const content = parseCodexAppModelContextContent(
        update.content === undefined ? [] : update.content,
      );
      const structuredContent = update.structuredContent;
      if (structuredContent !== undefined && !isAppContextJsonObject(structuredContent))
        throw new Error("Invalid structured app context");
      const updateId =
        content.length > 0 || structuredContent !== undefined ? crypto.randomUUID() : undefined;
      const attachment: CodexAppModelContextAttachment = {
        ...provenance,
        kind: "context",
        untrusted: true,
        content,
        ...(structuredContent !== undefined ? { structuredContent } : {}),
        ...(updateId ? { modelContextUpdateId: updateId } : {}),
      };
      scope.set(attachmentsAtom, (current) => {
        if (!updateId) return current.filter((entry) => entry.id !== provenance.id);
        const index = current.findIndex((entry) => entry.id === provenance.id);
        if (index < 0) return [...current, attachment];
        return current.map((entry, position) => (position === index ? attachment : entry));
      });
      return updateId ? { updateId } : {};
    },
    submit: (send) => {
      assertCurrent();
      return deliverComposerAppModelContext(scope, false, send);
    },
    injectHidden: async (send) => {
      await deliverComposerAppModelContext(
        scope,
        true,
        (attachments) => (attachments.length > 0 ? send(attachments) : Promise.resolve()),
        assertCurrent,
      );
    },
  };
}

/** A committed Composer publishes its capability; the Route only stores references, never context bytes. */
export function useComposerAppModelContext(input: {
  readonly hostId: string;
  readonly threadId: string | null;
  readonly enabled: boolean;
}) {
  const scope = useScopeHandle(ComposerScope);
  const route = useScopeHandle(RouteScope);
  const attachments = useScopedAtomValue(attachmentsAtom);
  const recipient = useMemo(
    () =>
      input.enabled && input.threadId
        ? createRecipient(scope, { hostId: input.hostId, threadId: input.threadId })
        : null,
    [scope, input.enabled, input.hostId, input.threadId],
  );
  useLayoutEffect(() => {
    scope.set(targetAtom, recipient?.target ?? null);
    if (!recipient) return;
    route.set(recipientsAtom, (current) => [...current, recipient]);
    return () => {
      route.set(recipientsAtom, (current) => current.filter((entry) => entry !== recipient));
    };
  }, [recipient, route, scope]);
  return {
    attachments,
    recipient,
    remove: (id: string) =>
      scope.set(attachmentsAtom, (current) => current.filter((entry) => entry.id !== id)),
    submit: <T>(send: (attachments: readonly CodexAppModelContextAttachment[]) => Promise<T>) =>
      deliverComposerAppModelContext(scope, false, send),
  };
}

/** Read after layout registration; Context updates still renew the binding when recipients change. */
export function useComposerAppModelContextRecipient(target: ComposerAppModelContextTarget | null) {
  const registry = useContext(RecipientsContext);
  return useCallback(
    () =>
      registry
        .readCommitted()
        .find(
          (entry) =>
            entry.target.hostId === target?.hostId &&
            entry.target.threadId === target.threadId &&
            entry.isCurrent(),
        ) ?? null,
    [registry, target],
  );
}
