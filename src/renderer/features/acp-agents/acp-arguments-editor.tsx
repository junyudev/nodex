import { useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { CloseIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { splitPastedAcpArguments } from "./acp-agent-model";
import type { AcpArgumentDraft } from "./acp-agent-draft";

const ARGUMENT_LIMIT = 256;

/**
 * Launch arguments as separate values, never joined into a shell line. An empty field is an
 * empty argument; a saved argument containing a line break keeps it in a multi-line field.
 * Enter adds the next argument, and pasting several lines adds one argument per line.
 */
export function AcpArgumentsEditor({
  value,
  disabled,
  className,
  onChange,
}: {
  readonly value: readonly AcpArgumentDraft[];
  readonly disabled: boolean;
  readonly className?: string;
  readonly onChange: (next: AcpArgumentDraft[]) => void;
}) {
  // The row created by Enter or paste takes focus once, when it mounts.
  const [focusId, setFocusId] = useState<string | null>(null);
  const replace = (index: number, rows: readonly AcpArgumentDraft[]) =>
    onChange(
      [...value.slice(0, index), ...rows, ...value.slice(index + 1)].slice(0, ARGUMENT_LIMIT),
    );
  const insertAfter = (index: number) => {
    const row = { id: crypto.randomUUID(), value: "" };
    setFocusId(row.id);
    onChange([...value.slice(0, index + 1), row, ...value.slice(index + 1)]);
  };
  const paste = (event: ClipboardEvent<HTMLInputElement>, index: number) => {
    const text = event.clipboardData.getData("text/plain");
    if (!/\r?\n/u.test(text)) return;
    event.preventDefault();
    const lines = splitPastedAcpArguments(text);
    if (lines.length === 0) return;
    const input = event.currentTarget;
    const current = value[index]!.value;
    const before = current.slice(0, input.selectionStart ?? current.length);
    const after = current.slice(input.selectionEnd ?? current.length);
    const rows = lines.map((line, position) => ({
      id: position === 0 ? value[index]!.id : crypto.randomUUID(),
      value: (position === 0 ? before : "") + line + (position === lines.length - 1 ? after : ""),
    }));
    setFocusId(rows[rows.length - 1]!.id);
    replace(index, rows);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (value.length < ARGUMENT_LIMIT) insertAfter(index);
  };
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {value.map((row, index) => {
        const label = `Argument ${index + 1}`;
        const common = {
          "aria-label": label,
          value: row.value,
          disabled,
          spellCheck: false,
          autoFocus: row.id === focusId,
          placeholder: "Empty argument",
          className: "min-w-0 flex-1 font-mono text-xs",
        };
        return (
          <div key={row.id} className="flex items-start gap-1">
            {row.value.includes("\n") ? (
              <Textarea
                {...common}
                rows={Math.min(6, row.value.split("\n").length)}
                onChange={(event) => replace(index, [{ ...row, value: event.target.value }])}
              />
            ) : (
              <Input
                {...common}
                className={cn(common.className, "h-7")}
                onPaste={(event) => paste(event, index)}
                onKeyDown={(event) => keyDown(event, index)}
                onChange={(event) => replace(index, [{ ...row, value: event.target.value }])}
              />
            )}
            <NodexIconButton
              size="sm"
              icon={CloseIcon}
              ariaLabel={`Remove argument ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(value.filter(({ id }) => id !== row.id))}
            />
          </div>
        );
      })}
      <div>
        <NodexButton
          size="xs"
          variant="ghost"
          disabled={disabled || value.length >= ARGUMENT_LIMIT}
          onClick={() => insertAfter(value.length - 1)}
        >
          Add argument
        </NodexButton>
      </div>
    </div>
  );
}
