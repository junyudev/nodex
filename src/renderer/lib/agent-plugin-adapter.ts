import { queryOptions } from "@tanstack/react-query";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { spaceQueryKey } from "./renderer-space";

type PluginCommand =
  | "pick-folder"
  | "install"
  | "set-project-enabled"
  | "reload"
  | "uninstall"
  | "repair-writer";

const command = <const Name extends PluginCommand>(name: Name) =>
  defineRendererCommand({
    key: `agent-plugins.${name}`,
    channel: `agent-plugins:${name}`,
    authority: "main",
    owner: "AgentPluginManagement",
    protocol: { kind: "returned_value" },
  });

const pickFolder = command("pick-folder");
const install = command("install");
const setProjectEnabled = command("set-project-enabled");
const reload = command("reload");
const uninstall = command("uninstall");
const repairWriter = command("repair-writer");

export const agentPluginListKey = () => spaceQueryKey(["agent-plugins", "list"]);
export const agentPluginListOptions = (projectId: string | null) =>
  queryOptions({
    queryKey: [...agentPluginListKey(), projectId],
    queryFn: () => invokeRendererQuery("agent-plugins:list", { projectId }),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

export const agentPluginAdapter = {
  pickFolder: () => invokePlainCommand(pickFolder),
  preview: (directory: string) => invokeRendererQuery("agent-plugins:preview", { directory }),
  install: (directory: string, previewDigest: string) =>
    invokePlainCommand(install, { directory, previewDigest }),
  setProjectEnabled: (id: string, projectId: string, enabled: boolean) =>
    invokePlainCommand(setProjectEnabled, { id, projectId, enabled }),
  reload: (id: string) => invokePlainCommand(reload, { id }),
  uninstall: (id: string, data: "keep" | "delete") => invokePlainCommand(uninstall, { id, data }),
  repairWriter: () => invokePlainCommand(repairWriter),
};
