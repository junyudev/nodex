/** Promise-facing JSON-RPC error used only by external conformance/probe boundaries. */
// @effect-diagnostics-next-line extendsNativeError:off -- External Promise callers require Error identity; this type never enters an Effect failure channel.
export class CodexRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly retryable: boolean;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
    this.retryable = code === -32_001;
  }
}
