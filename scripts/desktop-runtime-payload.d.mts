export function assertMacDesktopToolsDetached(resourcesPath: string): void;
export function assertMacCodexDetached(resourcesPath: string): void;
export function assertDetachedRuntimeResources(resourcesPath: string): void;
interface DesktopRuntimePayloadInput {
  readonly resourcesPath: string;
  readonly platform: string;
  readonly arch: string;
  readonly sourceRoot?: string;
}
export function assertDesktopRuntimePayload(
  input: DesktopRuntimePayloadInput & { platform: "win32" },
): string;
export function assertDesktopRuntimePayload(input: DesktopRuntimePayloadInput): string | null;
