import type { VisualAppearance, VisualCheckResult } from "../../shared/visual/bridge";
import type { VisualSourceContent, VisualSourceReference } from "./VisualSources";

export interface VisualJob {
  source: string;
  appearances: VisualAppearance[];
}

export type VisualWorkerInput =
  | { kind: "render"; job: VisualJob }
  | { kind: "source"; content: VisualSourceContent | null };

export type VisualWorkerOutput =
  | { kind: "source"; reference: VisualSourceReference }
  | { kind: "result"; result: VisualWorkerResult }
  | { kind: "error"; message: string };

export type VisualWorkerResult = Omit<VisualCheckResult, "captures"> & {
  captures: {
    appearance: VisualAppearance;
    hash: string;
    width: number;
    height: number;
    svg: string;
    png: string;
  }[];
};
