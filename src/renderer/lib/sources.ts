import type { UpdateSourceSettingsInput } from "../../shared/sources";
import {
  defineLocalCommitRendererCommand,
  defineRendererCommand,
  invokeLocalCommitCommand,
  invokePlainCommand,
  invokeRendererQuery,
} from "./renderer-command";
const connectCommand = defineLocalCommitRendererCommand({
  key: "sources.connect",
  channel: "sources:connect",
  authority: "core",
  protocol: { kind: "returned_value" },
  owner: "Sources",
});
const updateCommand = defineLocalCommitRendererCommand({
  key: "sources.update",
  channel: "sources:update",
  authority: "core",
  protocol: { kind: "returned_value" },
  owner: "Sources",
});
const retryCommand = defineRendererCommand({
  key: "sources.retry",
  channel: "sources:retry",
  authority: "main",
  protocol: { kind: "returned_value" },
  owner: "Sources",
});
/** Sources settings read only public account and health metadata. */
export const readSourcesSettings = () => invokeRendererQuery("sources:settings");
export const connectGitHubSource = () => invokeLocalCommitCommand(connectCommand);
export const updateSourcesSettings = (input: UpdateSourceSettingsInput) =>
  invokeLocalCommitCommand(updateCommand, input);
export const retrySource = (sourceId: string) => invokePlainCommand(retryCommand, sourceId);
