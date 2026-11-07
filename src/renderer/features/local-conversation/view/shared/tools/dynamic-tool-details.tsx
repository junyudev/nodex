import { Fragment, type ReactNode } from "react";
import {
  buildDynamicToolAuthoredPanels,
  formatToolOutputText,
} from "../../../projection/tool-metadata/dynamic-tool-fallback-details";
import { buildTextPreview, INLINE_TEXT_PREVIEW_MAX_CHARS } from "../../../../../lib/text-preview";
import type { ToolComponentProps } from "./get-tool-component";
import { ToolCallCodePanel } from "./tool-call-inspection";
import { ToolOutputImage } from "./tool-output-image";
import { useToolCallOutputDetail } from "./use-tool-call-output-detail";

function DetailCodePanel({ text, title }: { text: string; title: string }) {
  return (
    <ToolCallCodePanel
      title={title}
      preview={buildTextPreview(text, INLINE_TEXT_PREVIEW_MAX_CHARS)}
      getCopyText={() => text}
      getFullText={() => text}
      preClassName="font-mono text-size-code"
    />
  );
}

/**
 * An opened row for a tool with no presentation of its own: what its caller wrote, such as a
 * script, and what it returned. The rest of the exact call stays behind the row's inspector.
 */
export function DynamicToolDetails({ item }: { item: ToolComponentProps["item"] }) {
  const { error: outputError, available: outputAvailable } = useToolCallOutputDetail(
    item,
    true,
    item.dynamicToolCall?.outputOmitted,
  );
  const call = item.dynamicToolCall!;
  const outputTitle = call.success === false ? "Error" : "Output";
  const output: ReactNode = outputError ? (
    <p role="alert">{outputError}</p>
  ) : call.outputOmitted ? (
    <p className="text-token-description-foreground">
      {outputAvailable ? "Loading output…" : "Tool output unavailable"}
    </p>
  ) : (
    (call.contentItems ?? []).map((content, index) => (
      <Fragment key={index}>
        {content.type === "inputImage" ? (
          <ToolOutputImage source={content.imageUrl} />
        ) : content.type === "inputAudio" ? (
          <audio src={content.audioUrl} controls preload="metadata" />
        ) : (
          <DetailCodePanel text={formatToolOutputText(content.text)} title={outputTitle} />
        )}
      </Fragment>
    ))
  );

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {buildDynamicToolAuthoredPanels(call).map((panel, index) => (
        <DetailCodePanel key={index} text={panel.text} title={panel.title} />
      ))}
      {output}
    </div>
  );
}
