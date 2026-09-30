import type {
  NativeSessionAttachInput,
  NativeSessionCatalogInput,
} from "../../shared/native-session-catalog";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const attachNativeSessionCommand = defineRendererCommand({
  key: "native_session.attach",
  channel: "native-sessions:attach",
  authority: "main",
  owner: "NativeSessionCatalog",
  protocol: { kind: "returned_value" },
});

export const listNativeSessions = (input: NativeSessionCatalogInput) =>
  invokeRendererQuery("native-sessions:list", input);

export const attachNativeSession = (input: NativeSessionAttachInput) =>
  invokePlainCommand(attachNativeSessionCommand, input);

export const readNativeSessionProjects = (after: string | null = null) =>
  invokeRendererQuery("projects:list", { after, first: 100 });
