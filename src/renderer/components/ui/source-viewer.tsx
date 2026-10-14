import type { SupportedLanguages } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef } from "react";
import {
  NODEX_SOURCE_HOST_CLASS,
  getNodexDiffHostStyle,
  getNodexSourceOptions,
  getNodexSourceLineHeight,
} from "@/lib/diff-presentation";
import { useTheme } from "@/lib/use-theme";
import { useCodeFontSize } from "@/lib/use-code-font-size";
import { cn } from "@/lib/utils";
import { getSourceContentVersion } from "@/lib/source-content-version";
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
  readonly sourceIdentity?: string;
  readonly className?: string;
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
  sourceIdentity,
  className,
  revealLocation,
}: SourceViewerProps) {
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const { resolved } = useTheme();
  const { codeFontSize } = useCodeFontSize();
  const contentVersion = useMemo(() => getSourceContentVersion(value), [value]);
  const file = useMemo(
    () => ({
      name: filename,
      contents: value,
      cacheKey: `${sourceIdentity ?? filename}:${contentVersion}`,
      lang: language ?? undefined,
    }),
    [contentVersion, filename, language, sourceIdentity, value],
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
  const options = useMemo(
    () => ({
      ...getNodexSourceOptions(resolved, true, {
        disableLineNumbers: !lineNumbers,
        wrap,
      }),
      itemMetrics: { lineHeight: getNodexSourceLineHeight(codeFontSize), spacing: 0 },
    }),
    [codeFontSize, lineNumbers, resolved, wrap],
  );
  const style = useMemo(() => getNodexDiffHostStyle(resolved), [resolved]);

  useEffect(() => {
    if (!revealLocation?.line) return;
    const frame = window.requestAnimationFrame(() => {
      const id = sourceIdentity ?? filename;
      const codeView = codeViewRef.current;
      if (!codeView) return;
      codeView.setSelectedLines(buildWorkspaceFileLineSelection(id, revealLocation));
      const target = buildWorkspaceFileScrollTarget(id, revealLocation);
      if (target) codeView.scrollTo(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filename, revealLocation, sourceIdentity]);

  return (
    <section
      role="region"
      aria-label={ariaLabel}
      className={cn("h-full min-h-0 overflow-hidden", className)}
      data-source-viewer="true"
      data-source-identity={sourceIdentity}
    >
      <CodeView
        ref={codeViewRef}
        items={items}
        options={options}
        disableWorkerPool
        className={cn(NODEX_SOURCE_HOST_CLASS, "h-full min-h-0 overflow-auto")}
        style={style}
      />
    </section>
  );
}
