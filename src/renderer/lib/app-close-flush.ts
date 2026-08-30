import { notifyAppCloseFlushComplete, readAppCloseBridge } from "./app-close-flush-deps";

export type AppCloseFlushHandler = () => Promise<void> | void;

const handlers = new Set<AppCloseFlushHandler>();
let coordinatorRegistered = false;

async function flushHandlers(): Promise<void> {
  const pending = Array.from(handlers, (handler) => Promise.resolve().then(() => handler()));
  await Promise.allSettled(pending);
}

function ensureCoordinatorRegistered(): void {
  if (coordinatorRegistered) return;
  const bridge = readAppCloseBridge();
  if (!bridge) return;

  coordinatorRegistered = true;
  bridge.on("app:flush-before-close", (...args: unknown[]) => {
    const webContentsId = typeof args[0] === "number" ? args[0] : -1;
    void flushHandlers().finally(() => {
      void notifyAppCloseFlushComplete(webContentsId);
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
