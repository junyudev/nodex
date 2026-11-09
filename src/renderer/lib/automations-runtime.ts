import type {
  AutomationRunArchiveInput,
  AutomationRunReadStateInput,
  AutomationRunUnarchiveInput,
  CodexHeartbeatAutomationsEnabledChangedInput,
  CodexHeartbeatAutomationThreadStateChangedInput,
  AutomationCreateInput,
  AutomationDeleteInput,
  AutomationRunNowInput,
  AutomationUpdateInput,
} from "../../shared/types";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
} from "./renderer-command";

const automationCommandDefinitions = {
  archiveRun: defineRendererCommand({
    key: "automation.run.archive",
    channel: "automations:runs:archive",
    authority: "main",
    owner: "Automations",
    protocol: { kind: "returned_value" },
  }),
  create: defineRendererCommand({
    key: "automation.create",
    channel: "automations:create",
    authority: "main",
    owner: "Automations",
    protocol: { kind: "returned_value" },
  }),
  delete: defineRendererCommand({
    key: "automation.delete",
    channel: "automations:delete",
    authority: "main",
    owner: "Automations",
    protocol: { kind: "returned_value" },
  }),
  setRunReadState: defineRendererCommand({
    key: "automation.run.set_read_state",
    channel: "automations:runs:set-read-state",
    authority: "main",
    owner: "Automations",
    protocol: { kind: "returned_value" },
  }),
  unarchiveRun: defineRendererCommand({
    key: "automation.run.unarchive",
    channel: "automations:runs:unarchive",
    authority: "main",
    owner: "Automations",
    protocol: { kind: "returned_value" },
  }),
  update: defineRendererCommand({
    key: "automation.update",
    channel: "automations:update",
    authority: "main",
    owner: "Automations",
    protocol: { kind: "returned_value" },
  }),
} as const;

const {
  archiveRun: archiveAutomationRunCommand,
  create: createAutomationCommand,
  delete: deleteAutomationCommand,
  setRunReadState: setAutomationRunReadStateCommand,
  unarchiveRun: unarchiveAutomationRunCommand,
  update: updateAutomationCommand,
} = automationCommandDefinitions;

const runAutomationNowCommand = defineRendererCommand({
  key: "automation.run_now",
  channel: "automations:run-now",
  authority: "main",
  owner: "Automations",
  protocol: { kind: "pending_operation" },
});

export async function createAutomation(input: AutomationCreateInput) {
  return await invokePlainCommand(createAutomationCommand, input);
}

export async function updateAutomation(input: AutomationUpdateInput) {
  return await invokePlainCommand(updateAutomationCommand, input);
}

export async function deleteAutomation(input: AutomationDeleteInput) {
  return await invokePlainCommand(deleteAutomationCommand, input);
}

export async function runAutomationNow(input: AutomationRunNowInput) {
  return await invokePlainCommand(runAutomationNowCommand, input);
}

export async function archiveAutomationRun(input: AutomationRunArchiveInput) {
  return await invokePlainCommand(archiveAutomationRunCommand, input);
}

export async function unarchiveAutomationRun(input: AutomationRunUnarchiveInput) {
  return await invokePlainCommand(unarchiveAutomationRunCommand, input);
}

export async function setAutomationRunReadState(input: AutomationRunReadStateInput) {
  return await invokePlainCommand(setAutomationRunReadStateCommand, input);
}

export async function publishCodexHeartbeatEnabled(
  input: CodexHeartbeatAutomationsEnabledChangedInput,
): Promise<void> {
  await invokeRendererControl("automations:heartbeat-enabled-changed", input);
}

export async function publishCodexHeartbeatThreadState(
  input: CodexHeartbeatAutomationThreadStateChangedInput,
): Promise<void> {
  await invokeRendererControl("automations:heartbeat-thread-state-changed", input);
}
