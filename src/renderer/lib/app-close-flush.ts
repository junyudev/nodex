import { invoke } from "./api";

export type AppCloseFlushHandler = () => Promise<void> | void;

const handlers = new Set<AppCloseFlushHandler>();
let coordinatorRegistered = false;

async function flushHandlers(): Promise<void> {
  const pending = Array.from(handlers, (handler) => Promise.resolve().then(() => handler()));
  await Promise.allSettled(pending);
}

function ensureCoordinatorRegistered(): void {
  if (coordinatorRegistered) return;
  if (typeof window === "undefined" || !window.api) return;

  coordinatorRegistered = true;
  window.api.on("app:flush-before-close", (...args: unknown[]) => {
    const webContentsId = typeof args[0] === "number" ? args[0] : -1;
    void flushHandlers().finally(() => {
      void invoke("app:flush-before-close:done", webContentsId);
    });
  });
}

export function registerAppCloseFlushHandler(handler: AppCloseFlushHandler): () => void {
  handlers.add(handler);
  ensureCoordinatorRegistered();
  return () => {
    handlers.delete(handler);
  };
}

export const appCloseFlushTestHelpers = {
  flushHandlers,
};
