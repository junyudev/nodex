export interface FileOpenApplication {
  name: string;
  appPath: string;
  iconDataUrl: string | null;
}

export interface FileOpenApplicationsInput {
  path: string;
}

export interface FileOpenApplicationsResult {
  /** The app a file opens in by default: its type's well-known viewer when installed, else the system default. */
  defaultApplication: FileOpenApplication | null;
  /** Other apps that can open the file, in system order. */
  applications: FileOpenApplication[];
}

export interface OpenFileWithApplicationInput extends FileOpenApplicationsInput {
  appPath: string;
}

const PREVIEW = ["com.apple.Preview"];
const QUICKTIME = ["com.apple.QuickTimePlayerX"];
const ARCHIVE_UTILITY = ["com.apple.archiveutility"];
const WORD = ["com.microsoft.Word", "com.apple.iWork.Pages"];
const EXCEL = ["com.microsoft.Excel", "com.apple.iWork.Numbers"];
const POWERPOINT = ["com.microsoft.Powerpoint", "com.apple.iWork.Keynote"];

/** The viewer a file type is expected to open in, ahead of whatever claimed the default. */
const PRIORITIZED_BUNDLE_IDS = new Map<string, readonly string[]>([
  ...["pdf", "png", "jpg", "jpeg", "gif", "bmp", "tiff", "ico", "webp"].map(
    (extension) => [extension, PREVIEW] as const,
  ),
  ...[
    "mov",
    "mp4",
    "m4v",
    "avi",
    "mkv",
    "webm",
    "mpg",
    "mpeg",
    "mp3",
    "wav",
    "m4a",
    "aac",
    "aiff",
    "aif",
    "flac",
    "caf",
  ].map((extension) => [extension, QUICKTIME] as const),
  ...["zip", "tar", "gz", "tgz", "bz2", "tbz", "xz", "txz", "7z", "rar"].map(
    (extension) => [extension, ARCHIVE_UTILITY] as const,
  ),
  ["sketch", ["com.bohemiancoding.sketch3"]],
  ["fig", ["com.figma.Desktop"]],
  ["psd", ["com.adobe.Photoshop"]],
  ["ai", ["com.adobe.illustrator"]],
  ["indd", ["com.adobe.InDesign"]],
  ["xd", ["com.adobe.xd"]],
  ["doc", WORD],
  ["docx", WORD],
  ["xls", EXCEL],
  ["xlsm", EXCEL],
  ["xlsx", EXCEL],
  ["csv", EXCEL],
  ["ppt", POWERPOINT],
  ["pptx", POWERPOINT],
  ["key", ["com.apple.iWork.Keynote"]],
  ["pages", ["com.apple.iWork.Pages"]],
  ["numbers", ["com.apple.iWork.Numbers"]],
]);

export function prioritizedBundleIdsForFile(filePath: string): readonly string[] {
  const extension = /\.([^./]+)$/u.exec(filePath.replaceAll("\\", "/"))?.[1]?.toLowerCase() ?? "";
  return PRIORITIZED_BUNDLE_IDS.get(extension) ?? [];
}

export function usesNativeFileOpenApplications(path: string): boolean {
  return prioritizedBundleIdsForFile(path).length > 0 || /\.html?$/iu.test(path);
}
