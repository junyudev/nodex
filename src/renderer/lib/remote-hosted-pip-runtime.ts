import type { IpcApi } from "../../shared/ipc-api";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";

const setRemoteHostedPipTaskVisibilityCommand = defineRendererCommand({
  key: "remote_hosted_pip.set_task_visibility",
  channel: "remote-hosted-pip:task-visibility:set",
  authority: "main",
  owner: "RemoteHostedPipRuntime",
  protocol: { kind: "returned_value" },
});

/** Typed Adapter for Main-owned PiP presentation and bounded host geometry. */
export const remoteHostedPipRuntime = {
  snapshot: async () => invokeRendererQuery("remote-hosted-pip:snapshot"),
  reportHostLayout: async (layout: IpcApi["remote-hosted-pip:host-layout:report"]["args"][0]) =>
    invokeRendererControl("remote-hosted-pip:host-layout:report", layout),
  setTaskVisibility: (input: IpcApi["remote-hosted-pip:task-visibility:set"]["args"][0]) =>
    invokePlainCommand(setRemoteHostedPipTaskVisibilityCommand, input),
};
