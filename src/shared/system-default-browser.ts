/** The OS handler for HTTPS; name-only discovery leaves icon and path unknown. */
export interface SystemDefaultBrowser {
  readonly name: string;
  readonly iconDataUrl: string | null;
  readonly appPath: string | null;
}
