import { getIntl } from "@/lib/i18n";
/** The platform's name for showing a file in its folder: "Reveal in Finder" on macOS. */
export function revealInFileManagerLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  if (platform.startsWith("Mac"))
    return getIntl().formatMessage({
      id: "lib.revealInFileManagerLabel.finder",
      defaultMessage: "Reveal in Finder",
    });
  if (platform.startsWith("Win"))
    return getIntl().formatMessage({
      id: "lib.revealInFileManagerLabel.explorer",
      defaultMessage: "Reveal in File Explorer",
    });
  return getIntl().formatMessage({
    id: "lib.revealInFileManagerLabel.fileManager",
    defaultMessage: "Reveal in File Manager",
  });
}
