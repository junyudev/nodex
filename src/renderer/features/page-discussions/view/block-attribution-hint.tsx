import { useEffect, useState } from "react";
import { useIntl } from "@/lib/i18n";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { NodexLogoMarkIcon } from "@/components/shared/icons/app-icons";
import type { PageDiscussionsController } from "../use-page-discussions-controller";

interface HoveredBlock {
  readonly blockId: string;
  readonly top: number;
}

/**
 * When the pointer rests on a Block Nodex wrote, says who Nodex wrote it for and when, at the
 * Block's top-right. Choosing it opens the Ask's Discussion, where the Ask can be undone.
 */
export function BlockAttributionHint({
  controller,
  origin,
}: {
  readonly controller: PageDiscussionsController;
  readonly origin: HTMLElement | null;
}) {
  const intl = useIntl();
  const [hovered, setHovered] = useState<HoveredBlock | null>(null);
  const { editor, writerOf } = controller;

  useEffect(() => {
    const root = editor?.domElement;
    if (!root || !origin) return;
    let frame = 0;
    let target: Element | null = null;
    const update = () => {
      frame = 0;
      const block = target?.closest<HTMLElement>(".bn-block[data-id]") ?? null;
      const blockId = block?.dataset.id ?? null;
      if (!block || !blockId || writerOf(blockId)?.actor.type !== "agent") {
        setHovered((current) => (current ? null : current));
        return;
      }
      const top = block.getBoundingClientRect().top - origin.getBoundingClientRect().top;
      setHovered((current) =>
        current?.blockId === blockId && current.top === top ? current : { blockId, top },
      );
    };
    const onMove = (event: PointerEvent) => {
      target = event.target instanceof Element ? event.target : null;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onLeave = (event: PointerEvent) => {
      if (
        event.relatedTarget instanceof Element &&
        event.relatedTarget.closest("[data-block-attribution]")
      )
        return;
      target = null;
      if (!frame) frame = requestAnimationFrame(update);
    };
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, [editor, origin, writerOf]);

  const writer = hovered ? writerOf(hovered.blockId) : null;
  if (!hovered || writer?.actor.type !== "agent") return null;
  const { run_id: runId, on_behalf_of: memberId } = writer.actor;
  const forName = controller.memberName(memberId);
  const discussion = runId
    ? (controller.views.find((view) => view.latestAsk?.runId === runId) ?? null)
    : null;
  const label = [
    forName
      ? intl.formatMessage(
          { id: "pageDiscussions.attribution.forMember", defaultMessage: "Nodex for {name}" },
          { name: forName },
        )
      : "Nodex",
    formatCompactRelativeTime(writer.writtenAtMs, controller.nowMs),
  ].join(" · ");
  return (
    <button
      type="button"
      data-block-attribution={hovered.blockId}
      disabled={!discussion}
      onClick={() => discussion && controller.setActiveId(discussion.id)}
      onPointerLeave={() => setHovered(null)}
      className="absolute right-0 z-10 flex h-5 -translate-y-full cursor-interaction items-center gap-1 rounded-md bg-token-main-surface-primary px-1.5 text-xs text-token-description-foreground ring-[0.5px] ring-token-border hover:text-token-foreground disabled:cursor-default"
      style={{ top: hovered.top }}
    >
      <NodexLogoMarkIcon className="size-3" monochrome />
      <span className="tabular-nums">{label}</span>
    </button>
  );
}
