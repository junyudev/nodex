import * as Context from "effect/Context";

/** Core-issued proof of one live Member request; never supplied by an Agent or renderer. */
export const HostInvocation = Context.Reference<string | null>("nodex/host/HostInvocation", {
  defaultValue: () => null,
});

/**
 * Main's in-process grant for a trusted personal Space companion. Core already
 * binds local application calls to the Profile's Member, so this grant never
 * goes in a Core request header and cannot be used as a remote proof.
 */
export const LocalCompanionInvocation = Context.Reference<{ readonly memberId: string } | null>(
  "nodex/host/LocalCompanionInvocation",
  { defaultValue: () => null },
);
