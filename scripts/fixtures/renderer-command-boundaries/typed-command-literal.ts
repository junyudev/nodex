import { invokePlainCommand } from "@/lib/renderer-command";

declare const commandDefinitionFor: (channel: string) => unknown;

export const openExternal = (): Promise<boolean> =>
  invokePlainCommand("shell:open-external-url", "https://example.com");

export const openExternalInline = (): Promise<boolean> =>
  invokePlainCommand(
    {
      key: "shell.open-external-url",
      channel: "shell:open-external-url",
      authority: "external",
      owner: "shell",
      protocol: { kind: "returned_value" },
    },
    "https://example.com",
  );

export const openExternalDynamic = (): Promise<boolean> =>
  invokePlainCommand(
    commandDefinitionFor("shell:open-external-url"),
    "https://example.com",
  );
