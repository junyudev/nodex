export function DropIndicator() {
  return (
    <div className="relative z-10 my-[calc(var(--spacing)*-0.75)] h-0.5">
      {/* Circle on left edge */}
      <div
        className="absolute top-1/2 left-0 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
        style={{ backgroundColor: "var(--column-accent)" }}
      />
      {/* Line */}
      <div
        className="ml-0.75 h-full rounded-full"
        style={{ backgroundColor: "var(--column-accent)" }}
      />
    </div>
  );
}
