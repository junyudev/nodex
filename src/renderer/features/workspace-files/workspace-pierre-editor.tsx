import type { SupportedLanguages } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import {
  CodeView,
  EditProvider,
  type CodeViewHandle,
  type CodeViewItem,
  type FileContents,
} from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  NODEX_SOURCE_HOST_CLASS,
  getNodexSourceEditorHostStyle,
  getNodexSourceEditorLineHeight,
  getNodexSourceOptions,
} from "@/lib/diff-presentation";
import { useTheme } from "@/lib/use-theme";
import { useCodeFontSize } from "@/lib/use-code-font-size";
import { cn } from "@/lib/utils";
import {
  buildWorkspaceFileEditorSelection,
  buildWorkspaceFileLineSelection,
  buildWorkspaceFileScrollTarget,
} from "@/lib/workspace-file-reveal";

interface WorkspacePierreEditorProps {
  readonly value: string;
  readonly filename: string;
  readonly language: SupportedLanguages | null;
  readonly sourceIdentity: string;
  readonly documentVersion: number;
  readonly ariaLabel: string;
  readonly wrap?: boolean;
  readonly className?: string;
  readonly onChange: (value: string) => void;
  readonly onRevealComplete?: (
    location: NonNullable<WorkspacePierreEditorProps["revealLocation"]>,
  ) => void;
  readonly revealLocation?: {
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
  };
}

function createWorkspaceEditor(options: EditorOptions<undefined>): Editor<undefined> {
  return new Editor(options);
}

export function WorkspacePierreEditor({
  value,
  filename,
  language,
  sourceIdentity,
  documentVersion,
  ariaLabel,
  wrap = true,
  className,
  onChange,
  revealLocation,
  onRevealComplete,
}: WorkspacePierreEditorProps) {
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const [attachment, setAttachment] = useState<{
    sourceIdentity: string;
    editor: Editor<undefined>;
  } | null>(null);
  const { resolved } = useTheme();
  const { codeFontSize } = useCodeFontSize();
  const items = useMemo<CodeViewItem[]>(
    () => [
      {
        id: sourceIdentity,
        type: "file",
        edit: true,
        version: documentVersion,
        file: {
          name: filename,
          contents: value,
          cacheKey: `${sourceIdentity}:${documentVersion}`,
          lang: language ?? undefined,
        },
      },
    ],
    [documentVersion, filename, language, sourceIdentity, value],
  );
  const options = useMemo(
    () => ({
      ...getNodexSourceOptions(resolved, true, {
        disableLineNumbers: false,
        wrap,
      }),
      itemMetrics: {
        lineHeight: getNodexSourceEditorLineHeight(codeFontSize),
        spacing: 0,
      },
    }),
    [codeFontSize, resolved, wrap],
  );
  const style = useMemo(
    () => getNodexSourceEditorHostStyle(resolved, codeFontSize),
    [codeFontSize, resolved],
  );
  const handleEditChange = (_item: CodeViewItem, file: FileContents) => {
    onChange(file.contents);
  };

  useEffect(() => {
    if (!revealLocation?.line) return;
    if (attachment?.sourceIdentity !== sourceIdentity) return;
    const codeView = codeViewRef.current;
    if (!codeView) return;
    if (codeView.getEditor(sourceIdentity) !== attachment.editor) return;

    // onAttach is delivered after the editable document and its shadow DOM are ready.
    const editorSelection = buildWorkspaceFileEditorSelection(revealLocation);
    if (editorSelection) {
      codeView.setSelectedLines(null);
      attachment.editor.setSelections([editorSelection]);
    } else {
      codeView.setSelectedLines(buildWorkspaceFileLineSelection(sourceIdentity, revealLocation));
    }

    const target = buildWorkspaceFileScrollTarget(sourceIdentity, revealLocation);
    if (target) codeView.scrollTo(target);
    onRevealComplete?.(revealLocation);
  }, [attachment, onRevealComplete, revealLocation, sourceIdentity]);

  return (
    <section
      role="region"
      aria-label={ariaLabel}
      className={cn("h-full min-h-0 overflow-hidden", className)}
      data-workspace-pierre-editor="true"
    >
      <EditProvider createEditor={createWorkspaceEditor}>
        <CodeView
          ref={codeViewRef}
          items={items}
          options={options}
          editorOptions={{
            persistState: true,
            onAttach: (editor) => setAttachment({ sourceIdentity, editor }),
            clipboard: {
              readText: async () => {
                if (typeof navigator.clipboard?.readText !== "function") return "";
                return await navigator.clipboard.readText();
              },
            },
          }}
          disableWorkerPool
          onItemEditChange={handleEditChange}
          className={cn(NODEX_SOURCE_HOST_CLASS, "h-full min-h-0 overflow-auto")}
          style={style}
        />
      </EditProvider>
    </section>
  );
}
