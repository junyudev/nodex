import type {
  CodexAutomationRunArchiveInput,
  CodexAutomationRunReadStateInput,
  CodexAutomationRunUnarchiveInput,
  CodexHeartbeatAutomationsEnabledChangedInput,
  CodexHeartbeatAutomationThreadStateChangedInput,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationDeleteInput,
  CodexScheduledAutomationRunNowInput,
  CodexScheduledAutomationUpdateInput,
} from "../../shared/types";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
} from "./renderer-command";

const automationCommandDefinitions = {
  archiveRun: defineRendererCommand({
    key: "automation.run.archive",
    channel: "codex:automation-runs:archive",
    authority: "main",
    owner: "CodexAutomations",
    protocol: { kind: "returned_value" },
  }),
  create: defineRendererCommand({
    key: "automation.schedule.create",
    channel: "codex:scheduled-automations:create",
    authority: "main",
    owner: "CodexAutomations",
    protocol: { kind: "returned_value" },
  }),
  delete: defineRendererCommand({
    key: "automation.schedule.delete",
    channel: "codex:scheduled-automations:delete",
    authority: "main",
    owner: "CodexAutomations",
    protocol: { kind: "returned_value" },
  }),
  setRunReadState: defineRendererCommand({
    key: "automation.run.set_read_state",
    channel: "codex:automation-runs:set-read-state",
    authority: "main",
    owner: "CodexAutomations",
    protocol: { kind: "returned_value" },
  }),
  unarchiveRun: defineRendererCommand({
    key: "automation.run.unarchive",
    channel: "codex:automation-runs:unarchive",
    authority: "main",
    owner: "CodexAutomations",
    protocol: { kind: "returned_value" },
  }),
  update: defineRendererCommand({
    key: "automation.schedule.update",
    channel: "codex:scheduled-automations:update",
    authority: "main",
    owner: "CodexAutomations",
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

const runScheduledAutomationNowCommand = defineRendererCommand({
  key: "automation.schedule.run_now",
  channel: "codex:scheduled-automations:run-now",
  authority: "main",
  owner: "CodexAutomations",
  protocol: { kind: "pending_operation" },
});

export async function createCodexScheduledAutomation(input: CodexScheduledAutomationCreateInput) {
  return await invokePlainCommand(createAutomationCommand, input);
}

export async function updateCodexScheduledAutomation(input: CodexScheduledAutomationUpdateInput) {
  return await invokePlainCommand(updateAutomationCommand, input);
}

export async function deleteCodexScheduledAutomation(input: CodexScheduledAutomationDeleteInput) {
  return await invokePlainCommand(deleteAutomationCommand, input);
}

export async function runCodexScheduledAutomationNow(input: CodexScheduledAutomationRunNowInput) {
  return await invokePlainCommand(runScheduledAutomationNowCommand, input);
}

export async function archiveCodexAutomationRun(input: CodexAutomationRunArchiveInput) {
  return await invokePlainCommand(archiveAutomationRunCommand, input);
}

export async function unarchiveCodexAutomationRun(input: CodexAutomationRunUnarchiveInput) {
  return await invokePlainCommand(unarchiveAutomationRunCommand, input);
}

export async function setCodexAutomationRunReadState(input: CodexAutomationRunReadStateInput) {
  return await invokePlainCommand(setAutomationRunReadStateCommand, input);
}

export async function publishCodexHeartbeatEnabled(
  input: CodexHeartbeatAutomationsEnabledChangedInput,
): Promise<void> {
  await invokeRendererControl("codex:scheduled-automations:heartbeat-enabled-changed", input);
}

export async function publishCodexHeartbeatThreadState(
  input: CodexHeartbeatAutomationThreadStateChangedInput,
): Promise<void> {
  await invokeRendererControl("codex:scheduled-automations:heartbeat-thread-state-changed", input);
}
