import { useLayoutEffect, useRef, useState } from "react";
import { CodeBlockCopyButton } from "streamdown";
import { CheckmarkIcon, CopyIcon } from "@/components/shared/icons";
import { writeTextToClipboard } from "../clipboard";

interface CopyLifetime {
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

/** The public button has one authored-source writer, including the desktop clipboard fallback. */
export function MarkdownCodeCopyButton({
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
    const lifetime: CopyLifetime = { active: true, pending: false, timeout: null };
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
    if (!lifetime?.active || lifetime.pending || disabled || copied) return;
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
    <CodeBlockCopyButton
      code={text}
      disabled={disabled}
      aria-label={copied ? "Copied code" : "Copy code"}
      onClick={() => void onCopy()}
    >
      {copied ? (
        <CheckmarkIcon className="size-3.5" aria-hidden />
      ) : (
        <CopyIcon className="size-3.5" aria-hidden />
      )}
    </CodeBlockCopyButton>
  );
}
