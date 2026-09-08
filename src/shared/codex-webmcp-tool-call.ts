import { z } from "zod";
import type { CodexMcpToolCallView } from "./types";

const WebMcpToolDetailsSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  sourceHostname: z.string().min(1).optional(),
  outputJson: z.string().optional(),
  outputTruncated: z.literal(true).optional(),
});

const WebMcpCallSchema = z.discriminatedUnion("kind", [
  WebMcpToolDetailsSchema.extend({
    kind: z.literal("listTools"),
    name: z.literal("webmcp_list_tools"),
  }),
  WebMcpToolDetailsSchema.extend({
    kind: z.literal("invokeTool"),
    name: z.string().refine((name) => name.trim().length > 0),
    inputJson: z.string().optional(),
    inputTruncated: z.literal(true).optional(),
  }),
]);

const WebMcpResultMetadataSchema = z.object({
  "codex/toolSurface": z.object({
    kind: z.literal("browserUse"),
    webMcpCalls: z.array(WebMcpCallSchema),
  }),
});
const HttpUrlSchema = z.url({ protocol: /^https?$/ });
const BrowserPageMetadataSchema = z.object({
  "codex/toolSurface": z.object({
    kind: z.literal("browserUse"),
    screenshot: z.object({ pageUrl: HttpUrlSchema.optional() }).optional(),
  }),
  browser_use: z.object({ url: HttpUrlSchema.optional() }).optional(),
});

export type CodexWebMcpCall = z.infer<typeof WebMcpCallSchema>;

/** A malformed metadata batch is ignored as a unit; tool output text is never inferred. */
export function decodeCodexWebMcpCalls(metadata: unknown): readonly CodexWebMcpCall[] {
  const result = WebMcpResultMetadataSchema.safeParse(metadata);
  return result.success ? result.data["codex/toolSurface"].webMcpCalls : [];
}

export function resolveCodexBrowserPageUrl(metadata: unknown): string | null {
  const result = BrowserPageMetadataSchema.safeParse(metadata);
  if (!result.success) return null;
  return (
    result.data.browser_use?.url ?? result.data["codex/toolSurface"].screenshot?.pageUrl ?? null
  );
}

export function isCodexBrowserMcpServer(server: string): boolean {
  return server === "node_repl" || server === "cua_repl";
}

export function resolveCodexWebMcpActivities(call: CodexMcpToolCallView): {
  readonly calls: readonly CodexWebMcpCall[];
  readonly fallbackPageUrl: string | null;
} {
  if (
    !call.completed ||
    !isCodexBrowserMcpServer(call.invocation.server) ||
    call.invocation.tool !== "js" ||
    call.result?.type !== "success"
  ) {
    return { calls: [], fallbackPageUrl: null };
  }
  const metadata = call.result.raw._meta;
  return {
    calls: decodeCodexWebMcpCalls(metadata),
    fallbackPageUrl:
      call.source?.kind === "browserUse" ? resolveCodexBrowserPageUrl(metadata) : null,
  };
}
