export function assertDetachedRuntimeResources(resourcesPath: string): void;
export function assertDesktopRuntimePayload(input: {
  readonly resourcesPath: string;
  readonly platform: string;
  readonly arch: string;
  readonly sourceRoot?: string;
}): string;
