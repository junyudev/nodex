export const WINDOWS_VC_RUNTIME_DLLS: readonly string[];
export const CODEX_CRT_RESOURCES_DIRECTORY: "codex-crt";

export function planWindowsVcRuntime(
  root: string,
  arch: "arm64" | "x64",
  images: readonly string[],
  redistDirectories: () => readonly string[],
): readonly { readonly source: string; readonly destination: string }[];
