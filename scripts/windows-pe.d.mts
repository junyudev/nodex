export function readPeArchitecture(file: string): "x64" | "arm64";
export function assertPeArchitecture(file: string, expected: "x64" | "arm64"): void;
export function verifyWindowsArchitectureClosure(
  root: string,
  expected: "x64" | "arm64",
): readonly string[];
