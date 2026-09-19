/** Archive visibility outlives the resident document; marker identity fences preview reads. */
export class CanonicalConversationArchiveState {
  private readonly markers = new Map<string, { readonly archived: boolean }>();

  isSuppressed(conversationId: string): boolean {
    return this.markers.get(conversationId)?.archived === true;
  }

  suppressedIds(): string[] {
    return [...this.markers].flatMap(([id, marker]) => (marker.archived ? [id] : []));
  }

  /** Returns whether visibility changed. Even repeated suppression retires an older preview. */
  suppress(conversationId: string): boolean {
    const wasSuppressed = this.isSuppressed(conversationId);
    this.markers.set(conversationId, { archived: true });
    return !wasSuppressed;
  }

  unsuppress(conversationId: string): void {
    this.markers.set(conversationId, { archived: false });
  }

  clear(): void {
    this.markers.clear();
  }

  async hydratePreview(
    conversationId: string,
    callbacks: {
      /** Resident conversation or raw Thread metadata means an ordinary loaded thread. */
      readonly hasOrdinaryState: () => boolean;
      readonly hasConversation: () => boolean;
      readonly hasPreviewHistory: () => boolean;
      readonly onSuppressed: () => void;
      /** The owner must check isCurrent together with its hydration generation before applying. */
      readonly hydrate: (isCurrent: () => boolean) => Promise<void>;
    },
  ): Promise<boolean> {
    const previous = this.markers.get(conversationId);
    if (previous?.archived === false || (previous === undefined && callbacks.hasOrdinaryState()))
      return false;
    if (previous === undefined) {
      this.suppress(conversationId);
      callbacks.onSuppressed();
    }
    const marker = this.markers.get(conversationId);
    const isCurrent = () => this.markers.get(conversationId) === marker;
    if (callbacks.hasPreviewHistory()) return true;
    await callbacks.hydrate(isCurrent);
    if (!isCurrent()) return false;
    if (!callbacks.hasConversation()) throw new Error("Could not load archived task");
    return true;
  }
}
