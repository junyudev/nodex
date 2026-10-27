import type { WebContents } from "electron";
import type { WebContentsDestructionSubscriptions } from "../../../../src/main/platform/electron/WebContentsDestructionSubscriptions";

export const attach = (
  contents: WebContents,
  subscriptions: WebContentsDestructionSubscriptions["Service"],
  release: () => void,
): (() => void) => {
  contents.once("did-finish-load", release);
  return subscriptions.subscribe(contents, release);
};
