import type { IpcApi, IpcArgs } from "../../shared/ipc-api";
import {
  defineRendererCommand,
  defineLocalCommitRendererCommand,
  invokePlainCommand,
  invokeRevisionedCommand,
  invokeLocalCommitCommandResult,
  type AdmittedLocalCommitCommandResult,
} from "./renderer-command";
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

const openExternalUrl = defineRendererCommand({
  key: "shell.open_external_url",
  channel: "shell:open-external-url",
  authority: "external",
  owner: "OperatingSystem",
  protocol: { kind: "returned_value" },
});

export const plainCommandResult: Promise<boolean> = invokePlainCommand(
  openExternalUrl,
  "https://example.test",
);
// @ts-expect-error plain commands retain their channel's exact argument tuple
void invokePlainCommand(openExternalUrl, 42);
// @ts-expect-error a missing required channel argument is rejected
void invokePlainCommand(openExternalUrl);
// @ts-expect-error transport erasure must not widen the public result
export const wrongPlainResult: Promise<string> = invokePlainCommand(
  openExternalUrl,
  "https://example.test",
);

declare const coreCommand: RendererCommandDefinition<
  "project.update",
  "core",
  { readonly kind: "returned_value" },
  "projects:update"
>;
// @ts-expect-error LocalCommit commands cannot cross the plain-result boundary
void invokePlainCommand(coreCommand);

const forgedAuthority = { ...openExternalUrl, authority: "core" as const };
// @ts-expect-error spreading a branded definition cannot forge a different authority/protocol pair
void invokePlainCommand(forgedAuthority, "https://example.test");

const revisioned = defineRendererCommand({
  key: "persisted_atom.update",
  channel: "persisted-atom:update",
  authority: "main",
  owner: "PersistedAtoms",
  protocol: { kind: "revision_fenced_local" },
});
declare const revisionedArgs: IpcArgs<"persisted-atom:update">;
export const revisionedResult: Promise<IpcApi["persisted-atom:update"]["result"]> =
  invokeRevisionedCommand(revisioned, ...revisionedArgs);
// @ts-expect-error revisioned commands preserve the channel's argument shape
void invokeRevisionedCommand(revisioned, "invalid update");
// @ts-expect-error a terminal plain result has no revision evidence
void invokeRevisionedCommand(openExternalUrl, "https://example.test");

const localCommit = defineLocalCommitRendererCommand({
  key: "project.update",
  channel: "projects:update",
  authority: "core",
  owner: "Projects",
  protocol: { kind: "receipt_fenced_projection", presentation: "required" },
});
declare const updateArgs: IpcArgs<"projects:update">;
export const admittedResult: Promise<AdmittedLocalCommitCommandResult<"projects:update">> =
  invokeLocalCommitCommandResult(localCommit, ...updateArgs);
// @ts-expect-error LocalCommit commands retain their input contract
void invokeLocalCommitCommandResult(localCommit, "invalid project update");
const forgedMainAuthority = { ...localCommit, authority: "main" as const };
// @ts-expect-error Main cannot acquire Core authority by spreading a registered definition
void invokeLocalCommitCommandResult(forgedMainAuthority, ...updateArgs);
