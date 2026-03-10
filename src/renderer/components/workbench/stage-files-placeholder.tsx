export function StageFilesPlaceholder() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-(--background)">
      <div className="flex h-7 items-center justify-between border-b border-(--border) px-2">
        <span className="text-xs text-(--foreground-secondary)">Diff Preview</span>
        <span className="text-xs text-(--foreground-tertiary)">Mock</span>
      </div>
      <div className="scrollbar-token min-h-0 flex-1 space-y-1 overflow-auto p-2 font-mono text-xs">
        <div className="text-(--foreground-tertiary)">
          diff --git a/src/renderer/components/workbench/workbench-shell.tsx
          b/src/renderer/components/workbench/workbench-shell.tsx
        </div>
        <div className="text-(--green-text)">+ Added stage rail composition with niri-like focus model</div>
        <div className="text-(--green-text)">+ Moved terminal into a global bottom panel</div>
        <div className="text-(--red-text)">- Removed terminal stage from horizontal rail</div>
        <div className="mt-2 text-(--foreground-tertiary)">Diff surface is placeholder-only in this release.</div>
      </div>
    </div>
  );
}
