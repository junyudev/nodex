import { FileDiff, type FileDiffMetadata, type FileDiffProps } from "@pierre/diffs/react";
import { useEffect, useRef, type CSSProperties } from "react";

type InlineFileDiffOptions = NonNullable<FileDiffProps<undefined, undefined>["options"]>;

interface InlineFileDiffProps {
  fileDiff: FileDiffMetadata;
  className: string;
  style: CSSProperties;
  options: InlineFileDiffOptions;
  displayPath?: string | null;
}

function resolveDiffHost(wrapper: HTMLDivElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>("diffs-container.nodex-inline-diff");
}

export function InlineFileDiff({
  fileDiff,
  className,
  style,
  options,
  displayPath,
}: InlineFileDiffProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const host = resolveDiffHost(wrapper);
    if (!host) return;

    if (displayPath && displayPath.trim().length > 0) {
      host.setAttribute("data-file", displayPath);
    } else {
      host.removeAttribute("data-file");
    }
  }, [displayPath]);

  return (
    <div ref={wrapperRef}>
      <FileDiff fileDiff={fileDiff} className={className} style={style} options={options} />
    </div>
  );
}
