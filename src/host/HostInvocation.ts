import * as Context from "effect/Context";

/** Core-issued proof of one live Member request; never supplied by an Agent or renderer. */
export const HostInvocation = Context.Reference<string | null>("nodex/host/HostInvocation", {
  defaultValue: () => null,
});
