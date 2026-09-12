/** Pending manual requests outlive the request response until native item/started consumes them. */
export class CodexManualCompactions {
  private readonly counts = new Map<string, number>();
  hasPending(threadId: string): boolean {
    return this.counts.has(threadId);
  }
  register(threadId: string): void {
    this.counts.set(threadId, (this.counts.get(threadId) ?? 0) + 1);
  }
  remove(threadId: string): boolean {
    const count = this.counts.get(threadId);
    if (count === undefined) return false;
    if (count > 1) {
      this.counts.set(threadId, count - 1);
      return false;
    }
    this.counts.delete(threadId);
    return true;
  }
  consumeSource(threadId: string): "manual" | "automatic" {
    if (!this.counts.has(threadId)) return "automatic";
    this.remove(threadId);
    return "manual";
  }
  clear(threadId: string): void {
    this.counts.delete(threadId);
  }
  clearAll(): void {
    this.counts.clear();
  }
}
