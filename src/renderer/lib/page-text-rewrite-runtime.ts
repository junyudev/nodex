import type { PageTextRewriteStart } from "../../shared/page-text-rewrite";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
} from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const startCommand = defineRendererCommand({
  key: "pageTextRewrite.start",
  channel: "page-text-rewrite:start",
  authority: "main",
  owner: "PageTextRewrite",
  protocol: { kind: "pending_operation" },
});

export const pageTextRewriteRuntime = {
  start: (input: PageTextRewriteStart) => invokePlainCommand(startCommand, input),
  cancel: (requestId: string) => invokeRendererControl("page-text-rewrite:cancel", requestId),
  subscribe: (
    listener: (event: import("../../shared/page-text-rewrite").PageTextRewriteEvent) => void,
  ) => {
    const subscribe = resolveRendererTransport().subscribePageTextRewriteEvents;
    if (!subscribe) throw new Error("Page text rewrite is unavailable");
    return subscribe(listener);
  },
};
