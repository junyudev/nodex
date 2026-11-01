import type { SupportedLanguages } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewProps } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  NODEX_SOURCE_HOST_CLASS,
  getNodexDiffHostStyle,
  getNodexSourceOptions,
  getNodexSourceLineHeight,
  type NodexSyntaxTheme,
} from "@/lib/diff-presentation";
import { useTheme } from "@/lib/use-theme";
import { useCodeFontSize } from "@/lib/use-code-font-size";
import { cn } from "@/lib/utils";
import { getSourceContentDigest, sourceContentVersionOfDigest } from "@/lib/source-content-version";
import { mainThreadSourceLanguage, sourceHighlightCacheKey } from "@/lib/source-highlight-cache";
import {
  SourceHighlightPoolProvider,
  useSourceHighlightPoolState,
} from "@/lib/source-highlight-pool";
import {
  buildWorkspaceFileLineSelection,
  buildWorkspaceFileScrollTarget,
} from "@/lib/workspace-file-reveal";

export interface SourceViewerProps {
  readonly value: string;
  readonly ariaLabel: string;
  readonly filename?: string;
  readonly language?: SupportedLanguages | null;
  readonly lineNumbers?: boolean;
  readonly wrap?: boolean;
  readonly syntaxTheme?: NodexSyntaxTheme;
  readonly sourceIdentity?: string;
  readonly className?: string;
  readonly onRevealComplete?: (location: NonNullable<SourceViewerProps["revealLocation"]>) => void;
  readonly revealLocation?: {
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
  };
}

export function SourceViewer({
  value,
  ariaLabel,
  filename = "source.txt",
  language,
  lineNumbers = false,
  wrap = false,
  syntaxTheme = "source",
  sourceIdentity,
  className,
  revealLocation,
  onRevealComplete,
}: SourceViewerProps) {
  const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const [renderedIdentity, setRenderedIdentity] = useState<string | null>(null);
  const identity = sourceIdentity ?? filename;
  const { resolved } = useTheme();
  const { codeFontSize } = useCodeFontSize();
  const contentDigest = useMemo(() => getSourceContentDigest(value), [value]);
  const contentVersion = sourceContentVersionOfDigest(contentDigest);
  // The shared pool highlights the source palette; anywhere else large text stays plain.
  const highlightState = useSourceHighlightPoolState();
  const renderLanguage =
    syntaxTheme === "source" && highlightState === "working"
      ? language
      : mainThreadSourceLanguage(language, value.length);
  const file = useMemo(
    () => ({
      name: filename,
      contents: value,
      cacheKey: sourceHighlightCacheKey(identity, renderLanguage, value, contentDigest),
      lang: renderLanguage ?? undefined,
    }),
    [contentDigest, filename, identity, renderLanguage, value],
  );
  const items = useMemo(
    () => [
      {
        id: sourceIdentity ?? filename,
        type: "file" as const,
        version: contentVersion,
        file,
      },
    ],
    [contentVersion, file, filename, sourceIdentity],
  );
  const options = useMemo<NonNullable<CodeViewProps<undefined, undefined>["options"]>>(
    () => ({
      ...getNodexSourceOptions(resolved, true, {
        disableLineNumbers: !lineNumbers,
        wrap,
        syntaxTheme,
      }),
      itemMetrics: { lineHeight: getNodexSourceLineHeight(codeFontSize), spacing: 0 },
      onPostRender: (_node, _instance, phase) => {
        if (phase !== "unmount") setRenderedIdentity(identity);
      },
    }),
    [codeFontSize, identity, lineNumbers, resolved, syntaxTheme, wrap],
  );
  const style = useMemo(() => getNodexDiffHostStyle(resolved), [resolved]);

  useEffect(() => {
    if (!revealLocation?.line) return;
    if (renderedIdentity !== identity) return;
    const codeView = codeViewRef.current;
    if (!codeView) return;
    codeView.setSelectedLines(buildWorkspaceFileLineSelection(identity, revealLocation));
    const target = buildWorkspaceFileScrollTarget(identity, revealLocation);
    if (target) codeView.scrollTo(target);
    onRevealComplete?.(revealLocation);
  }, [identity, onRevealComplete, renderedIdentity, revealLocation]);

  return (
    <section
      role="region"
      aria-label={ariaLabel}
      className={cn("h-full min-h-0 overflow-hidden", className)}
      data-source-viewer="true"
      data-source-identity={sourceIdentity}
    >
      <SourceHighlightPoolProvider>
        <CodeView
          ref={codeViewRef}
          items={items}
          options={options}
          // The shared pool renders the source palette only.
          disableWorkerPool={syntaxTheme !== "source"}
          className={cn(NODEX_SOURCE_HOST_CLASS, "h-full min-h-0 overflow-auto")}
          style={style}
        />
      </SourceHighlightPoolProvider>
    </section>
  );
}
