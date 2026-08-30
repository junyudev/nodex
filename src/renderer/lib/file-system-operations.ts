import type { FileLinkOpenerId, FileLinkTarget } from "../../shared/file-link-openers";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const openFileLinkCommand = defineRendererCommand({
  key: "file_reference.open_external",
  channel: "shell:open-file-link",
  authority: "external",
  owner: "OperatingSystem",
  protocol: { kind: "pending_operation" },
});

const openPathDefaultCommand = defineRendererCommand({
  key: "file_reference.open_default",
  channel: "shell:open-path-default",
  authority: "external",
  owner: "OperatingSystem",
  protocol: { kind: "pending_operation" },
});

const openExternalUrlCommand = defineRendererCommand({
  key: "file_reference.open_external_url",
  channel: "shell:open-external-url",
  authority: "external",
  owner: "OperatingSystem",
  protocol: { kind: "pending_operation" },
});

export type FileLinkOpenPort = (
  target: FileLinkTarget,
  opener: FileLinkOpenerId,
) => Promise<boolean>;

export const openFileLink: FileLinkOpenPort = async (target, opener) =>
  await invokePlainCommand(openFileLinkCommand, target, opener);

export async function openPathWithDefaultApplication(path: string): Promise<boolean> {
  return await invokePlainCommand(openPathDefaultCommand, path);
}

export async function openExternalUrl(url: string): Promise<boolean> {
  return await invokePlainCommand(openExternalUrlCommand, url);
}

export function listAvailableFileLinkOpeners(): Promise<FileLinkOpenerId[]> {
  return invokeRendererQuery("shell:file-link-openers:list-available");
}
