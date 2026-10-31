import { buildAppFilesystemUrl } from "../../../shared/app-protocol";
import { parseAssetSource } from "../../../shared/assets";
import { parseLocalImagePath } from "../../../shared/image-source";
import { resolveAssetSourceToDisplayUrl } from "../assets";
import { isCodexImageAssetPointer } from "./codex-image-pointers";

export type ImageAssetSourceKind =
  | "data"
  | "local"
  | "managed"
  | "pointer"
  | "remote"
  | "direct"
  | "invalid";

export interface ClassifiedImageAssetSource {
  kind: ImageAssetSourceKind;
  localPath: string | null;
  source: string;
}

export function classifyImageAssetSource(rawSource: string): ClassifiedImageAssetSource {
  const source = rawSource.trim();
  if (!source) return { kind: "invalid", localPath: null, source };
  if (/^data:image\//iu.test(source)) return { kind: "data", localPath: null, source };
  if (isCodexImageAssetPointer(source)) {
    return { kind: "pointer", localPath: null, source };
  }
  if (parseAssetSource(source)) {
    return { kind: "managed", localPath: null, source };
  }

  const localPath = parseLocalImagePath(source);
  if (localPath) return { kind: "local", localPath, source };
  if (/^https?:\/\//iu.test(source)) return { kind: "remote", localPath: null, source };
  if (/^(?:app:|blob:|nodex-display:|vscode-remote:)/iu.test(source)) {
    return { kind: "direct", localPath: null, source };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) {
    return { kind: "invalid", localPath: null, source };
  }
  return { kind: "direct", localPath: null, source };
}

export function resolveImageDisplaySource(
  rawSource: string,
  options: {
    allowLocalPath: boolean;
    resolveManagedAssetPath?: (source: string) => string | null;
  },
): string | null {
  const classified = classifyImageAssetSource(rawSource);
  switch (classified.kind) {
    case "data":
    case "remote":
    case "direct":
      return classified.source;
    case "managed":
      return resolveAssetSourceToDisplayUrl(classified.source, options.resolveManagedAssetPath);
    case "local":
      return options.allowLocalPath && classified.localPath
        ? buildAppFilesystemUrl(classified.localPath)
        : null;
    case "pointer":
    case "invalid":
      return null;
  }
}
