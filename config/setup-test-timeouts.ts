import { vi } from "vite-plus/test";
import { ASYNC_WAIT_TIMEOUT_MS } from "./test-timeouts";

// Vitest config covers expect.poll. The vi helpers only accept per-call options.
const { waitFor, waitUntil } = vi;

function withDefaultTimeout(options: Parameters<typeof waitFor>[1]) {
  if (typeof options === "number" || options?.timeout !== undefined) return options;
  return { ...options, timeout: ASYNC_WAIT_TIMEOUT_MS };
}

vi.waitFor = (callback, options) => waitFor(callback, withDefaultTimeout(options));
vi.waitUntil = (callback, options) => waitUntil(callback, withDefaultTimeout(options));
