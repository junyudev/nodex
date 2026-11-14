/** The platform's name for showing a file in its folder: "Reveal in Finder" on macOS. */
export function revealInFileManagerLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  if (platform.startsWith("Mac")) return "Reveal in Finder";
  if (platform.startsWith("Win")) return "Reveal in File Explorer";
  return "Reveal in File Manager";
}
