import { useLayoutEffect, useRef, useState } from "react";
import { CheckmarkIcon, CopyIcon } from "@/components/shared/icons";
import { codeBlockActionButtonClassName } from "@/components/shared/code-block-action-chrome";
import { NodexTooltip } from "@/components/ui/tooltip";
import { writeTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface CopyLifetime {
  readonly text: string;
  active: boolean;
  pending: boolean;
  timeout: number | null;
}

async function copyCode(text: string): Promise<boolean> {
  try {
    return await writeTextToClipboard(text);
  } catch {
    return false;
  }
}

/** Copies authored source through the desktop clipboard fallback; feedback is bound to that source. */
export function CodeBlockCopyButton({
  text,
  disabled,
}: {
  readonly text: string;
  readonly disabled: boolean;
}) {
  const [feedback, setFeedback] = useState({ text, copied: false });
  if (feedback.text !== text) setFeedback({ text, copied: false });
  const lifetimeRef = useRef<CopyLifetime | null>(null);
  useLayoutEffect(() => {
    const lifetime: CopyLifetime = { text, active: true, pending: false, timeout: null };
    lifetimeRef.current = lifetime;
    return () => {
      lifetime.active = false;
      if (lifetime.timeout !== null) window.clearTimeout(lifetime.timeout);
      if (lifetimeRef.current === lifetime) lifetimeRef.current = null;
    };
  }, [text]);
  const copied = feedback.text === text && feedback.copied;
  const onCopy = async () => {
    const lifetime = lifetimeRef.current;
    if (!lifetime?.active || lifetime.text !== text || lifetime.pending || disabled || copied)
      return;
    lifetime.pending = true;
    const accepted = await copyCode(text);
    lifetime.pending = false;
    if (!accepted || !lifetime.active) return;
    setFeedback({ text, copied: true });
    lifetime.timeout = window.setTimeout(() => {
      lifetime.timeout = null;
      if (lifetime.active) setFeedback({ text, copied: false });
    }, 2_000);
  };
  return (
    <NodexTooltip tooltipContent={copied ? "Copied" : "Copy code"}>
      <button
        type="button"
        className={cn(codeBlockActionButtonClassName, "shrink-0")}
        data-code-block-action="copy"
        disabled={disabled}
        aria-label={copied ? "Copied code" : "Copy code to clipboard"}
        onClick={() => void onCopy()}
      >
        {copied ? <CheckmarkIcon aria-hidden /> : <CopyIcon aria-hidden />}
      </button>
    </NodexTooltip>
  );
}
