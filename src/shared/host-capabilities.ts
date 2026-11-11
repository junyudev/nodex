/** Host integration policy. Callers supply the immutable bootstrap platform snapshot. */
export const hostCapabilities = (
  platform: string,
  architecture?: string,
  desktopTools?: { readonly browserReady?: boolean; readonly computerUseReady?: boolean },
) => {
  const mac = platform === "darwin";
  const windows =
    platform === "win32" &&
    (architecture === undefined || architecture === "x64" || architecture === "arm64");
  return Object.freeze({
    backgroundService: mac,
    autoUpdate:
      (mac && (architecture === undefined || architecture === "arm64")) ||
      (platform === "win32" &&
        (architecture === undefined || architecture === "x64" || architecture === "arm64")),
    browserControl: mac || (windows && desktopTools?.browserReady === true),
    browserProfileImport: mac,
    computerControl: mac || (windows && desktopTools?.computerUseReady === true),
    nativePip: mac,
    appshot: mac,
    deviceCheck: mac && architecture === "arm64",
    nativeClipboard: mac,
    nativeNotificationAuthorization: mac,
    dictationBackend: mac ? ("macos" as const) : platform === "win32" ? ("windows" as const) : null,
    openCode: mac || platform === "linux" || platform === "win32",
  });
};
export type HostCapabilities = ReturnType<typeof hostCapabilities>;
