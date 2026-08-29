export interface ExplicitSettingsAuthority {
  readonly environment: Readonly<Record<string, string>>;
  readonly settingsPath: string;
}

export const explicitSettingsAuthority = (
  input: ExplicitSettingsAuthority,
): ExplicitSettingsAuthority => input;
