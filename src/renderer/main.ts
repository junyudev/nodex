import markdownWasmUrl from "../shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm?url";
import { initMarkdown } from "../shared/nodex-markdown";
import { initializeRendererDocument } from "./bootstrap/renderer-document";
import { startStartupController } from "./bootstrap/startup-controller";

const isGlobalDictationRenderer = (): boolean =>
  new URLSearchParams(window.location.search).get("initialRoute") === "/global-dictation";

const isAvatarOverlayRenderer = (): boolean =>
  new URLSearchParams(window.location.search).get("initialRoute") === "/avatar-overlay";

void initMarkdown(markdownWasmUrl).then(() => {
  initializeRendererDocument();

  if (isAvatarOverlayRenderer()) {
    void import("./avatar-overlay-renderer").then(({ mountAvatarOverlayRenderer }) => {
      mountAvatarOverlayRenderer();
    });
  } else if (isGlobalDictationRenderer()) {
    void import("./global-dictation-renderer").then(({ mountGlobalDictationRenderer }) => {
      mountGlobalDictationRenderer();
    });
  } else {
    startStartupController();
  }
});
