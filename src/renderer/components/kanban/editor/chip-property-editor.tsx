import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { EMPTY_PRIORITY_OPTION_VALUE, KANBAN_PRIORITY_SELECT_OPTIONS } from "@/lib/kanban-options";
import { estimateOptions, estimateStyles } from "@/lib/types";
import {
  SELECTOR_MENU_CONTENT_CLASS_NAME,
  SELECTOR_MENU_ITEM_CLASS_NAME,
} from "@/components/ui/selector-menu-chrome";
import { columnStyles } from "../column";
import {
  TOGGLE_LIST_STATUS_ORDER,
  TOGGLE_LIST_STATUS_LABELS,
} from "@/lib/toggle-list/types";
import { cn } from "@/lib/utils";
import type { MetaChipPropertyType } from "@/lib/toggle-list/meta-chips";
import {
  tokenToPriorityValue,
  tokenToEstimateValue,
  tokenToStatusId,
} from "@/lib/toggle-list/meta-chips";

export interface ChipPropertyEditorProps {
  propertyType: Exclude<MetaChipPropertyType, "tag">;
  currentToken: string;
  cardId: string;
  anchorRect: DOMRect;
  onSelect: (propertyType: string, cardId: string, value: string) => void;
  onClose: () => void;
}

const MENU_GAP = 4;

function computePosition(
  anchorRect: DOMRect,
  menuRect: { width: number; height: number },
): { top: number; left: number } {
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  const spaceBelow = viewportH - anchorRect.bottom - MENU_GAP;
  const top = spaceBelow >= menuRect.height
    ? anchorRect.bottom + MENU_GAP
    : anchorRect.top - MENU_GAP - menuRect.height;

  let left = anchorRect.left;
  if (left + menuRect.width > viewportW - 8) {
    left = viewportW - menuRect.width - 8;
  }
  if (left < 8) left = 8;

  return { top: Math.max(4, top), left };
}

export function ChipPropertyEditor({
  propertyType,
  currentToken,
  cardId,
  anchorRect,
  onSelect,
  onClose,
}: ChipPropertyEditorProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const currentValue = resolveCurrentValue(propertyType, currentToken);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(computePosition(anchorRect, { width: rect.width, height: rect.height }));
  }, [anchorRect]);

  // Close on outside click
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Close on scroll of any ancestor
  useEffect(() => {
    const handleScroll = () => onClose();
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [onClose]);

  const handleSelect = useCallback(
    (value: string) => {
      onSelect(propertyType, cardId, value);
      onClose();
    },
    [cardId, onClose, onSelect, propertyType],
  );

  const items = getItemsForType(propertyType);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((i) => (i + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === "Enter" && highlightedIndex >= 0) {
        e.preventDefault();
        const item = items[highlightedIndex];
        if (item) handleSelect(item.value);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSelect, highlightedIndex, items]);

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        SELECTOR_MENU_CONTENT_CLASS_NAME,
        "fixed min-w-36 outline-none",
        position ? "opacity-100" : "invisible opacity-0",
      )}
      style={position ? { top: position.top, left: position.left } : undefined}
      role="listbox"
      aria-label={`Edit ${propertyType}`}
    >
      {items.map((item, index) => (
        <button
          key={item.value}
          type="button"
          role="option"
          aria-selected={item.value === currentValue}
          className={cn(
            SELECTOR_MENU_ITEM_CLASS_NAME,
            "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-none bg-transparent text-left text-inherit",
            index === highlightedIndex && "bg-token-list-hover-background",
          )}
          onPointerEnter={() => setHighlightedIndex(index)}
          onPointerLeave={() => setHighlightedIndex(-1)}
          onClick={() => handleSelect(item.value)}
        >
          <span className="min-w-0 truncate">
            {renderItemContent(propertyType, item)}
          </span>
          {item.value === currentValue && (
            <Check className="h-3.5 w-3.5 shrink-0 text-token-foreground" />
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
}

interface MenuItemData {
  value: string;
  label: string;
  className?: string;
  accentColor?: string;
}

function getItemsForType(propertyType: string): MenuItemData[] {
  switch (propertyType) {
    case "priority":
      return KANBAN_PRIORITY_SELECT_OPTIONS.map((opt) => ({
        value: opt.value,
        label: opt.label,
        className: opt.className,
      }));
    case "estimate":
      return estimateOptions.map((opt) => ({
        value: opt.value,
        label: opt.label,
        className: opt.value === "none" ? "" : estimateStyles[opt.value].className,
      }));
    case "status":
      return TOGGLE_LIST_STATUS_ORDER.map((statusId) => {
        const style = columnStyles[statusId];
        return {
          value: statusId,
          label: TOGGLE_LIST_STATUS_LABELS[statusId],
          accentColor: style?.accentColor ?? "#8E8B86",
        };
      });
    default:
      return [];
  }
}

function resolveCurrentValue(propertyType: string, token: string): string {
  switch (propertyType) {
    case "priority":
      return tokenToPriorityValue(token) ?? EMPTY_PRIORITY_OPTION_VALUE;
    case "estimate":
      return tokenToEstimateValue(token) ?? "none";
    case "status":
      return tokenToStatusId(token) ?? "";
    default:
      return "";
  }
}

function renderItemContent(propertyType: string, item: MenuItemData) {
  if (propertyType === "priority" && item.className) {
    if (item.value === EMPTY_PRIORITY_OPTION_VALUE) {
      return <span className="text-base text-(--foreground-tertiary)">{item.label}</span>;
    }
    return (
      <span className={cn("inline-flex h-5 items-center rounded-sm px-1.5 text-base/5 font-medium", item.className)}>
        {item.label}
      </span>
    );
  }

  if (propertyType === "estimate") {
    if (!item.className) {
      return <span className="text-base text-(--foreground-tertiary)">{item.label}</span>;
    }
    return (
      <span className={cn("inline-flex h-5 items-center rounded-sm px-1.5 text-base/5 font-medium", item.className)}>
        {item.label}
      </span>
    );
  }

  if (propertyType === "status" && item.accentColor) {
    return (
      <span className="inline-flex items-center gap-1.5 text-base">
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="shrink-0">
          <rect width="8" height="8" rx="4" fill={item.accentColor} />
        </svg>
        {item.label}
      </span>
    );
  }

  return <span>{item.label}</span>;
}
