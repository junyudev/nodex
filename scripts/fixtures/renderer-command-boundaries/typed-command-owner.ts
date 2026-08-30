import {
  defineLocalCommitRendererCommand,
  invokeLocalCommitCommand,
} from "@/lib/renderer-command";

export const updateProjectCommand = defineLocalCommitRendererCommand({
  key: "workspace.project.update",
  channel: "projects:update",
  authority: "core",
  owner: "project-catalog",
  protocol: { kind: "receipt_fenced_projection", presentation: "required" },
});

export const updateProject = (input: unknown) =>
  invokeLocalCommitCommand(updateProjectCommand, input);
