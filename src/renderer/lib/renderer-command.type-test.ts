import type { RendererCommandDefinition } from "./renderer-command";

// Semantic definitions are nominal: arbitrary identifier-shaped objects cannot authorize transport.
// @ts-expect-error command definitions must be created by defineRendererCommand
export const forgedRendererCommand: RendererCommandDefinition<
  "shell.open_external_url",
  "external",
  { readonly kind: "returned_value" },
  "shell:open-external-url"
> = {
  key: "shell.open_external_url",
  channel: "shell:open-external-url",
  authority: "external",
  owner: "OperatingSystem",
  protocol: { kind: "returned_value" },
};
