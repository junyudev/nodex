import { invokeRendererControl, invokeRendererQuery } from "@/lib/renderer-command";

export const listProjects = () => invokeRendererQuery("projects:list");
export const subscribe = (address: unknown) =>
  invokeRendererControl("local-commit-audience:subscribe", address);
