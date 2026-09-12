interface PresentedRendererView {
  readonly clientId: string;
  readonly presentationOrder: number;
}

/**
 * Tracks which renderer clients are currently presenting a conversation.
 *
 * This is intentionally independent from conversation stream ownership. A
 * main-owned or follower-rendered conversation can still present local UI such
 * as a Nodex authorization request without becoming the canonical state owner.
 */
export class CodexRendererViewRegistry {
  private presentationOrder = 0;
  private readonly foregroundClientIds = new Set<string>();
  private readonly presentedSurfaceIdsByConversationAndClient = new Map<
    string,
    Map<string, Set<string>>
  >();
  private readonly presentedViewsByConversationId = new Map<
    string,
    Map<string, PresentedRendererView>
  >();

  isClientPresenting(conversationId: string, clientId: string): boolean {
    return (
      this.presentedSurfaceIdsByConversationAndClient
        .get(conversationId.trim())
        ?.has(clientId.trim()) === true
    );
  }

  setPresented(
    conversationId: string,
    clientId: string,
    surfaceId: string,
    presented: boolean,
  ): void {
    const normalizedConversationId = conversationId.trim();
    const normalizedClientId = clientId.trim();
    const normalizedSurfaceId = surfaceId.trim();
    if (!normalizedConversationId || !normalizedClientId || !normalizedSurfaceId) return;

    if (!presented) {
      const surfacesByClient =
        this.presentedSurfaceIdsByConversationAndClient.get(normalizedConversationId);
      const surfaceIds = surfacesByClient?.get(normalizedClientId);
      if (!surfaceIds?.delete(normalizedSurfaceId)) return;
      if (surfaceIds.size === 0) {
        surfacesByClient?.delete(normalizedClientId);
        this.removePresentedView(normalizedConversationId, normalizedClientId);
      }
      if (surfacesByClient?.size === 0) {
        this.presentedSurfaceIdsByConversationAndClient.delete(normalizedConversationId);
      }
      return;
    }

    const surfacesByClient =
      this.presentedSurfaceIdsByConversationAndClient.get(normalizedConversationId) ??
      new Map<string, Set<string>>();
    const surfaceIds = surfacesByClient.get(normalizedClientId) ?? new Set<string>();
    const wasClientPresented = surfaceIds.size > 0;
    surfaceIds.add(normalizedSurfaceId);
    surfacesByClient.set(normalizedClientId, surfaceIds);
    this.presentedSurfaceIdsByConversationAndClient.set(normalizedConversationId, surfacesByClient);
    if (!wasClientPresented) {
      const presentedViews =
        this.presentedViewsByConversationId.get(normalizedConversationId) ??
        new Map<string, PresentedRendererView>();
      this.presentationOrder += 1;
      presentedViews.set(normalizedClientId, {
        clientId: normalizedClientId,
        presentationOrder: this.presentationOrder,
      });
      this.presentedViewsByConversationId.set(normalizedConversationId, presentedViews);
    }
  }

  setClientForegrounded(clientId: string, foregrounded: boolean): string[] {
    const normalizedClientId = clientId.trim();
    if (!normalizedClientId) return [];

    if (foregrounded) {
      this.foregroundClientIds.add(normalizedClientId);
    } else {
      this.foregroundClientIds.delete(normalizedClientId);
    }

    const affectedConversationIds: string[] = [];
    for (const [conversationId, surfacesByClient] of this
      .presentedSurfaceIdsByConversationAndClient) {
      if (surfacesByClient.has(normalizedClientId)) {
        affectedConversationIds.push(conversationId);
      }
    }
    return affectedConversationIds;
  }

  isPresentedInForeground(conversationId: string): boolean {
    const surfacesByClient = this.presentedSurfaceIdsByConversationAndClient.get(
      conversationId.trim(),
    );
    if (!surfacesByClient) return false;
    for (const clientId of surfacesByClient.keys()) {
      if (this.foregroundClientIds.has(clientId)) return true;
    }
    return false;
  }

  hasForegroundClient(): boolean {
    return this.foregroundClientIds.size > 0;
  }

  resolvePresentedSurfaceClient(conversationId: string): string | null {
    const views = this.presentedViewsByConversationId.get(conversationId.trim());
    if (!views) return null;

    let latest: PresentedRendererView | null = null;
    for (const view of views.values()) {
      if (!latest || view.presentationOrder > latest.presentationOrder) {
        latest = view;
      }
    }
    return latest?.clientId ?? null;
  }

  removeClient(clientId: string): string[] {
    const normalizedClientId = clientId.trim();
    if (!normalizedClientId) return [];
    this.foregroundClientIds.delete(normalizedClientId);

    const affectedConversationIds = new Set<string>();
    for (const [conversationId, surfacesByClient] of this
      .presentedSurfaceIdsByConversationAndClient) {
      if (!surfacesByClient.delete(normalizedClientId)) continue;
      affectedConversationIds.add(conversationId);
      this.removePresentedView(conversationId, normalizedClientId);
      if (surfacesByClient.size === 0) {
        this.presentedSurfaceIdsByConversationAndClient.delete(conversationId);
      }
    }
    return [...affectedConversationIds];
  }

  clearConversation(conversationId: string): void {
    const normalizedConversationId = conversationId.trim();
    this.presentedSurfaceIdsByConversationAndClient.delete(normalizedConversationId);
    this.presentedViewsByConversationId.delete(normalizedConversationId);
  }

  reset(): void {
    this.presentationOrder = 0;
    this.foregroundClientIds.clear();
    this.presentedSurfaceIdsByConversationAndClient.clear();
    this.presentedViewsByConversationId.clear();
  }

  private removePresentedView(conversationId: string, clientId: string): void {
    const views = this.presentedViewsByConversationId.get(conversationId);
    if (!views?.delete(clientId)) return;
    if (views.size === 0) this.presentedViewsByConversationId.delete(conversationId);
  }
}
