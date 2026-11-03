import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface UseSettingsListNavigationOptions<TItem> {
  items: readonly TItem[];
  isActive: boolean;
  autoHighlightFirst?: boolean;
  initialHighlightedIndex?: number;
  onSelect: (item: TItem, index: number) => void;
  onEscape?: () => void;
}

export function useSettingsListNavigation<TItem>({
  autoHighlightFirst = false,
  initialHighlightedIndex = -1,
  isActive,
  items,
  onEscape,
  onSelect,
}: UseSettingsListNavigationOptions<TItem>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(
    isActive && items.length > 0 && initialHighlightedIndex < items.length
      ? initialHighlightedIndex
      : -1,
  );

  const [previousInputs, setPreviousInputs] = useState({ isActive, length: items.length });
  if (previousInputs.isActive !== isActive || previousInputs.length !== items.length) {
    setPreviousInputs({ isActive, length: items.length });
    if (!isActive || items.length === 0 || highlightedIndex >= items.length)
      setHighlightedIndex(-1);
  }

  useEffect(() => {
    if (!isActive || highlightedIndex < 0 || highlightedIndex >= items.length) return;

    const highlightedItem = listRef.current
      ?.querySelectorAll<HTMLElement>('[data-list-navigation-item="true"]')
      .item(highlightedIndex);

    highlightedItem?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedIndex, isActive, items.length]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isActive) return;

    if (event.key === "Escape") {
      preventListNavigationDefault(event);
      onEscape?.();
      return;
    }

    if (items.length === 0) return;

    if (event.key === "ArrowDown") {
      preventListNavigationDefault(event);
      setHighlightedIndex((current) => nextHighlightedIndex(current, 1, items.length));
      return;
    }

    if (event.key === "ArrowUp") {
      preventListNavigationDefault(event);
      setHighlightedIndex((current) => nextHighlightedIndex(current, -1, items.length));
      return;
    }

    if (event.key !== "Enter") return;

    const selectedIndex = highlightedIndex >= 0 ? highlightedIndex : autoHighlightFirst ? 0 : -1;

    if (selectedIndex < 0 || selectedIndex >= items.length) return;

    preventListNavigationDefault(event);
    onSelect(items[selectedIndex], selectedIndex);
  };

  return {
    highlightedIndex,
    listRef,
    onKeyDown,
    setHighlightedIndex,
  };
}

function nextHighlightedIndex(currentIndex: number, direction: 1 | -1, itemCount: number): number {
  if (itemCount === 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : itemCount - 1;

  return (currentIndex + direction + itemCount) % itemCount;
}

function preventListNavigationDefault(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}
