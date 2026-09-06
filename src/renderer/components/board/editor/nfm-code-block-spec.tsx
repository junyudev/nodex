import {
  createCodeBlockConfig,
  createCodeBlockSpec,
  parsePreCode,
  parsePreCodeContent,
  type CodeBlockOptions,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { useSyncExternalStore, type RefCallback } from "react";
import { codeBlockViewState, type MermaidCodePreviewMode } from "@/lib/nfm/code-block-view-state";
import { cn } from "@/lib/utils";
import { getCodeBlockPlainText } from "@/lib/nfm/code-block-model";
import { CodeBlockReadOnlyHeader } from "@/components/shared/code-block-readonly-header";
import { useTheme } from "@/lib/use-theme";
import { resolveCodeLanguage } from "../../../../shared/nfm/code-language-catalog";
import { MermaidCodePreview } from "./mermaid-code-preview";

export interface NfmCodeBlockSpecOptions extends CodeBlockOptions {
  readonly presentation?: "editable" | "readonly";
}

interface NfmCodeBlockSurfaceProps {
  readonly blockId: string;
  readonly language: string;
  readonly contentRef: RefCallback<HTMLElement>;
  readonly wrapped: boolean;
  readonly code: string;
  readonly mermaidMode: MermaidCodePreviewMode;
  readonly readOnlyCode?: string;
}

function NfmCodeBlockSurface({
  blockId,
  language,
  contentRef,
  wrapped,
  code,
  mermaidMode,
  readOnlyCode,
}: NfmCodeBlockSurfaceProps) {
  const { resolved: theme } = useTheme();
  const isMermaid = language === "mermaid";
  const showCode = !isMermaid || mermaidMode !== "preview";
  const showPreview = isMermaid && mermaidMode !== "code";

  return (
    <figure
      data-nfm-code-block-surface
      data-block-id={blockId}
      data-language={language}
      data-wrapped={String(wrapped)}
      data-mermaid-preview-mode={isMermaid ? mermaidMode : undefined}
      className="relative m-0 w-full overflow-hidden rounded-[10px] bg-[var(--code-block-bg)] py-6 text-[var(--foreground)]"
    >
      <div
        contentEditable={false}
        data-nfm-code-block-action-anchor
        className="pointer-events-none absolute top-1 right-1 z-[2]"
      >
        {readOnlyCode === undefined ? null : (
          <CodeBlockReadOnlyHeader languageId={language} code={readOnlyCode} />
        )}
      </div>
      <div
        data-nfm-code-source-region
        aria-hidden={!showCode || undefined}
        inert={!showCode}
        className={cn(
          !showCode && "pointer-events-none absolute size-px overflow-hidden opacity-0",
        )}
      >
        <pre
          className={cn("m-0 px-[22px] py-3", wrapped ? "overflow-x-hidden" : "overflow-x-auto")}
        >
          <code
            ref={contentRef}
            data-language={language}
            className={cn(
              "block min-w-0 font-mono text-[13.6px] leading-[20.4px] [tab-size:2]",
              wrapped ? "break-all whitespace-break-spaces" : "whitespace-pre",
            )}
          />
        </pre>
      </div>
      {showPreview ? (
        <MermaidCodePreview
          source={code}
          theme={theme}
          className={cn(showCode && "mt-3 border-t-[0.5px] border-[var(--border)]")}
        />
      ) : null}
    </figure>
  );
}

function LocalWrapCodeBlockSurface(
  props: Omit<NfmCodeBlockSurfaceProps, "wrapped" | "mermaidMode">,
) {
  const wrapped = useSyncExternalStore(
    (listener) => codeBlockViewState.subscribe(props.blockId, listener),
    () => codeBlockViewState.getWrapped(props.blockId),
    () => false,
  );
  const mermaidMode = useSyncExternalStore(
    (listener) => codeBlockViewState.subscribe(props.blockId, listener),
    () => codeBlockViewState.getMermaidPreviewMode(props.blockId),
    () => "split" as const,
  );
  return <NfmCodeBlockSurface {...props} wrapped={wrapped} mermaidMode={mermaidMode} />;
}

export const createNfmCodeBlockSpec = createReactBlockSpec(
  (options: Partial<NfmCodeBlockSpecOptions>) => createCodeBlockConfig(options),
  (options) => ({
    meta: {
      code: true,
      defining: true,
      isolating: false,
      highlight: (block) => resolveCodeLanguage(block.props.language).shikiLanguage ?? undefined,
    },
    parse: parsePreCode,
    parseContent: (options) => parsePreCodeContent(options, "codeBlock"),
    render: ({ block, contentRef }) => {
      const props = {
        blockId: block.id,
        language: block.props.language,
        contentRef,
        code: getCodeBlockPlainText(block),
      };
      if (options.presentation === "readonly") {
        return (
          <NfmCodeBlockSurface
            {...props}
            wrapped={false}
            mermaidMode="preview"
            readOnlyCode={getCodeBlockPlainText(block)}
          />
        );
      }
      return <LocalWrapCodeBlockSurface {...props} />;
    },
    toExternalHTML: ({ block, contentRef }) => (
      <pre>
        <code
          ref={contentRef}
          className={`language-${block.props.language}`}
          data-language={block.props.language}
        />
      </pre>
    ),
  }),
  (options) => createCodeBlockSpec(options).extensions ?? [],
);
