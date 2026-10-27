import {
  codexUserInputConversationKey,
  type CodexUserInputAutoResolutionConversation as Conversation,
} from "../../shared/codex-user-input-auto-resolution";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { CodexRendererViewRegistry } from "../codex/codex-renderer-view-registry";

export interface CodexRendererPresentationRegistryService {
  readonly setClientForegrounded: (
    clientId: string,
    foregrounded: boolean,
  ) => readonly Conversation[];
  readonly setPresented: (
    conversationId: string,
    clientId: string,
    surfaceId: string,
    presented: boolean,
    hostId?: string,
  ) => { readonly accepted: boolean; readonly presentedInForeground: boolean };
  readonly isPresentedInForeground: (conversationId: string, hostId?: string) => boolean;
  readonly hasForegroundClient: () => boolean;
  readonly isClientPresenting: (
    conversationId: string,
    clientId: string,
    hostId?: string,
  ) => boolean;
  readonly resolvePresentedSurfaceClient: (
    conversationId: string,
    hostId?: string,
  ) => string | null;
  readonly handleClientConnected: (clientId: string) => void;
  readonly handleClientDisposed: (clientId: string) => readonly Conversation[];
  readonly clearConversation: (conversationId: string, hostId?: string) => void;
}

export class CodexRendererPresentationRegistry extends Context.Service<
  CodexRendererPresentationRegistry,
  CodexRendererPresentationRegistryService
>()("nodex/main/codex-application/CodexRendererPresentationRegistry") {}

export const make: Effect.Effect<CodexRendererPresentationRegistryService, never, Scope.Scope> =
  Effect.gen(function* () {
    const views = new CodexRendererViewRegistry();
    const key = (conversationId: string, hostId = "local") =>
      codexUserInputConversationKey({ hostId, conversationId });
    const targets = (keys: readonly string[]) =>
      keys.map((value): Conversation => {
        // Keys come only from this registry's encoder.
        const [hostId, conversationId] = JSON.parse(value) as [string, string];
        return { hostId, conversationId };
      });
    const disposedClientIds = new Set<string>();
    let closed = false;
    const normalize = (value: string): string => value.trim();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        disposedClientIds.clear();
        views.reset();
      }),
    );

    return CodexRendererPresentationRegistry.of({
      setClientForegrounded: (clientId, foregrounded) => {
        const normalizedClientId = normalize(clientId);
        if (
          closed ||
          !normalizedClientId ||
          (foregrounded && disposedClientIds.has(normalizedClientId))
        )
          return [];
        return targets(views.setClientForegrounded(normalizedClientId, foregrounded));
      },
      setPresented: (conversationId, clientId, surfaceId, presented, hostId = "local") => {
        const normalizedClientId = normalize(clientId);
        if (
          closed ||
          !normalizedClientId ||
          (presented && disposedClientIds.has(normalizedClientId))
        )
          return { accepted: false, presentedInForeground: false };
        const conversationKey = key(conversationId, hostId);
        views.setPresented(conversationKey, normalizedClientId, surfaceId, presented);
        return {
          accepted: true,
          presentedInForeground: presented && views.isPresentedInForeground(conversationKey),
        };
      },
      isPresentedInForeground: (conversationId, hostId) =>
        views.isPresentedInForeground(key(conversationId, hostId)),
      hasForegroundClient: () => views.hasForegroundClient(),
      isClientPresenting: (conversationId, clientId, hostId) =>
        views.isClientPresenting(key(conversationId, hostId), clientId),
      resolvePresentedSurfaceClient: (conversationId, hostId) =>
        views.resolvePresentedSurfaceClient(key(conversationId, hostId)),
      handleClientConnected: (clientId) => {
        if (!closed) disposedClientIds.delete(normalize(clientId));
      },
      handleClientDisposed: (clientId) => {
        const normalizedClientId = normalize(clientId);
        if (closed || !normalizedClientId || disposedClientIds.has(normalizedClientId)) return [];
        disposedClientIds.add(normalizedClientId);
        return targets(views.removeClient(normalizedClientId));
      },
      clearConversation: (conversationId, hostId) => {
        if (closed) return;
        const conversationKey = key(conversationId, hostId);
        views.clearConversation(conversationKey);
      },
    });
  });
