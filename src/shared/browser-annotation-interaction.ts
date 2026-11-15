export type BrowserAnnotationFlow = "batch" | "quick";
export type BrowserAnnotationAction = "save" | "send";
export function browserAnnotationDefaultAction(
  flow: BrowserAnnotationFlow,
): BrowserAnnotationAction {
  return flow === "quick" ? "send" : "save";
}
export function browserAnnotationKeyAction(input: {
  flow: BrowserAnnotationFlow;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  repeat: boolean;
}): BrowserAnnotationAction | null {
  if (input.key !== "Enter" || input.shiftKey || input.isComposing || input.repeat) return null;
  const primary = browserAnnotationDefaultAction(input.flow);
  return input.metaKey || input.ctrlKey ? (primary === "save" ? "send" : "save") : primary;
}
export function browserAnnotationAvailability(input: {
  enabled: boolean;
  suspended: boolean;
  agentControlled: boolean;
}): boolean {
  return input.enabled && !input.suspended && !input.agentControlled;
}
