import { createContext, useContext } from "react";
import type { PageDiscussionsController } from "./use-page-discussions-controller";

/**
 * The open Page's Discussions owner, for views placed in different parts of the Page Stage: the
 * toolbar control, the margin beside the body, and the composer inside the editor.
 */
export const PageDiscussionsControllerContext = createContext<PageDiscussionsController | null>(
  null,
);

export function usePageDiscussionsControllerContext(): PageDiscussionsController | null {
  return useContext(PageDiscussionsControllerContext);
}
