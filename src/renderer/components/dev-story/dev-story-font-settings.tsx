import { RotateCcw } from "lucide-react";
import {
  DEFAULT_CODE_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
} from "../../lib/code-font-size";
import {
  DEFAULT_SANS_FONT_SIZE,
  MAX_SANS_FONT_SIZE,
  MIN_SANS_FONT_SIZE,
} from "../../lib/sans-font-size";
import { cn } from "../../lib/utils";

interface FontSizeControlProps {
  label: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
}

interface DevStoryFontSettingsSectionProps {
  sansFontSize: number;
  codeFontSize: number;
  setSansFontSize: (value: number) => void;
  setCodeFontSize: (value: number) => void;
}

function FontSizeControl({
  label,
  ariaLabel,
  value,
  min,
  max,
  defaultValue,
  onChange,
}: FontSizeControlProps) {
  const isDefault = value === defaultValue;

  return (
    <label className="block text-xs text-(--foreground-secondary)">
      <div className="mb-1">{label}</div>
      <div className="flex items-center gap-3 rounded-md border border-(--border) bg-(--background) px-2.5 py-2">
        <span className="w-10 shrink-0 text-right text-sm text-(--foreground-secondary) tabular-nums">
          {value}px
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={ariaLabel}
          className="min-w-0 flex-1 accent-(--accent-blue)"
          onChange={(event) => {
            const nextValue = Number.parseInt(event.target.value, 10);
            if (!Number.isFinite(nextValue)) return;
            onChange(nextValue);
          }}
        />
        <button
          type="button"
          disabled={isDefault}
          onClick={() => onChange(defaultValue)}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-sm",
            isDefault
              ? "border-transparent bg-foreground-5 text-(--foreground-secondary) opacity-60"
              : "border-(--border) text-(--foreground-secondary) hover:bg-foreground-5 hover:text-(--foreground)",
            "disabled:cursor-not-allowed",
          )}
        >
          <RotateCcw className="size-3.5" />
          <span>Default</span>
        </button>
      </div>
    </label>
  );
}

export function DevStoryFontSettingsSection({
  sansFontSize,
  codeFontSize,
  setSansFontSize,
  setCodeFontSize,
}: DevStoryFontSettingsSectionProps) {
  return (
    <div className="space-y-2.5">
      <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">
        Typography
      </div>
      <div className="rounded-md border border-(--border) bg-(--background) px-2.5 py-2 text-xs/relaxed text-(--foreground-secondary)">
        Applies only inside dev stories. App-wide editor font settings stay unchanged.
      </div>
      <div className="space-y-2">
        <FontSizeControl
          label="Dev story sans font size"
          ariaLabel="Dev story sans font size"
          value={sansFontSize}
          min={MIN_SANS_FONT_SIZE}
          max={MAX_SANS_FONT_SIZE}
          defaultValue={DEFAULT_SANS_FONT_SIZE}
          onChange={setSansFontSize}
        />
        <FontSizeControl
          label="Dev story code font size"
          ariaLabel="Dev story code font size"
          value={codeFontSize}
          min={MIN_CODE_FONT_SIZE}
          max={MAX_CODE_FONT_SIZE}
          defaultValue={DEFAULT_CODE_FONT_SIZE}
          onChange={setCodeFontSize}
        />
      </div>
    </div>
  );
}
