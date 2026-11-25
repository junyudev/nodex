import { useSyncExternalStore } from "react";
import { AgentsSurface, type AgentsSurfaceProps } from "@/features/agents/agents-surface";

function subscribeToDocumentVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function isDocumentVisible() {
  return document.visibilityState === "visible";
}

export function WorkbenchAgentsSurface({
  active,
  ...props
}: Omit<AgentsSurfaceProps, "visible"> & { readonly active: boolean }) {
  const windowVisible = useSyncExternalStore(subscribeToDocumentVisibility, isDocumentVisible);
  return <AgentsSurface {...props} visible={active && windowVisible} />;
}
