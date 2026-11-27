export function resolveWindowsVcRuntimeDirectory(arch: "x64" | "arm64"): string;
export function stageWindowsVcRuntime(
  root: string,
  arch: "x64" | "arm64",
  options?: { readonly redistDirectory?: string; readonly desktopToolsRoot?: string },
): readonly string[];
