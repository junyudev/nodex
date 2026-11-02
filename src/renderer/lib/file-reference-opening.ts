import { isBrowserHtmlFilePath } from "../../shared/browser-url-policy";
import type { FileLinkTarget } from "../../shared/file-link-openers";
import type { LinkActivation } from "../../shared/link-opening";

export type FileReferenceOpenDecision = "save" | "file-manager" | "browser" | "files" | "native";

/** Files use their source intent, not the URL destination preferences. */
export function decideFileReferenceOpen(input: {
  readonly target: FileLinkTarget;
  readonly hostId: string;
  readonly browserAvailable: boolean;
  readonly sidePanel?: boolean;
  readonly directory?: boolean;
  readonly explicitTarget?: boolean;
  readonly previewSource?: boolean;
  readonly activation?: LinkActivation;
}): FileReferenceOpenDecision {
  const { target, activation } = input;
  const directory = input.directory ?? /[\\/]$/u.test(target.path);
  if (directory) return "file-manager";
  if (
    activation?.altKey &&
    !activation.metaKey &&
    !activation.ctrlKey &&
    !activation.shiftKey &&
    (activation.button ?? 0) === 0
  )
    return "save";
  if (input.explicitTarget) return "native";
  if (input.previewSource) return "files";
  const primary = activation?.platform === "darwin" ? activation.metaKey : activation?.ctrlKey;
  const modified = activation?.button === 1 || primary === true;
  const localHtml =
    input.hostId === "local" && isBrowserHtmlFilePath(target.path) && input.browserAvailable;
  if (input.sidePanel !== false && modified && localHtml) return "files";
  if (modified) return "native";
  if (localHtml && !target.line) return "browser";
  return input.sidePanel === false ? "native" : "files";
}
