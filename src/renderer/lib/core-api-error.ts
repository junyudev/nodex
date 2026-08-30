import { isCursorRejectionCode, type CoreErrorDetail } from "../../shared/core-result";

/** Typed failure of a Core-backed read or renderer command channel. */
export class CoreApiError extends Error {
  constructor(readonly detail: CoreErrorDetail) {
    super(detail.message);
    this.name = "CoreApiError";
  }

  get code(): string {
    return this.detail.code;
  }

  get retryable(): boolean {
    return this.detail.retryable;
  }

  get recovery(): CoreErrorDetail["recovery"] {
    return this.detail.recovery;
  }

  isCursorRejection(options: { readonly requestHadCursor: boolean }): boolean {
    return isCursorRejectionCode(this.detail.code, options);
  }
}
