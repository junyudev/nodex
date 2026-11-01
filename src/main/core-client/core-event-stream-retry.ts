import { CoreEventCompatibilityError, CoreHttpError } from "./local-http";

/** Shared retry classification for document and canvas SSE adapters. */
export const isRetryableCoreEventStreamError = (error: unknown): boolean => {
  if (error instanceof CoreEventCompatibilityError) return false;
  if (!(error instanceof CoreHttpError)) return true;
  return error.status === 409 || error.status === 429 || error.status >= 500;
};
