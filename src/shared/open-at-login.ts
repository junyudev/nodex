export type OpenAtLoginStatus = "enabled" | "disabled" | "requires-approval" | "unavailable";

export interface OpenAtLoginResult {
  readonly status: OpenAtLoginStatus;
  readonly error?: "requires-approval" | "change-failed";
}
