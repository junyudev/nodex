import type { FileLinkOpenerId, FileLinkTarget } from "../../shared/file-link-openers";
import { FILE_LINK_OPENER_OPTIONS, getFileManagerName } from "../../shared/file-link-openers";
import {
  listAvailableFileLinkOpeners,
  openFileLink,
  openFileWithApplication,
  openPathWithDefaultApplication,
  readFileOpenApplications,
} from "./file-system-operations";
import { readFileLinkOpener } from "./file-link-opener-settings";
import { usesNativeFileOpenApplications } from "../../shared/file-open-applications";

export interface NativeMenuTarget {
  readonly id: string;
  readonly label: string;
  readonly iconUrl?: string;
  readonly opener?: FileLinkOpenerId;
  readonly appPath?: string;
  readonly systemDefault?: true;
}

/** Installed native viewers take precedence; editor targets retain the user's preferred opener. */
export async function readFileReferenceOpenTargets(path: string): Promise<{
  readonly primary: NativeMenuTarget | null;
  readonly alternatives: NativeMenuTarget[];
}> {
  const nativeMode = usesNativeFileOpenApplications(path);
  const fileManagerName = getFileManagerName(
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const [native, available] = await Promise.all([
    nativeMode ? readFileOpenApplications(path).catch(() => null) : Promise.resolve(null),
    listAvailableFileLinkOpeners().catch((): FileLinkOpenerId[] => []),
  ]);
  const nativeApps = native
    ? [native.defaultApplication, ...native.applications].filter((app) => app !== null)
    : [];
  if (nativeApps.length > 0) {
    const alternatives = nativeApps.map((app) => ({
      id: `application:${app.appPath}`,
      label: app.name,
      appPath: app.appPath,
      ...(app.iconDataUrl ? { iconUrl: app.iconDataUrl } : {}),
    }));
    return { primary: alternatives[0] ?? null, alternatives };
  }
  if (nativeMode) {
    const fileManager = FILE_LINK_OPENER_OPTIONS.find((option) => option.id === "fileManager")!;
    const alternatives: NativeMenuTarget[] = [
      { id: "systemDefault", label: "Default app", systemDefault: true },
      { id: fileManager.id, label: fileManagerName, opener: fileManager.id },
    ];
    return {
      primary:
        alternatives.find((target) => target.opener === readFileLinkOpener()) ??
        alternatives[0] ??
        null,
      alternatives,
    };
  }
  const alternatives = FILE_LINK_OPENER_OPTIONS.filter((option) =>
    available.includes(option.id),
  ).map((option) => ({
    id: option.id,
    label: option.id === "fileManager" ? fileManagerName : option.label,
    opener: option.id,
  }));
  const preferred = readFileLinkOpener();
  return {
    primary: alternatives.find((option) => option.opener === preferred) ?? alternatives[0] ?? null,
    alternatives,
  };
}

export async function openFileReferenceTarget(
  target: NativeMenuTarget,
  file: FileLinkTarget,
): Promise<boolean> {
  if (target.appPath) return openFileWithApplication({ path: file.path, appPath: target.appPath });
  if (target.systemDefault) return openPathWithDefaultApplication(file.path);
  if (target.opener) return openFileLink(file, target.opener);
  return false;
}
