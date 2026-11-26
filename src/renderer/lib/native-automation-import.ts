import type { NativeAutomationSelection } from "../../shared/native-automation-import";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const importCommand = defineRendererCommand({
  key: "native_automation.import",
  channel: "native-automations:import",
  authority: "main",
  owner: "NativeAutomationImport",
  protocol: { kind: "returned_value" },
});

export const listNativeAutomations = () => invokeRendererQuery("native-automations:list");
export const importNativeAutomation = (selection: NativeAutomationSelection) =>
  invokePlainCommand(importCommand, selection);
