function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Keep exception/cleanup boundaries outside components and hooks so React Compiler can compile their handlers. */
export async function runWithCleanup<T>(
  operation: () => Promise<T>,
  {
    cleanup,
    onError,
  }: {
    cleanup?: () => void | Promise<void>;
    onError?: (error: unknown) => T | Promise<T>;
  },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!onError) throw error;
    const recovery = onError(error);
    if (isThenable(recovery)) return await recovery;
    return recovery;
  } finally {
    const disposal = cleanup?.();
    if (isThenable(disposal)) await disposal;
  }
}

/** Keep synchronous exception/cleanup boundaries outside compiled components and hooks. */
export function runSyncWithCleanup<T>(operation: () => T, cleanup: () => void): T {
  try {
    return operation();
  } finally {
    cleanup();
  }
}
