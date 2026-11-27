import { invokeRendererControl } from "../../lib/renderer-command";
import type {
  VisualAppearance,
  VisualPageContext,
  VisualPreviewInput,
  VisualQueryRefreshInput,
  VisualQueryRefreshResult,
} from "../../../shared/visual/bridge";

export const visualAdapter = {
  admit: () => invokeRendererControl("app:visual:admit"),
  release: (grant: string) => invokeRendererControl("app:visual:release", grant),
  render: (input: VisualPreviewInput) => invokeRendererControl("app:visual:render", input),
  capture: (source: string, page: VisualPageContext | null, appearances: VisualAppearance[]) =>
    invokeRendererControl("visual:capture", source, page, appearances),
  resolveSources: (source: string, page: VisualPageContext | null) =>
    invokeRendererControl("visual:resolve-sources", source, page),
};

/** Reads the current result with the Page's authority. The caller owns the document edit. */
export const refreshVisualQuery = (
  input: VisualQueryRefreshInput,
): Promise<VisualQueryRefreshResult> =>
  invokeRendererControl("visual:refresh-query", input).catch(() => ({
    ok: false,
    code: "query-failed",
    message: "The Visual query is unavailable",
  }));
