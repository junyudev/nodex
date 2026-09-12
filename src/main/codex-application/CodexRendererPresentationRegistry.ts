import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { CodexRendererViewRegistry } from "../codex/codex-renderer-view-registry";

export interface CodexRendererPresentationRegistryService {
  readonly setClientForegrounded: (clientId: string, foregrounded: boolean) => readonly string[];
  readonly setPresented: (
    conversationId: string,
    clientId: string,
    surfaceId: string,
    presented: boolean,
  ) => { readonly accepted: boolean; readonly presentedInForeground: boolean };
  readonly isPresentedInForeground: (conversationId: string) => boolean;
  readonly hasForegroundClient: () => boolean;
  readonly isClientPresenting: (conversationId: string, clientId: string) => boolean;
  readonly resolvePresentedSurfaceClient: (conversationId: string) => string | null;
  readonly handleClientConnected: (clientId: string) => void;
  readonly handleClientDisposed: (clientId: string) => readonly string[];
  readonly clearConversation: (conversationId: string) => void;
}

export class CodexRendererPresentationRegistry extends Context.Service<
  CodexRendererPresentationRegistry,
  CodexRendererPresentationRegistryService
>()("nodex/main/codex-application/CodexRendererPresentationRegistry") {}

export const make: Effect.Effect<CodexRendererPresentationRegistryService, never, Scope.Scope> =
  Effect.gen(function* () {
    const views = new CodexRendererViewRegistry();
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
        return views.setClientForegrounded(normalizedClientId, foregrounded);
      },
      setPresented: (conversationId, clientId, surfaceId, presented) => {
        const normalizedClientId = normalize(clientId);
        if (
          closed ||
          !normalizedClientId ||
          (presented && disposedClientIds.has(normalizedClientId))
        )
          return { accepted: false, presentedInForeground: false };
        views.setPresented(conversationId, normalizedClientId, surfaceId, presented);
        return {
          accepted: true,
          presentedInForeground: presented && views.isPresentedInForeground(conversationId),
        };
      },
      isPresentedInForeground: (conversationId) => views.isPresentedInForeground(conversationId),
      hasForegroundClient: () => views.hasForegroundClient(),
      isClientPresenting: (conversationId, clientId) =>
        views.isClientPresenting(conversationId, clientId),
      resolvePresentedSurfaceClient: (conversationId) =>
        views.resolvePresentedSurfaceClient(conversationId),
      handleClientConnected: (clientId) => {
        if (!closed) disposedClientIds.delete(normalize(clientId));
      },
      handleClientDisposed: (clientId) => {
        const normalizedClientId = normalize(clientId);
        if (closed || !normalizedClientId || disposedClientIds.has(normalizedClientId)) return [];
        disposedClientIds.add(normalizedClientId);
        return views.removeClient(normalizedClientId);
      },
      clearConversation: (conversationId) => {
        if (!closed) views.clearConversation(conversationId);
      },
    });
  });
