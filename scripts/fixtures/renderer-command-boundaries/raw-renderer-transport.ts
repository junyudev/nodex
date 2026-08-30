import { resolveInvokeTransport } from "@/lib/renderer-transport";

export const bypassSemanticOwner = () =>
  resolveInvokeTransport().invoke("projects:update", { name: "Bypassed" });
