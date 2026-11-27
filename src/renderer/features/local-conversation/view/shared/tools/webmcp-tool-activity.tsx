import { useIntl } from "@/lib/i18n";
import { BrowserUseIcon } from "@/components/shared/icons";
import { SiteIcon } from "@/components/shared/site-icon";
import { formatCodexMcpVisualSourceName } from "../../../../../../shared/codex-mcp-tool-call";
import type { CodexWebMcpCall } from "../../../../../../shared/codex-webmcp-tool-call";
import { ThreadActivityDisclosure } from "./tool-primitives";
import { ToolCallCodePanel } from "./tool-call-inspection";

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatJsonOrText(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function WebMcpSourceIcon({ href }: { href: string | null }) {
  if (href === null)
    return <BrowserUseIcon aria-hidden className="icon-xs shrink-0 text-token-conversation-body" />;
  return <SiteIcon className="icon-xs text-token-conversation-body" href={href} />;
}

export function WebMcpToolActivity({
  call,
  fallbackPageUrl,
}: {
  call: CodexWebMcpCall;
  fallbackPageUrl: string | null;
}) {
  const intl = useIntl();
  const sourceUrl =
    call.sourceHostname == null ? fallbackPageUrl : `https://${call.sourceHostname}`;
  const input = call.kind === "invokeTool" ? call.inputJson : undefined;
  const inputTruncated = call.kind === "invokeTool" && call.inputTruncated === true;
  const definition = JSON.stringify(
    {
      name: call.name,
      title: call.title,
      description: call.description,
      website: call.sourceHostname,
      readOnlyHint: call.readOnlyHint,
      input: input == null || inputTruncated ? input : parseJsonOrText(input),
      inputTruncated: inputTruncated ? true : undefined,
    },
    null,
    2,
  );
  const result =
    call.outputJson == null
      ? null
      : call.outputTruncated
        ? call.outputJson
        : formatJsonOrText(call.outputJson);
  const summary =
    call.kind === "listTools"
      ? intl.formatMessage({
          id: "conversation.webmcpToolActivity.listedWebsiteTools",
          defaultMessage: "Listed website tools",
        })
      : (call.title ?? formatCodexMcpVisualSourceName(call.name, { style: "sentence" }));
  return (
    <ThreadActivityDisclosure
      icon={<WebMcpSourceIcon href={sourceUrl} />}
      status="completed"
      summary={summary}
    >
      <ToolCallCodePanel
        title={
          inputTruncated
            ? intl.formatMessage({
                id: "conversation.webmcpToolActivity.truncatedInput",
                defaultMessage: "Tool (input truncated)",
              })
            : intl.formatMessage({
                id: "conversation.webmcpToolActivity.tool",
                defaultMessage: "Tool",
              })
        }
        preview={{ kind: "complete", text: definition }}
        previewCharacterLimit={null}
      />
      {result !== null ? (
        <ToolCallCodePanel
          title={
            call.outputTruncated
              ? intl.formatMessage({
                  id: "conversation.webmcpToolActivity.truncatedResult",
                  defaultMessage: "Result (truncated)",
                })
              : intl.formatMessage({
                  id: "conversation.webmcpToolActivity.result",
                  defaultMessage: "Result",
                })
          }
          preview={{ kind: "complete", text: result }}
          previewCharacterLimit={null}
        />
      ) : null}
    </ThreadActivityDisclosure>
  );
}
