import type { RpcTransportWithCustomEncoding } from "capnweb";

export interface ConversationServicePort {
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/** MessagePort's structured-clone transport for bidirectional conversation service calls. */
export class ConversationServicePortTransport implements RpcTransportWithCustomEncoding {
  readonly encodingLevel = "structuredClonable" as const;
  private readonly messages: unknown[] = [];
  private pending: { resolve: (message: unknown) => void; reject: (error: Error) => void } | null =
    null;
  private error: Error | null = null;
  private aborted = false;

  constructor(private readonly port: ConversationServicePort) {
    port.start();
    port.on("message", ({ data }) => {
      if (this.error) return;
      if (data === null) {
        this.fail(new Error("Peer closed MessagePort connection."));
        return;
      }
      if (!this.pending) {
        this.messages.push(data);
        return;
      }
      this.pending.resolve(data);
      this.pending = null;
    });
    port.on("close", () => this.fail(new Error("MessagePort message error.")));
  }

  send(message: unknown): void {
    if (this.error) throw this.error;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort sends to its paired endpoint, not a Window origin.
    this.port.postMessage(message);
  }

  receive(): Promise<unknown> {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  abort(error: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.fail(error instanceof Error ? error : new Error(String(error)));
    this.messages.length = 0;
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no targetOrigin parameter.
      this.port.postMessage(null);
    } catch {
      /* The peer may already have closed its port. */
    }
    this.port.close();
  }

  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    this.pending?.reject(error);
    this.pending = null;
  }
}
