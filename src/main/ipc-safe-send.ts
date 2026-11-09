import { getLogger, type BackendLogger } from "./logging/logger";
import { rendererSpaceParameter } from "../shared/space-ipc-policy";

export interface SafeSendWebContentsLike {
  id?: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface SafeSendWindowLike {
  id?: number;
  isDestroyed(): boolean;
  webContents: SafeSendWebContentsLike;
}

export interface SafeSendOptions {
  logger?: Pick<BackendLogger, "debug" | "warn">;
  meta?: Record<string, unknown>;
  nowMs?: () => number;
  warnRateLimitMs?: number;
}

const DEFAULT_WARN_RATE_LIMIT_MS = 30_000;
const lifecycleSendErrorPattern =
  /(?:Render frame was disposed|WebFrameMain|Object has been destroyed|webContents.*destroy|WebContents.*destroy|Cannot call.*destroyed)/i;
const safeSendLogger = getLogger({ subsystem: "ipc", component: "safe-send" });
const lastWarnByKey = new Map<string, number>();

function resolveLogger(options: SafeSendOptions): Pick<BackendLogger, "debug" | "warn"> {
  return options.logger ?? safeSendLogger;
}

function isLifecycleSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return lifecycleSendErrorPattern.test(message);
}

function shouldWarn(key: string, options: SafeSendOptions): boolean {
  const now = options.nowMs?.() ?? Date.now();
  const lastWarnedAt = lastWarnByKey.get(key) ?? 0;
  const rateLimitMs = options.warnRateLimitMs ?? DEFAULT_WARN_RATE_LIMIT_MS;
  if (now - lastWarnedAt < rateLimitMs) return false;

  lastWarnByKey.set(key, now);
  return true;
}

function baseFields(
  channel: string,
  sender: SafeSendWebContentsLike | null | undefined,
  options: SafeSendOptions,
) {
  return {
    channel,
    webContentsId: sender?.id ?? null,
    ...options.meta,
  };
}

export function safeSendToWebContents(
  sender: SafeSendWebContentsLike | null | undefined,
  channel: string,
  args: readonly unknown[] = [],
  options: SafeSendOptions = {},
): boolean {
  const logger = resolveLogger(options);
  if (!sender || sender.isDestroyed()) {
    logger.debug("Skipped IPC send to destroyed webContents", baseFields(channel, sender, options));
    return false;
  }

  try {
    sender.send(channel, ...args);
    return true;
  } catch (error) {
    const fields = {
      ...baseFields(channel, sender, options),
      error: error instanceof Error ? error.message : String(error),
    };
    if (isLifecycleSendError(error)) {
      logger.debug("Skipped IPC send during renderer lifecycle race", fields);
      return false;
    }

    const warnKey = `${channel}:${fields.webContentsId}:${fields.error}`;
    if (shouldWarn(warnKey, options)) {
      logger.warn("IPC send failed", fields);
    }
    return false;
  }
}

export function safeSendToWindow(
  window: SafeSendWindowLike | null | undefined,
  channel: string,
  args: readonly unknown[] = [],
  options: SafeSendOptions = {},
): boolean {
  const logger = resolveLogger(options);
  if (!window || window.isDestroyed()) {
    logger.debug("Skipped IPC send to destroyed window", {
      channel,
      windowId: window?.id ?? null,
      ...options.meta,
    });
    return false;
  }

  return safeSendToWebContents(window.webContents, channel, args, {
    ...options,
    logger,
    meta: {
      windowId: window.id ?? null,
      ...options.meta,
    },
  });
}

export function safeBroadcastToWindows(
  windows: Iterable<SafeSendWindowLike>,
  channel: string,
  args: readonly unknown[] = [],
  options: SafeSendOptions = {},
): number {
  let sentCount = 0;
  for (const window of windows) {
    if (safeSendToWindow(window, channel, args, options)) {
      sentCount += 1;
    }
  }
  return sentCount;
}

export function resetSafeSendWarningRateLimitForTests(): void {
  lastWarnByKey.clear();
}

/** Personal producers cannot publish their resource identities into team renderers. */
export function safeBroadcastToPersonalWindows(
  windows: Iterable<
    SafeSendWindowLike & { webContents: SafeSendWebContentsLike & { getURL(): string } }
  >,
  channel: string,
  args: readonly unknown[] = [],
  options: SafeSendOptions = {},
): number {
  let sentCount = 0;
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    if (rendererSpaceParameter(window.webContents.getURL()) !== null) continue;
    if (safeSendToWindow(window, channel, args, options)) sentCount += 1;
  }
  return sentCount;
}
