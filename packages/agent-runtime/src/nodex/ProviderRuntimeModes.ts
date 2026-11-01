import { RuntimeMode, type ServerProvider } from "@t3tools/contracts";

/** Catalog choices reflect the execution modes a native provider can enforce. */
export const withSupportedRuntimeModes = <
  T extends Pick<ServerProvider, "driver" | "supportedRuntimeModes">,
>(
  provider: T,
): T & { readonly supportedRuntimeModes: readonly RuntimeMode[] } => ({
  ...provider,
  supportedRuntimeModes:
    provider.supportedRuntimeModes ??
    (provider.driver === "acpRegistry" || provider.driver === "opencode"
      ? ["approval-required", "full-access"]
      : RuntimeMode.literals),
});
