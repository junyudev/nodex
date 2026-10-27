import { makeWebContentsDestructionSubscriptions } from "../../../../src/main/platform/electron/WebContentsDestructionSubscriptions";
import type { WebContents } from "electron";

export const attach = (contents: WebContents, release: () => void): void => {
  contents.on("destroyed", release);
  contents.once?.("destroyed", release);
  contents["addListener"]("destroyed", release);
  contents.prependListener(`destroyed`, release);
  contents.prependOnceListener("destroyed", release);
  contents.off("destroyed", release);
  contents.removeListener("destroyed", release);
};

export const privateRegistry = makeWebContentsDestructionSubscriptions;
