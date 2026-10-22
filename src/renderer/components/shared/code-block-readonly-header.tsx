import {
  codeBlockActionDividerClassName,
  codeBlockActionSurfaceClassName,
} from "@/components/shared/code-block-action-chrome";
import { CodeBlockCopyButton } from "@/components/shared/code-block-copy-button";
import { resolveReadonlyCodeLanguage } from "@/lib/code-block-presentation";
import { cn } from "@/lib/utils";

export function CodeBlockReadOnlyHeader({
  language,
  code,
  disabled = false,
}: {
  /** A catalog ID or an authored fence info token. */
  readonly language: string;
  readonly code: string;
  /** An unfinished streaming fence cannot be copied. */
  readonly disabled?: boolean;
}) {
  const resolved = resolveReadonlyCodeLanguage(language);

  return (
    <div
      role="toolbar"
      aria-label="Code block read-only actions"
      data-nfm-code-block-readonly-header
      data-language-id={resolved.id}
      className={cn(
        "pointer-events-auto flex h-7 max-w-[180px] items-center gap-1 rounded-md px-1.5 font-sans text-xs",
        codeBlockActionSurfaceClassName,
      )}
    >
      <span className="min-w-0 max-w-[118px] truncate px-0.5 text-[var(--foreground-secondary)]">
        {resolved.label}
      </span>
      <span
        aria-hidden="true"
        className={cn("h-4 w-px shrink-0", codeBlockActionDividerClassName)}
      />
      <CodeBlockCopyButton text={code} disabled={disabled} />
    </div>
  );
}
