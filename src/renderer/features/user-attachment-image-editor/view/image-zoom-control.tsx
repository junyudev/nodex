import { useIntl } from "@/lib/i18n";
import { CheckmarkIcon, CompactChevronDownIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";

const IMAGE_ZOOM_OPTIONS = [25, 50, 100, 150, 200] as const;

export interface ImageZoomControlProps {
  fitSelected: boolean;
  showFitOption?: boolean;
  zoomPercent: number;
  onZoomPercentChange: (zoomPercent: number) => void;
  onZoomToFit: () => void;
}

export function ImageZoomControl({
  fitSelected,
  showFitOption = true,
  zoomPercent,
  onZoomPercentChange,
  onZoomToFit,
}: ImageZoomControlProps) {
  const intl = useIntl();
  return (
    <NodexDropdownMenu
      align="end"
      sideOffset={4}
      contentClassName="!w-[136px] !min-w-[136px] !rounded-[10px] !p-[6px]"
      triggerButton={
        <NodexButton
          variant="ghost"
          size="xs"
          aria-label={intl.formatMessage(
            { id: "imageEditor.imageZoomControl.zoom", defaultMessage: "Zoom, {zoom}" },
            { zoom: intl.formatNumber(zoomPercent / 100, { style: "percent" }) },
          )}
          className="!h-7 !w-fit !max-w-fit flex-none shrink-0 !gap-0.5 rounded-lg !px-2 !text-sm !leading-5 text-token-text-secondary"
        >
          <span className="text-start leading-5 tabular-nums">{zoomPercent}%</span>
          <CompactChevronDownIcon
            aria-hidden="true"
            className="icon-2xs text-token-button-tertiary-foreground opacity-50"
          />
        </NodexButton>
      }
    >
      {IMAGE_ZOOM_OPTIONS.map((option) => (
        <NodexDropdownItem
          key={option}
          className="!rounded-[6px] !py-[5px] !ps-2 !pe-[5px] text-token-text-primary"
          rightSlot={
            <CheckmarkIcon
              aria-hidden="true"
              className={cn(
                "icon-sm",
                !fitSelected && option === zoomPercent ? undefined : "invisible",
              )}
            />
          }
          onSelect={() => onZoomPercentChange(option)}
        >
          <span className="tabular-nums">{option}%</span>
        </NodexDropdownItem>
      ))}
      {showFitOption ? (
        <>
          <NodexDropdownSeparator className="py-0" />
          <NodexDropdownItem
            className="!rounded-[6px] !py-[5px] !ps-2 !pe-[5px] text-token-text-primary"
            rightSlot={
              <CheckmarkIcon
                aria-hidden="true"
                className={cn("icon-sm", fitSelected ? undefined : "invisible")}
              />
            }
            onSelect={onZoomToFit}
          >
            {intl.formatMessage({
              id: "imageEditor.imageZoomControl.fit",
              defaultMessage: "Zoom to fit",
            })}
          </NodexDropdownItem>
        </>
      ) : null}
    </NodexDropdownMenu>
  );
}
