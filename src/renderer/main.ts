import { initializeRendererDocument } from "./bootstrap/renderer-document";
import { startStartupController } from "./bootstrap/startup-controller";

initializeRendererDocument();

const initialRoute = new URLSearchParams(window.location.search).get("initialRoute");
if (initialRoute === "/avatar-overlay") {
  void import("./avatar-overlay-renderer").then(({ mountAvatarOverlayRenderer }) => {
    mountAvatarOverlayRenderer();
  });
} else if (initialRoute === "/global-dictation") {
  void import("./global-dictation-renderer").then(({ mountGlobalDictationRenderer }) => {
    mountGlobalDictationRenderer();
  });
} else {
  startStartupController();
}
