/** View lifetimes retain activity independently, including across removal and reacquisition. */
export class ConversationActivity {
  private readonly interests = new Map<string, Set<symbol>>();

  constructor(
    private readonly onActivityChanged: (conversationId: string, active: boolean) => void,
  ) {}

  has(conversationId: string): boolean {
    return this.interests.has(conversationId);
  }

  retain(conversationId: string): Disposable {
    const interests = this.interests.get(conversationId) ?? new Set<symbol>();
    this.interests.set(conversationId, interests);
    const token = Symbol();
    interests.add(token);
    if (interests.size === 1) this.onActivityChanged(conversationId, true);
    return {
      [Symbol.dispose]: () => {
        if (this.interests.get(conversationId) !== interests) return;
        if (!interests.delete(token) || interests.size !== 0) return;
        this.interests.delete(conversationId);
        this.onActivityChanged(conversationId, false);
      },
    };
  }

  remove(conversationId: string): void {
    this.interests.delete(conversationId);
  }

  clear(): void {
    this.interests.clear();
  }
}
