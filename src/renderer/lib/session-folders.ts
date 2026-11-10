import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

const ensureFolder = defineRendererCommand({
  key: "session_folder.ensure",
  channel: "session-folder:ensure",
  authority: "main",
  owner: "SessionFolders",
  protocol: { kind: "returned_value" },
});

const chooseFolder = defineRendererCommand({
  key: "session_folder.choose",
  channel: "session-folder:choose",
  authority: "main",
  owner: "SessionFolders",
  protocol: { kind: "returned_value" },
});

const pickDirectory = defineRendererCommand({
  key: "session_folder.pick_directory",
  channel: "workspace:pick-directory",
  authority: "external",
  owner: "SessionFolders",
  protocol: { kind: "returned_value" },
});

export const ensureSessionFolder = (sessionId: string) =>
  invokePlainCommand(ensureFolder, sessionId);

export const chooseSessionFolder = (sessionId: string, path: string) =>
  invokePlainCommand(chooseFolder, sessionId, path);

export const pickSessionFolder = () =>
  invokePlainCommand(pickDirectory, { title: "Choose Chat folder" });
