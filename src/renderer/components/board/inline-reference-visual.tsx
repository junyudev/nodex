import type {
  ComponentPropsWithRef,
  ComponentPropsWithoutRef,
  CSSProperties,
  ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export const INLINE_REFERENCE_UNDERLINE_STYLE = {
  textDecorationColor: "color-mix(in srgb, currentColor 25%, transparent)",
  textDecorationThickness: "0.05em",
  textUnderlineOffset: "10%",
} satisfies CSSProperties;

export const INLINE_REFERENCE_CLASS_NAME = [
  "relative isolate z-0 inline-flex max-w-full items-baseline gap-[0.3em] overflow-visible whitespace-nowrap rounded-[2px] align-baseline font-medium text-inherit select-none",
  "border-0 bg-transparent p-0",
  "before:pointer-events-none before:absolute before:-inset-x-[0.15em] before:-inset-y-[0.1em] before:-z-10 before:rounded-[3px] before:bg-token-foreground/5 before:opacity-0 before:content-[''] hover:before:opacity-100 focus-visible:before:opacity-100 data-[inline-reference-selected=true]:before:opacity-100 data-[mention-token-selected=true]:before:opacity-100",
  "focus-visible:outline-none",
].join(" ");

interface InlineReferenceVisualBaseProps {
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly iconClassName?: string;
  readonly labelClassName?: string;
  readonly trailingClassName?: string;
}

type InlineReferenceVisualSpanProps = InlineReferenceVisualBaseProps &
  Omit<ComponentPropsWithoutRef<"span">, "children"> & { readonly as?: "span" };

type InlineReferenceVisualButtonProps = InlineReferenceVisualBaseProps &
  Omit<ComponentPropsWithoutRef<"button">, "children"> & { readonly as: "button" };

type InlineReferenceVisualAnchorProps = InlineReferenceVisualBaseProps &
  Omit<ComponentPropsWithRef<"a">, "children"> & { readonly as: "a" };

export type InlineReferenceVisualProps =
  | InlineReferenceVisualSpanProps
  | InlineReferenceVisualButtonProps
  | InlineReferenceVisualAnchorProps;

function InlineReferenceVisualChildren({
  label,
  icon,
  trailing,
  iconClassName,
  labelClassName,
  trailingClassName,
}: InlineReferenceVisualBaseProps) {
  return (
    <>
      {icon ? (
        <span
          className={cn(
            "relative top-[0.14em] inline-flex size-[1em] shrink-0 text-token-description-foreground",
            iconClassName,
          )}
        >
          {icon}
        </span>
      ) : null}
      <span
        className={cn("truncate leading-[inherit] underline", labelClassName)}
        style={INLINE_REFERENCE_UNDERLINE_STYLE}
        data-inline-reference-label="true"
      >
        {label}
      </span>
      {trailing ? (
        <span
          className={cn(
            "relative top-[0.12em] inline-flex size-[0.85em] shrink-0 text-token-description-foreground",
            trailingClassName,
          )}
        >
          {trailing}
        </span>
      ) : null}
    </>
  );
}

export function InlineReferenceVisual(props: InlineReferenceVisualProps) {
  if (props.as === "button") {
    const {
      as: _element,
      label,
      icon,
      trailing,
      iconClassName,
      labelClassName,
      trailingClassName,
      className,
      ...buttonProps
    } = props;
    return (
      <button
        className={cn(INLINE_REFERENCE_CLASS_NAME, className)}
        {...buttonProps}
        data-inline-reference-chip="true"
      >
        <InlineReferenceVisualChildren
          label={label}
          icon={icon}
          trailing={trailing}
          iconClassName={iconClassName}
          labelClassName={labelClassName}
          trailingClassName={trailingClassName}
        />
      </button>
    );
  }

  if (props.as === "a") {
    const {
      as: _element,
      label,
      icon,
      trailing,
      iconClassName,
      labelClassName,
      trailingClassName,
      className,
      ...anchorProps
    } = props;
    return (
      <a
        className={cn(INLINE_REFERENCE_CLASS_NAME, className)}
        {...anchorProps}
        data-inline-reference-chip="true"
      >
        <InlineReferenceVisualChildren
          label={label}
          icon={icon}
          trailing={trailing}
          iconClassName={iconClassName}
          labelClassName={labelClassName}
          trailingClassName={trailingClassName}
        />
      </a>
    );
  }

  const {
    as: _element,
    label,
    icon,
    trailing,
    iconClassName,
    labelClassName,
    trailingClassName,
    className,
    ...spanProps
  } = props;
  return (
    <span
      className={cn(INLINE_REFERENCE_CLASS_NAME, className)}
      {...spanProps}
      data-inline-reference-chip="true"
    >
      <InlineReferenceVisualChildren
        label={label}
        icon={icon}
        trailing={trailing}
        iconClassName={iconClassName}
        labelClassName={labelClassName}
        trailingClassName={trailingClassName}
      />
    </span>
  );
}
