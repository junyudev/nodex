import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { cn } from "@/lib/utils";

export const NodexSlider = forwardRef<
  ComponentRef<typeof SliderPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
    /** Styles the pointer surface; its padding insets the thumb's travel. */
    readonly controlClassName?: string;
  }
>(function NodexSlider({ className, controlClassName, orientation = "horizontal", ...props }, ref) {
  return (
    <SliderPrimitive.Root
      ref={ref}
      data-slot="slider"
      orientation={orientation}
      className={cn(
        "relative select-none data-[disabled]:opacity-40",
        orientation === "horizontal" ? "h-5 w-full" : "h-full w-5 flex-col",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Control
        className={cn(
          "flex size-full touch-none items-center select-none",
          orientation === "vertical" && "flex-col",
          controlClassName,
        )}
      >
        {props.children}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
});

export const NodexSliderTrack = forwardRef<
  ComponentRef<typeof SliderPrimitive.Track>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Track>
>(function NodexSliderTrack({ className, ...props }, ref) {
  return (
    <SliderPrimitive.Track
      ref={ref}
      data-slot="slider-track"
      className={cn(
        "relative grow overflow-hidden rounded-full bg-token-foreground/10",
        "data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full",
        "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1",
        className,
      )}
      {...props}
    />
  );
});

export const NodexSliderRange = forwardRef<
  ComponentRef<typeof SliderPrimitive.Indicator>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Indicator>
>(function NodexSliderRange({ className, ...props }, ref) {
  return (
    <SliderPrimitive.Indicator
      ref={ref}
      data-slot="slider-range"
      className={cn(
        "absolute bg-token-foreground/50",
        "data-[orientation=horizontal]:h-full",
        "data-[orientation=vertical]:w-full",
        className,
      )}
      {...props}
    />
  );
});

export const NodexSliderThumb = forwardRef<
  ComponentRef<typeof SliderPrimitive.Thumb>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Thumb>
>(function NodexSliderThumb({ className, ...props }, ref) {
  return (
    <SliderPrimitive.Thumb
      ref={ref}
      data-slot="slider-thumb"
      className={cn(
        "block size-4 shrink-0 cursor-interaction rounded-full border border-token-border bg-token-editor-background shadow-sm outline-hidden",
        "focus-visible:ring-token-focus-border focus-visible:ring-2",
        className,
      )}
      {...props}
    />
  );
});

export { SliderPrimitive };
