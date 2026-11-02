import { Menubar } from "@base-ui/react/menubar";
import { Menu } from "@base-ui/react/menu";
import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from "react";
import type {
  ApplicationMenuEntry,
  ApplicationMenuSnapshot,
} from "../../../shared/application-menu";
import { applicationMenu, type ApplicationMenuAdapter } from "@/lib/application-menu";
import {
  formatWindowsMenuAccelerator,
  resolveApplicationMenubarKey,
} from "@/lib/application-menubar-keyboard";
import {
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownPortal,
  NodexDropdownSeparator,
  NodexDropdownSubmenu,
  NodexDropdownSubmenuContent,
  NodexDropdownSubmenuTrigger,
} from "./dropdown";
import { NodexMenuRowContent } from "./menu-row";
import { CheckmarkIcon, ChevronRightIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";

function MenuEntries({
  items,
  invoke,
}: {
  readonly items: readonly ApplicationMenuEntry[];
  readonly invoke: (id: string) => void;
}) {
  return items.map((item) => {
    if (item.type === "separator") return <NodexDropdownSeparator key={item.id} />;
    if (item.type === "submenu")
      return (
        <NodexDropdownSubmenu key={item.id}>
          <NodexDropdownSubmenuTrigger disabled={!item.enabled}>
            <NodexMenuRowContent
              trailing={<ChevronRightIcon className="icon-xs text-token-description-foreground" />}
            >
              {item.label}
            </NodexMenuRowContent>
          </NodexDropdownSubmenuTrigger>
          <NodexDropdownPortal>
            <NodexDropdownSubmenuContent
              motion="none"
              className="m-0"
              style={applicationMenuPopupStyle(180)}
            >
              <MenuEntries items={item.items} invoke={invoke} />
            </NodexDropdownSubmenuContent>
          </NodexDropdownPortal>
        </NodexDropdownSubmenu>
      );
    return (
      <NodexDropdownItem
        key={item.id}
        disabled={!item.enabled}
        onSelect={() => invoke(item.id)}
        role={
          item.type === "item"
            ? "menuitem"
            : item.type === "checkbox"
              ? "menuitemcheckbox"
              : "menuitemradio"
        }
        aria-checked={item.type === "item" ? undefined : item.checked}
        leftSlot={item.checked ? <CheckmarkIcon className="icon-xs" /> : undefined}
        keyboardShortcut={
          item.accelerator ? formatWindowsMenuAccelerator(item.accelerator) : undefined
        }
      >
        {item.label}
      </NodexDropdownItem>
    );
  });
}

function applicationMenuPopupStyle(minWidth: number): CSSProperties {
  return {
    zoom: "var(--codex-window-zoom, 1)",
    minWidth: `min(${minWidth}px, calc((100vw - 12px) / var(--codex-window-zoom, 1)))`,
    maxWidth:
      "min(calc(var(--available-width) / var(--codex-window-zoom, 1)), calc((100vw - 12px) / var(--codex-window-zoom, 1)))",
    maxHeight:
      "min(calc(var(--available-height) / var(--codex-window-zoom, 1)), calc((100vh - 12px) / var(--codex-window-zoom, 1)))",
  };
}

/** Windows native menu presentation. Main remains the only command/state authority. */
export function NodexApplicationMenubar({
  adapter = applicationMenu,
}: {
  readonly adapter?: ApplicationMenuAdapter;
}) {
  const [snapshot, setSnapshot] = useState<ApplicationMenuSnapshot>({ menus: [] });
  const [openId, setOpenId] = useState<string | null>(null);
  const [mnemonics, setMnemonics] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const altPending = useRef(false);
  const focusMode = useRef(false);
  const request = useRef({ generation: 0 });

  useEffect(() => {
    let active = true;
    const pending = request.current;
    void adapter
      .read()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch(() => {});
    return () => {
      active = false;
      pending.generation++;
    };
  }, [adapter]);

  const rememberFocus = () => {
    if (previousFocus.current || bar.current?.contains(document.activeElement)) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const close = (restore: boolean) => {
    setOpenId(null);
    setMnemonics(false);
    altPending.current = false;
    focusMode.current = false;
    request.current.generation++;
    const element = previousFocus.current;
    previousFocus.current = null;
    if (restore)
      queueMicrotask(() => {
        if (element?.isConnected) element.focus();
      });
  };
  const open = async (index: number) => {
    rememberFocus();
    const token = ++request.current.generation;
    const next = await adapter.read().catch(() => null);
    if (!next || token !== request.current.generation || !next.menus[index]?.enabled) return;
    setSnapshot(next);
    setOpenId(next.menus[index]?.id ?? null);
  };
  const onKey = useEffectEvent((event: KeyboardEvent, phase: "down" | "up") => {
    const action = resolveApplicationMenubarKey(
      event,
      { altPending: altPending.current, focused: focusMode.current, open: openId !== null },
      phase,
    );
    if (action === null) return;
    if (action === "alt") {
      altPending.current = true;
      setMnemonics(true);
      return;
    }
    if (action === "cancel-alt") {
      altPending.current = false;
      if (!focusMode.current) setMnemonics(false);
      return;
    }
    if (typeof action === "object") {
      const index = snapshot.menus.findIndex(
        (menu) => menu.enabled && menu.label[0]?.toLowerCase() === action.mnemonic,
      );
      altPending.current = false;
      if (index < 0) {
        if (!focusMode.current) setMnemonics(false);
        return;
      }
      rememberFocus();
      focusMode.current = true;
      setMnemonics(true);
      bar.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus();
      void open(index);
    } else if (action === "close" || focusMode.current || openId !== null) close(true);
    else {
      rememberFocus();
      focusMode.current = true;
      altPending.current = false;
      setMnemonics(true);
      bar.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
        ?.focus();
    }
    event.preventDefault();
    event.stopPropagation();
  });
  const onBlur = useEffectEvent(() => close(false));
  useEffect(() => {
    const down = (event: KeyboardEvent) => onKey(event, "down");
    const up = (event: KeyboardEvent) => onKey(event, "up");
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const invoke = (id: string) => {
    close(true);
    void adapter.invoke(id).catch(() => {});
  };
  return (
    <Menubar
      ref={bar}
      aria-label="Application menu"
      modal={false}
      className="no-drag flex h-full min-w-0 items-center"
      onBlurCapture={(event) => {
        if (openId === null && !event.currentTarget.contains(event.relatedTarget)) close(false);
      }}
      onPointerDownCapture={rememberFocus}
    >
      {snapshot.menus.map((menu, index) => (
        <Menu.Root
          key={menu.label}
          open={openId === menu.id}
          onOpenChange={(value, details) => {
            if (value) {
              void open(index);
              return;
            }
            if (details.reason === "sibling-open") return;
            close(details.reason === "escape-key" || details.reason === "item-press");
          }}
        >
          <Menu.Trigger
            disabled={!menu.enabled}
            className={cn(
              "no-drag h-7 shrink-0 rounded-md px-2 text-sm text-token-text-primary outline-hidden hover:bg-token-list-hover-background data-popup-open:bg-token-list-active-selection-background focus-visible:bg-token-list-hover-background forced-colors:focus-visible:bg-[Highlight] forced-colors:focus-visible:text-[HighlightText] forced-colors:focus-visible:forced-color-adjust-none",
            )}
          >
            <NodexMenuRowContent>
              <span className={mnemonics ? "underline underline-offset-2" : undefined}>
                {menu.label[0]}
              </span>
              {menu.label.slice(1)}
            </NodexMenuRowContent>
          </Menu.Trigger>
          <NodexDropdownPortal>
            <NodexDropdownContent
              motion="none"
              collisionPadding={6}
              sideOffset={2}
              finalFocus={false}
              className="m-0"
              style={applicationMenuPopupStyle(220)}
            >
              <MenuEntries items={menu.items} invoke={invoke} />
            </NodexDropdownContent>
          </NodexDropdownPortal>
        </Menu.Root>
      ))}
    </Menubar>
  );
}
