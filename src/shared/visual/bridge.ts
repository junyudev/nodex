import type {
  VisualDiagnostic,
  VisualKey,
  VisualParamValues,
  VisualRow,
  VisualRows,
  VisualSpan,
} from "./contract";

export const VISUAL_SCHEME = "nodex-visual";
export const VISUAL_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  corsEnabled: true,
  supportFetchAPI: true,
} as const;
export const VISUAL_PARTITION_PREFIX = "nodex-visual:";
export type VisualAppearance = "light" | "dark";

export interface VisualTheme {
  appearance: VisualAppearance;
  variables: Record<string, string>;
}

export interface VisualRenderRequest {
  revision: number;
  modulePath: string;
  sources: VisualRows;
  keys: Record<string, string | string[]>[];
  params: VisualParamValues;
  theme: VisualTheme;
}

export interface VisualRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualDatumGeometry {
  figure: number;
  source: string;
  key: VisualKey;
  field?: string;
  span?: VisualSpan;
  rect: VisualRect;
}

export interface VisualTextGeometry {
  span: VisualSpan;
  rect: VisualRect;
}

export interface VisualRenderFrame {
  revision: number;
  width: number;
  height: number;
  datum: VisualDatumGeometry[];
  text: VisualTextGeometry[];
  diagnostics: VisualDiagnostic[];
  svg: string;
}

export type VisualRenderReply =
  | { status: "rendered"; frame: VisualRenderFrame }
  | {
      status: "error";
      revision: number;
      message: string;
      location?: { line: number; column: number };
    };

export interface VisualGrant {
  grant: string;
  url: string;
  partition: string;
}

export function defaultVisualTheme(appearance: VisualAppearance): VisualTheme {
  const dark = appearance === "dark";
  return {
    appearance,
    variables: {
      "--background": dark ? "#212121" : "#ffffff",
      "--foreground": dark ? "#f5f5f5" : "#171717",
      "--muted-foreground": dark ? "#b4b4b4" : "#616161",
      "--border": dark ? "#585858" : "#d6d6d6",
      "--primary": dark ? "#83c3ff" : "#2563aa",
      "--viz-series-1": dark ? "#83c3ff" : "#2563aa",
      "--viz-series-2": dark ? "#f08fc0" : "#a83a76",
      "--viz-series-3": dark ? "#74d58b" : "#2d7746",
      "--viz-series-4": dark ? "#f59a55" : "#a35425",
      "--viz-series-5": dark ? "#aa91ef" : "#754eb2",
      "--viz-series-6": dark ? "#59cbc2" : "#1b746e",
      "--font-sans": "system-ui, sans-serif",
      "--font-mono": "ui-monospace, monospace",
      "--font-size-base": "13px",
    },
  };
}

export interface VisualPageContext {
  pageId: string;
  routingContext: import("../content-routing-context").ContentRoutingContext;
}

export interface VisualPreviewInput {
  grant: string;
  source: string;
  rows: VisualRows;
  theme: VisualTheme;
}

export type VisualPreviewResult =
  | { status: "rendered"; frame: VisualRenderFrame; diagnostics: VisualDiagnostic[] }
  | { status: "renew" }
  | { status: "error"; diagnostics: VisualDiagnostic[]; retired?: true };

export interface VisualCapture {
  appearance: VisualAppearance;
  hash: string;
  frame: VisualRenderFrame;
  png: Uint8Array;
}

export interface VisualCheckResult {
  diagnostics: (VisualDiagnostic & { appearance?: VisualAppearance })[];
  captures: VisualCapture[];
}

export interface VisualCaptureResult extends VisualCheckResult {
  resolved?: { captions: string[]; rows: VisualRows };
}

export interface VisualQueryRefreshInput {
  source: string;
  page: VisualPageContext;
  figure: number;
  sourceName: string;
}

export type VisualQueryRefreshResult =
  | { ok: true; rows: VisualRow[]; refreshedAt: string }
  | {
      ok: false;
      code:
        | "invalid-source"
        | "page-unavailable"
        | "query-failed"
        | "invalid-result"
        | "result-too-large";
      message: string;
    };
