import type { Locale } from "../lib/locale";

/**
 * Each demo's designed size, shared by its Stage and by the capture pages, where it renders alone
 * for recording. Plain data so the Node recorder can read it without loading React.
 */
export const CAPTURE_DEMOS = {
  hero: { width: 1180, height: 680 },
  fanout: { width: 640, height: 540 },
  agents: { width: 640, height: 540 },
  pages: { width: 1180, height: 700 },
  tidy: { width: 1180, height: 700 },
  mobile: { width: 640, height: 570 },
} as const;

export type CaptureDemoId = keyof typeof CAPTURE_DEMOS;

export function captureDemoPath(demo: CaptureDemoId, locale: Locale): string {
  const prefix = locale === "zh-CN" ? "zh-cn/" : "";
  return `${prefix}capture/${demo}/`;
}

/** What a demo playing under `?capture` exposes for the recorder. */
export interface CaptureHandle {
  readonly durationMs: number;
  /** Resolves when the single capture playthrough reaches its end. */
  readonly done: Promise<void>;
}

declare global {
  interface Window {
    __nodexCapture?: CaptureHandle;
  }
}
