export interface QueuedMessageLockIdentity {
  conversationId: string;
  messageId: string;
  lockId: string;
}
/** Process-wide send exclusion survives peer handoff, with bounded stale-lock recovery. */
export class QueuedMessageLocks {
  private readonly starting = new Set<string>();
  private readonly active = new Map<string, { lockId: string; expiresAtMs: number }>();
  private readonly sent = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  tryAcquireStartTurn(id: string): boolean {
    if (this.starting.has(id)) return false;
    this.starting.add(id);
    return true;
  }
  releaseStartTurn(id: string): void {
    this.starting.delete(id);
  }
  tryAcquire({ conversationId, messageId, lockId }: QueuedMessageLockIdentity): boolean {
    const now = this.now();
    for (const [key, expiresAt] of this.sent) if (expiresAt <= now) this.sent.delete(key);
    if (this.sent.has(`${conversationId}\n${messageId}`)) return false;
    const active = this.active.get(conversationId);
    if (active && active.expiresAtMs > now) return false;
    this.active.set(conversationId, { lockId, expiresAtMs: now + 120_000 });
    return true;
  }
  release({
    conversationId,
    messageId,
    lockId,
    sent,
  }: QueuedMessageLockIdentity & { sent: boolean }): void {
    if (this.active.get(conversationId)?.lockId === lockId) this.active.delete(conversationId);
    if (sent) this.sent.set(`${conversationId}\n${messageId}`, this.now() + 600_000);
  }
}
