import path from "node:path";

export type ChromeHostRegistration =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "production" | "development" | "disposable";
      readonly homeDirectory: string;
    };

/** Launchers declare intent. Only Main selects the destination and grants real-home access. */
export function resolveChromeHostRegistration(input: {
  readonly isPackaged: boolean;
  readonly isolatedRunId: string | null;
  readonly homeDirectory: string;
  readonly nodexHome: string;
  readonly personalNodexHome: string;
  readonly launchMode: string | undefined;
  readonly hasScenarioHome: boolean;
}): ChromeHostRegistration {
  if (input.launchMode === "disposable") {
    return { kind: "disposable", homeDirectory: path.join(input.nodexHome, "browser-host-home") };
  }
  if (!input.isPackaged && input.isolatedRunId && input.launchMode === "development") {
    return { kind: "development", homeDirectory: input.homeDirectory };
  }
  if (input.isolatedRunId) return { kind: "disabled" };
  if (input.isPackaged && !input.hasScenarioHome && input.nodexHome === input.personalNodexHome) {
    return { kind: "production", homeDirectory: input.homeDirectory };
  }
  return { kind: "disabled" };
}
