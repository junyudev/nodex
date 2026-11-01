/** Host integration policy. Callers supply the immutable bootstrap platform snapshot. */
export const hostCapabilities = (platform: string, architecture?: string) => {
  const mac = platform === "darwin";
  return Object.freeze({
    backgroundService: mac,
    autoUpdate: mac && (architecture === undefined || architecture === "arm64"),
    browserControl: mac,
    computerControl: mac,
    appshot: mac,
    deviceCheck: mac && architecture === "arm64",
    nativeClipboard: mac,
    nativeNotificationAuthorization: mac,
    dictationBackend: mac ? ("macos" as const) : platform === "win32" ? ("windows" as const) : null,
    openCode: mac || platform === "linux" || platform === "win32",
  });
};
export type HostCapabilities = ReturnType<typeof hostCapabilities>;
