import { DatabaseSync } from "node:sqlite";

/**
 * A running Runtime commits from its own writer thread at any moment, so a test's own connection
 * to its store waits for that lock instead of failing with "database is locked".
 */
export const RUNTIME_DATABASE_BUSY_TIMEOUT_MS = 5_000;

export const openRuntimeDatabase = (path: string) =>
  new DatabaseSync(path, { timeout: RUNTIME_DATABASE_BUSY_TIMEOUT_MS });
