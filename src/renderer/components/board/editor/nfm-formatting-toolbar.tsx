import {
  ComponentsContext,
  FormattingToolbar,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useComponentsContext,
} from "@blocknote/react";
import {
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  ChevronDownIcon,
  DeleteIcon,
  FormattingToolbarLinkIcon,
} from "@/components/shared/icons";
import { ImagePlus, UploadCloud } from "@/components/shared/icons/generic-icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownPortal,
  NodexDropdownRoot,
  NodexDropdownSectionLabel,
  NodexDropdownSeparator,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CopyImageButton } from "./copy-image-button";
import {
  NfmFileActionMenu,
  NfmFileCaptionButton,
  NfmFileReplaceButton,
  type NfmFileAction,
} from "./nfm-file-action-menu";
import { NfmFileDownloadButton } from "./nfm-file-download-button";
import { NfmCreateLinkButton } from "./nfm-link-toolbar";
import { NfmTextActionMenu } from "./nfm-text-action-menu";
import type { NfmFormattingToolbarMode } from "./nfm-formatting-toolbar-controller";

const NfmFormattingToolbarIconContext = createContext<ReactNode | undefined>(undefined);

const NFM_LEGACY_FORMATTING_TOOLBAR_ICON_OVERRIDES: Record<string, ReactNode> = {
  fileDeleteButton: <DeleteIcon />,
  filePreviewButton: <ImagePlus />,
};

const NFM_LEGACY_FORMATTING_TOOLBAR_OMITTED_KEYS = new Set([
  "fileRenameButton",
  "textAlignLeftButton",
  "textAlignCenterButton",
  "textAlignRightButton",
]);

export function shouldRenderNfmLegacyFormattingToolbarItem(key: string): boolean {
  return !NFM_LEGACY_FORMATTING_TOOLBAR_OMITTED_KEYS.has(key);
}

function keepEditorSelection(event: MouseEvent | React.MouseEvent) {
  if ("button" in event && event.button !== 0) return;
  if ("preventDefault" in event) event.preventDefault();
}

function ToolbarRoot({
  className,
  children,
  onMouseEnter,
  onMouseLeave,
}: {
  className?: string;
  children?: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <div
      role="toolbar"
      contentEditable={false}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[12px] bg-token-dropdown-background/95 p-0.5 text-token-foreground shadow-lg ring-[0.5px] ring-token-border backdrop-blur-sm",
        "pointer-events-auto",
        className,
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  );
}

type ToolbarButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "className" | "disabled" | "onClick"
> & {
  className?: string;
  mainTooltip?: string;
  secondaryTooltip?: string;
  icon?: ReactNode;
  onClick?: (event: MouseEvent) => void;
  isSelected?: boolean;
  isDisabled?: boolean;
  children?: ReactNode;
  label?: string;
};

const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  {
    className,
    mainTooltip,
    secondaryTooltip,
    icon,
    onClick,
    isSelected = false,
    isDisabled = false,
    children,
    label,
    ...buttonProps
  },
  ref,
) {
  const iconOverride = useContext(NfmFormattingToolbarIconContext);
  const button = (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      contentEditable={false}
      aria-label={label}
      disabled={isDisabled}
      className={cn(
        "inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-[9px] px-2 text-[12px] leading-4 text-token-text-secondary outline-hidden transition-colors",
        "focus-visible:ring-1 focus-visible:ring-token-focus-border",
        !isDisabled && "hover:bg-token-foreground/6 hover:text-token-foreground",
        isSelected && "bg-token-foreground/10 text-token-foreground",
        isDisabled && "cursor-default opacity-40",
        className,
      )}
      onMouseDown={(event) => {
        keepEditorSelection(event);
        buttonProps.onMouseDown?.(event);
      }}
      onClick={(event) => {
        if (isDisabled) return;
        onClick?.(event);
      }}
    >
      {icon || iconOverride ? (
        <span className="shrink-0 [&_svg]:size-4">{iconOverride ?? icon}</span>
      ) : null}
      {children}
    </button>
  );

  if (!mainTooltip) return button;

  return (
    <NodexTooltip
      tooltipContent={mainTooltip}
      shortcutLabel={secondaryTooltip}
      side="top"
      sideOffset={6}
      delay={0}
    >
      {button}
    </NodexTooltip>
  );
});

function ToolbarSelect({
  className,
  items,
  isDisabled = false,
}: {
  className?: string;
  items: {
    text: string;
    icon: ReactNode;
    onClick: () => void;
    isSelected: boolean;
    isDisabled?: boolean;
  }[];
  isDisabled?: boolean;
}) {
  const selectedItem = items.find((item) => item.isSelected);
  if (!selectedItem) return null;

  return (
    <NodexDropdownRoot>
      <NodexDropdownTrigger disabled={isDisabled}>
        <button
          type="button"
          contentEditable={false}
          aria-label={selectedItem.text}
          className={cn(
            "inline-flex h-7 min-w-[7.5rem] items-center gap-1 rounded-[9px] px-2 text-[12px] leading-4 outline-hidden transition-colors",
            "text-token-foreground hover:bg-token-foreground/6 focus-visible:ring-1 focus-visible:ring-token-focus-border",
            isDisabled && "cursor-default opacity-40",
            className,
          )}
          onMouseDown={keepEditorSelection}
        >
          <span className="shrink-0 text-token-text-secondary [&_svg]:size-4">
            {selectedItem.icon}
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{selectedItem.text}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-token-text-secondary" />
        </button>
      </NodexDropdownTrigger>
      <NodexDropdownPortal>
        <NodexDropdownContent
          side="top"
          align="start"
          sideOffset={6}
          finalFocus={false}
          className="min-w-[13rem]"
        >
          <div dir="ltr">
            {items.map((item) => (
              <NodexDropdownItem
                key={item.text}
                disabled={item.isDisabled}
                leftSlot={
                  <span className="text-token-description-foreground [&_svg]:size-4">
                    {item.icon}
                  </span>
                }
                rightSlot={
                  item.isSelected ? (
                    <CheckmarkIcon className="size-4 text-token-foreground" />
                  ) : null
                }
                onPointerDownCapture={keepEditorSelection}
                onSelect={() => {
                  item.onClick();
                }}
              >
                {item.text}
              </NodexDropdownItem>
            ))}
          </div>
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>
  );
}

function MenuRoot({
  children,
  open,
  onOpenChange,
}: {
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <NodexDropdownRoot open={open} onOpenChange={onOpenChange}>
      {children}
    </NodexDropdownRoot>
  );
}

function MenuTrigger({ children }: { children?: ReactNode }) {
  if (!isValidElement(children)) return null;
  return <NodexDropdownTrigger>{children}</NodexDropdownTrigger>;
}

function MenuDropdown({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <NodexDropdownPortal>
      <NodexDropdownContent
        side="top"
        align="start"
        sideOffset={6}
        finalFocus={false}
        className={cn("min-w-[13rem]", className)}
      >
        <div dir="ltr">{children}</div>
      </NodexDropdownContent>
    </NodexDropdownPortal>
  );
}

function MenuItem({
  className,
  children,
  icon,
  checked,
  onClick,
  ...props
}: {
  className?: string;
  children?: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  onClick?: (event: Event) => void;
}) {
  return (
    <NodexDropdownItem
      className={className}
      leftSlot={
        icon ? (
          <span className="text-token-description-foreground [&_svg]:size-4">{icon}</span>
        ) : null
      }
      rightSlot={checked ? <CheckmarkIcon className="size-4 text-token-foreground" /> : null}
      onPointerDownCapture={keepEditorSelection}
      onSelect={(event) => {
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </NodexDropdownItem>
  );
}

function MenuLabel({ className, children }: { className?: string; children?: ReactNode }) {
  return <NodexDropdownSectionLabel className={className}>{children}</NodexDropdownSectionLabel>;
}

function PopoverRoot({
  children,
  open,
  onOpenChange,
}: {
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <NodexPopover open={open} onOpenChange={onOpenChange}>
      {children}
    </NodexPopover>
  );
}

function PopoverTrigger({ children }: { children?: ReactNode }) {
  return <NodexPopoverTrigger>{children}</NodexPopoverTrigger>;
}

function PopoverContent({
  children,
  className,
  variant,
}: {
  children?: ReactNode;
  className?: string;
  variant?: "form-popover" | "panel-popover";
}) {
  return (
    <NodexPopoverContent
      side="top"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      finalFocus={false}
      className={cn(
        "overflow-hidden gap-0 p-0",
        variant === "panel-popover" ? "w-[18rem]" : "w-[16.5rem]",
        className,
      )}
    >
      {children}
    </NodexPopoverContent>
  );
}

function FormRoot({ children }: { children?: ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>;
}

function FormTextInput({
  className,
  name,
  label,
  icon,
  value,
  autoFocus,
  placeholder,
  disabled,
  onKeyDown,
  onChange,
  autoComplete,
  "aria-activedescendant": ariaActivedescendant,
}: {
  className?: string;
  name: string;
  label?: string;
  icon: ReactNode;
  value: string;
  autoFocus?: boolean;
  placeholder?: string;
  disabled?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  autoComplete?: string;
  "aria-activedescendant"?: string;
}) {
  const iconOverride = useContext(NfmFormattingToolbarIconContext);

  return (
    <label className="flex flex-col gap-1.5">
      {label ? (
        <span className="text-[11px] leading-4 font-medium text-token-text-secondary">{label}</span>
      ) : null}
      <div className="flex items-center gap-2 rounded-md border-[0.5px] border-token-border bg-token-input-background px-2 py-1.5 shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--color-token-foreground)_2%,transparent)] focus-within:border-token-focus-border focus-within:ring-1 focus-within:ring-token-focus-border">
        <span className="shrink-0 text-token-description-foreground [&_svg]:size-4">
          {iconOverride ?? icon}
        </span>
        <input
          autoFocus={autoFocus}
          name={name}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete={autoComplete}
          aria-activedescendant={ariaActivedescendant}
          onChange={onChange}
          onKeyDown={onKeyDown}
          className={cn(
            "w-full appearance-none border-none bg-transparent text-[13px] leading-5 text-token-foreground outline-none placeholder:text-token-input-placeholder-foreground",
            className,
          )}
        />
      </div>
    </label>
  );
}

function FilePanelRoot({
  className,
  tabs,
  openTab,
  setOpenTab,
  loading,
}: {
  className?: string;
  tabs: {
    name: string;
    tabPanel: ReactNode;
  }[];
  openTab: string;
  setOpenTab: (name: string) => void;
  loading: boolean;
}) {
  const activeTab = tabs.find((tab) => tab.name === openTab) ?? tabs[0];

  return (
    <div
      className={cn(
        "flex w-full min-w-[18rem] flex-col gap-1.5 p-1.5 text-token-foreground",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Replace image source"
          className="inline-flex items-center gap-0.5 rounded-lg p-0.5"
        >
          {tabs.map((tab) => (
            <button
              key={tab.name}
              type="button"
              role="tab"
              aria-selected={tab.name === openTab}
              className={cn(
                "inline-flex h-6 items-center rounded-md px-2.5 text-xs leading-4 outline-hidden",
                tab.name === openTab
                  ? "bg-token-foreground/6 font-medium text-token-foreground"
                  : "text-token-text-secondary hover:bg-token-foreground/6 hover:text-token-foreground",
              )}
              onMouseDown={keepEditorSelection}
              onClick={() => {
                setOpenTab(tab.name);
              }}
            >
              {tab.name}
            </button>
          ))}
        </div>
        {loading ? (
          <ActivitySpinnerIcon className="size-3.5 text-token-description-foreground" />
        ) : null}
      </div>
      <div>{activeTab?.tabPanel}</div>
    </div>
  );
}

function FilePanelButton({
  className,
  onClick,
  children,
  label,
}: {
  className?: string;
  onClick: () => void;
  children?: ReactNode;
  label?: string;
}) {
  return (
    <NodexButton
      variant="outline"
      size="sm"
      className={cn(
        "w-full justify-center gap-1.5 rounded-lg border-token-border/70 bg-transparent px-2.5 text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground",
        className,
      )}
      onMouseDown={keepEditorSelection}
      onClick={onClick}
      aria-label={label}
    >
      <FormattingToolbarLinkIcon className="text-token-text-secondary" />
      {children ?? label}
    </NodexButton>
  );
}

function FilePanelTabPanel({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn("flex flex-col gap-1.5 p-0.5", className)}>{children}</div>;
}

function FilePanelTextInput({
  className,
  value,
  placeholder,
  onChange,
  onKeyDown,
}: {
  className?: string;
  value: string;
  placeholder: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      onKeyDown={onKeyDown}
      className={cn(
        "w-full rounded-md border-[0.5px] border-token-border bg-token-input-background px-2 py-1.5 text-[13px] leading-5 text-token-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border focus:ring-1 focus:ring-token-focus-border",
        className,
      )}
    />
  );
}

function FilePanelFileInput({
  accept,
  placeholder,
  onChange,
}: {
  accept: string;
  placeholder: string;
  onChange: (payload: File | null) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          onChange(event.currentTarget.files?.[0] ?? null);
          event.currentTarget.value = "";
        }}
      />
      <NodexButton
        variant="outline"
        size="sm"
        className="w-full justify-center gap-1.5 rounded-lg border-token-border/70 bg-transparent px-2.5 text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground"
        onMouseDown={keepEditorSelection}
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        <UploadCloud className="size-4 text-token-text-secondary" />
        {placeholder}
      </NodexButton>
    </div>
  );
}

export function NfmLegacyFormattingToolbar() {
  const editor = useBlockNoteEditor();
  const baseComponents = useComponentsContext()!;
  const [fileAction, setFileAction] = useState<NfmFileAction | null>(null);

  const closeFileAction = () => {
    setFileAction(null);
    editor.focus();
  };

  const toolbarItems = useMemo(() => {
    const items = getFormattingToolbarItems()
      .filter((item) => {
        const itemKey = typeof item.key === "string" ? item.key : "";
        return shouldRenderNfmLegacyFormattingToolbarItem(itemKey);
      })
      .map((item) => {
        if (item.key === "fileCaptionButton") {
          return (
            <NfmFileCaptionButton
              key="fileCaptionButton"
              onOpen={(blockId) => {
                setFileAction({ type: "caption", blockId });
              }}
            />
          );
        }

        if (item.key === "replaceFileButton") {
          return (
            <NfmFileReplaceButton
              key="replaceFileButton"
              onOpen={(blockId) => {
                setFileAction({ type: "replace", blockId });
              }}
            />
          );
        }

        if (item.key === "createLinkButton") {
          return <NfmCreateLinkButton key="createLinkButton" />;
        }

        if (item.key === "fileDownloadButton") {
          return <NfmFileDownloadButton key="fileDownloadButton" />;
        }

        const itemKey = typeof item.key === "string" ? item.key : "";
        const iconOverride = NFM_LEGACY_FORMATTING_TOOLBAR_ICON_OVERRIDES[itemKey];
        if (!iconOverride) return item;

        return (
          <NfmFormattingToolbarIconContext.Provider key={item.key} value={iconOverride}>
            {item}
          </NfmFormattingToolbarIconContext.Provider>
        );
      });
    const copyImageButton = <CopyImageButton key="copyImageButton" />;
    const fileDownloadButtonIndex = items.findIndex((item) => item.key === "fileDownloadButton");

    if (fileDownloadButtonIndex < 0) {
      return [...items, copyImageButton];
    }

    const itemsWithCopy = [...items];
    itemsWithCopy.splice(fileDownloadButtonIndex + 1, 0, copyImageButton);
    return itemsWithCopy;
  }, []);

  const components = useMemo(
    () => ({
      ...baseComponents,
      FormattingToolbar: {
        ...baseComponents.FormattingToolbar,
        Root: ToolbarRoot,
        Button: ToolbarButton,
        Select: ToolbarSelect,
      },
      Generic: {
        ...baseComponents.Generic,
        Menu: {
          ...baseComponents.Generic.Menu,
          Root: MenuRoot,
          Trigger: MenuTrigger,
          Dropdown: MenuDropdown,
          Divider: NodexDropdownSeparator,
          Label: MenuLabel,
          Item: MenuItem,
        },
        Popover: {
          ...baseComponents.Generic.Popover,
          Root: PopoverRoot,
          Trigger: PopoverTrigger,
          Content: PopoverContent,
        },
        Form: {
          ...baseComponents.Generic.Form,
          Root: FormRoot,
          TextInput: FormTextInput,
        },
      },
      FilePanel: {
        ...baseComponents.FilePanel,
        Root: FilePanelRoot,
        Button: FilePanelButton,
        FileInput: FilePanelFileInput,
        TabPanel: FilePanelTabPanel,
        TextInput: FilePanelTextInput,
      },
    }),
    [baseComponents],
  );

  return (
    <ComponentsContext.Provider value={components}>
      {fileAction ? (
        <NfmFileActionMenu action={fileAction} onClose={closeFileAction} />
      ) : (
        <FormattingToolbar>{toolbarItems}</FormattingToolbar>
      )}
    </ComponentsContext.Provider>
  );
}

export function NfmFormattingToolbar({ mode }: { mode: NfmFormattingToolbarMode }) {
  if (mode === "legacy") return <NfmLegacyFormattingToolbar />;
  return <NfmTextActionMenu />;
}
