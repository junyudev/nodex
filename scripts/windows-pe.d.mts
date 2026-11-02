export function isWindowsSystemDll(name: string): boolean;
export function readPeImports(
  file: string,
): readonly { readonly name: string; readonly kind: "import" | "delay" }[];
export function assertPeDependencies(
  file: string,
  expected: "x64" | "arm64",
  options?: { readonly systemOnly?: boolean; readonly nodeHost?: string },
): void;
export function readPeArchitecture(file: string): "x64" | "arm64";
export function assertPeArchitecture(file: string, expected: "x64" | "arm64"): void;
export function verifyWindowsArchitectureClosure(
  root: string,
  expected: "x64" | "arm64",
  options?: { readonly installed?: boolean; readonly nodeHost?: string },
): readonly string[];

export function listWindowsPeImages(root: string): readonly string[];
