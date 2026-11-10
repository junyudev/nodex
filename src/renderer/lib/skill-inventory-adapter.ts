import type { IpcEvents } from "../../shared/ipc-api";
import type { SkillInput } from "../../shared/skill-inventory";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";

const writeDocument = defineRendererCommand({
  key: "skills.document.write",
  channel: "skills:document:write",
  authority: "main",
  owner: "SkillInventory",
  protocol: { kind: "returned_value" },
});
const createBlank = defineRendererCommand({
  key: "skills.create",
  channel: "skills:create",
  authority: "main",
  owner: "SkillInventory",
  protocol: { kind: "returned_value" },
});
const rename = defineRendererCommand({
  key: "skills.rename",
  channel: "skills:rename",
  authority: "main",
  owner: "SkillInventory",
  protocol: { kind: "returned_value" },
});
const transfer = defineRendererCommand({
  key: "skills.transfer",
  channel: "skills:transfer",
  authority: "main",
  owner: "SkillInventory",
  protocol: { kind: "returned_value" },
});
const trash = defineRendererCommand({
  key: "skills.trash",
  channel: "skills:trash",
  authority: "main",
  owner: "SkillInventory",
  protocol: { kind: "returned_value" },
});
const setEnabled = defineRendererCommand({
  key: "skills.set-enabled",
  channel: "skills:set-enabled",
  authority: "main",
  owner: "SkillInventory",
  protocol: { kind: "returned_value" },
});

export const skillInventoryAdapter = {
  list: (input: SkillInput<"list">) => invokeRendererQuery("skills:inventory:list", input),
  readDocument: (input: SkillInput<"readDocument">) =>
    invokeRendererQuery("skills:document:read", input),
  writeDocument: (input: SkillInput<"writeDocument">) => invokePlainCommand(writeDocument, input),
  createBlank: (input: SkillInput<"createBlank">) => invokePlainCommand(createBlank, input),
  rename: (input: SkillInput<"rename">) => invokePlainCommand(rename, input),
  transfer: (input: SkillInput<"transfer">) => invokePlainCommand(transfer, input),
  trash: (input: SkillInput<"trash">) => invokePlainCommand(trash, input),
  setEnabled: (input: SkillInput<"setEnabled">) => invokePlainCommand(setEnabled, input),
  watchStart: (input: SkillInput<"watchStart">) =>
    invokeRendererControl("skills:watch:start", input),
  watchStop: (input: SkillInput<"watchStop">) => invokeRendererControl("skills:watch:stop", input),
};

export function subscribeSkillChanges(listener: (event: IpcEvents["skills:changed"]) => void) {
  return window.api?.on("skills:changed", (event) =>
    listener(event as IpcEvents["skills:changed"]),
  );
}

export function subscribeComposerSkillInvalidation(
  listener: (event: IpcEvents["skills:composer-invalidated"]) => void,
) {
  return window.api?.on("skills:composer-invalidated", (event) =>
    listener(event as IpcEvents["skills:composer-invalidated"]),
  );
}

export function subscribeSkillScopeChanges(projectId: string | null, listener: () => void) {
  const stopProfiles = window.api?.on("claude-agent-settings-changed", listener);
  const stopProjects = window.api?.on("projects-changed", (raw) => {
    const event = raw as IpcEvents["projects-changed"];
    if (
      projectId &&
      (!event.projectId || event.projectId === projectId) &&
      ["sources", "lifecycle", "update", "delete"].includes(event.changeType)
    )
      listener();
  });
  return () => {
    stopProfiles?.();
    stopProjects?.();
  };
}
