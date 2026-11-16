import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useState, type ReactNode } from "react";
import {
  PROJECT_MARKER_COLORS,
  PROJECT_MARKER_COLOR_LABEL_MESSAGES,
  PROJECT_MARKER_ICONS,
  PROJECT_MARKER_ICON_LABEL_MESSAGES,
  selectProjectMarkerColor,
  selectProjectMarkerIcon,
  type ProjectAppearance,
  type ProjectMarkerColor,
  type ProjectMarkerIcon,
} from "../../../shared/project-appearance";
import { NodexButton } from "@/components/ui/button";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { PROJECT_MARKER_COLOR_CLASSES, ProjectMarker } from "./project-marker";
import { ProjectMarkerIconSvg } from "@/components/shared/icons";

export interface ProjectMarkerPickerProps {
  appearance: ProjectAppearance;
  onAppearanceChange: (appearance: ProjectAppearance) => void;
  projectName: string;
  buttonClassName?: string;
  contentClassName?: string;
  defaultOpen?: boolean;
  disabled?: boolean;
  fallbackIcon?: ReactNode;
  headerAction?: ReactNode;
  headerLabel?: ReactNode;
  markerClassName?: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  pending?: boolean;
  portalled?: boolean;
  showDividers?: boolean;
  colorGroupLabel?: ReactNode;
  iconGroupLabel?: ReactNode;
}

export function ProjectMarkerPicker({
  appearance,
  onAppearanceChange,
  projectName,
  buttonClassName,
  contentClassName,
  defaultOpen = false,
  disabled = false,
  fallbackIcon,
  headerAction,
  headerLabel,
  markerClassName,
  onOpenChange,
  open,
  pending = false,
  portalled = true,
  showDividers = true,
  colorGroupLabel,
  iconGroupLabel,
}: ProjectMarkerPickerProps) {
  const intl = useIntl();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = open ?? internalOpen;
  const interactionDisabled = disabled || pending;

  function setOpen(nextOpen: boolean) {
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  function selectColor(color: ProjectMarkerColor) {
    if (interactionDisabled) return;
    onAppearanceChange(selectProjectMarkerColor(appearance, color));
  }

  function selectIcon(icon: ProjectMarkerIcon) {
    if (interactionDisabled) return;
    onAppearanceChange(selectProjectMarkerIcon(appearance, icon));
  }

  const selectedIcon = appearance.marker.kind === "icon" ? appearance.marker.icon : null;

  return (
    <NodexPopover open={isOpen} onOpenChange={setOpen}>
      <NodexPopoverTrigger>
        <NodexButton
          variant="ghost"
          size="icon-sm"
          disabled={interactionDisabled}
          aria-busy={pending || undefined}
          aria-label={intl.formatMessage(
            {
              id: "workbench.projectMarkerPicker.changeMarker",
              defaultMessage: "Change marker for {project}",
            },
            { project: projectName },
          )}
          className={cn("h-7 w-7 rounded-md p-1", buttonClassName)}
        >
          <ProjectMarker
            appearance={appearance}
            fallbackIcon={fallbackIcon}
            className={markerClassName}
          />
        </NodexButton>
      </NodexPopoverTrigger>

      <NodexPopoverContent
        aria-label={intl.formatMessage(
          {
            id: "workbench.projectMarkerPicker.marker",
            defaultMessage: "Project marker for {project}",
          },
          { project: projectName },
        )}
        align="center"
        sideOffset={6}
        portalled={portalled}
        className={cn(
          "w-[260px] gap-0 rounded-xl bg-token-main-surface-primary p-0",
          contentClassName,
        )}
        aria-busy={pending || undefined}
      >
        {headerLabel != null ? (
          <div
            className={cn(
              "flex h-10 items-center justify-between px-3",
              showDividers && "border-b border-token-border",
            )}
          >
            <div className="min-w-0 truncate text-sm font-medium text-token-text-primary">
              {headerLabel}
            </div>
            {headerAction != null ? (
              <div className="flex shrink-0 items-center">{headerAction}</div>
            ) : null}
          </div>
        ) : null}

        {colorGroupLabel != null ? (
          <div className="px-3 pt-3 text-xs font-medium text-token-description-foreground">
            {colorGroupLabel}
          </div>
        ) : null}
        <div
          role="group"
          aria-label={intl.formatMessage({
            id: "workbench.projectMarkerPicker.projectColor",
            defaultMessage: "Project color",
          })}
          className={cn(
            "grid grid-cols-[repeat(auto-fit,minmax(36px,1fr))] gap-1 px-3 pb-2",
            colorGroupLabel == null ? "pt-3" : "pt-1",
          )}
        >
          {PROJECT_MARKER_COLORS.map((color) => {
            const selected = appearance.color === color;
            return (
              <button
                key={color}
                type="button"
                disabled={interactionDisabled}
                aria-label={intl.formatMessage(
                  { id: "workbench.projectMarkerPicker.useColor", defaultMessage: "Use {color}" },
                  { color: intl.formatMessage(PROJECT_MARKER_COLOR_LABEL_MESSAGES[color]) },
                )}
                aria-pressed={selected}
                onClick={() => selectColor(color)}
                className="flex h-8 cursor-interaction items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-token-border disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  className={cn(
                    "flex items-center justify-center rounded-full",
                    selected && "h-9 w-9 ring-2 ring-token-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "h-5 w-5 rounded-full",
                      PROJECT_MARKER_COLOR_CLASSES[color].swatchClassName,
                    )}
                  />
                </span>
              </button>
            );
          })}
        </div>

        {showDividers ? <div className="mx-3 border-t border-token-border" /> : null}

        {iconGroupLabel != null ? (
          <div className="px-3 pt-2 text-xs font-medium text-token-description-foreground">
            {iconGroupLabel}
          </div>
        ) : null}
        <div
          role="group"
          aria-label={intl.formatMessage({
            id: "workbench.projectMarkerPicker.projectIcon",
            defaultMessage: "Project icon",
          })}
          className={cn(
            "grid grid-cols-[repeat(auto-fit,minmax(36px,1fr))] gap-1 px-3 pb-3",
            iconGroupLabel == null ? "pt-2" : "pt-1",
          )}
        >
          {PROJECT_MARKER_ICONS.map((icon) => {
            const selected = selectedIcon === icon;
            return (
              <button
                key={icon}
                type="button"
                disabled={interactionDisabled}
                aria-label={intl.formatMessage(
                  { id: "workbench.projectMarkerPicker.useIcon", defaultMessage: "Use {icon}" },
                  { icon: intl.formatMessage(PROJECT_MARKER_ICON_LABEL_MESSAGES[icon]) },
                )}
                aria-pressed={selected}
                onClick={() => selectIcon(icon)}
                className={cn(
                  "mx-auto flex h-9 w-9 cursor-interaction items-center justify-center rounded-full hover:bg-token-list-hover-background focus:outline-none focus-visible:ring-2 focus-visible:ring-token-border disabled:cursor-not-allowed disabled:opacity-50",
                  selected && "bg-token-list-hover-background",
                  PROJECT_MARKER_COLOR_CLASSES[appearance.color].textClassName,
                )}
              >
                <span className="icon-md [&>svg]:size-full">
                  {icon === "folder" && fallbackIcon != null ? (
                    fallbackIcon
                  ) : (
                    <ProjectMarkerIconSvg icon={icon} className="size-full" />
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end px-3 py-2.5">
          <NodexButton
            variant="secondary"
            size="sm"
            disabled={interactionDisabled}
            className="h-8 rounded-xl px-3 text-base"
            onClick={() => setOpen(false)}
          >
            <FormattedMessage id="workbench.projectMarkerPicker.done" defaultMessage={"Done"} />
          </NodexButton>
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}
