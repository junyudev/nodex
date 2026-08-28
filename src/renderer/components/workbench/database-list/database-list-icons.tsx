import type { ComponentProps } from "react";

import { AssigneeIcon, DatabaseLabelIcon, EstimateIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
export { PriorityValueIcon as DatabaseListPriorityIcon } from "@/components/shared/icons/priority-value-icon";

type IconProps = ComponentProps<"svg">;

const iconProps = (className: string | undefined): Pick<IconProps, "className"> => ({
  className: cn("size-4 shrink-0 opacity-100", className),
});

export function DatabaseListDisclosureIcon({
  open,
  className,
  ...props
}: IconProps & { readonly open: boolean }) {
  return (
    <svg
      {...props}
      {...iconProps(className)}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      style={{
        ...props.style,
        transform: open ? "rotate(90deg)" : undefined,
        transition: "transform 120ms cubic-bezier(0.2, 0, 0, 1)",
      }}
    >
      <path d="M7.00194 10.6239C6.66861 10.8183 6.25 10.5779 6.25 10.192V5.80802C6.25 5.42212 6.66861 5.18169 7.00194 5.37613L10.7596 7.56811C11.0904 7.76105 11.0904 8.23895 10.7596 8.43189L7.00194 10.6239Z" />
    </svg>
  );
}

export function DatabaseListPlusIcon({ className, ...props }: IconProps) {
  return (
    <svg
      {...props}
      {...iconProps(className)}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8.75 4C8.75 3.58579 8.41421 3.25 8 3.25C7.58579 3.25 7.25 3.58579 7.25 4V7.25H4C3.58579 7.25 3.25 7.58579 3.25 8C3.25 8.41421 3.58579 8.75 4 8.75H7.25V12C7.25 12.4142 7.58579 12.75 8 12.75C8.41421 12.75 8.75 12.4142 8.75 12V8.75H12C12.4142 8.75 12.75 8.41421 12.75 8C12.75 7.58579 12.4142 7.25 12 7.25H8.75V4Z" />
    </svg>
  );
}

export function DatabaseListEstimateIcon({ className, ...props }: IconProps) {
  return <EstimateIcon {...props} {...iconProps(className)} />;
}

export function DatabaseListProjectIcon({ className, ...props }: IconProps) {
  return (
    <svg
      {...props}
      {...iconProps(className)}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M7.331 1.07a3.2 3.2 0 0 1 1.338 0c.498.106.967.377 1.904.917l1.354.78c.937.541 1.406.812 1.747 1.19.301.334.53.728.669 1.156.157.484.157 1.025.157 2.107v1.56l-.003.718c-.007.63-.036 1.026-.154 1.389l-.057.158a3.2 3.2 0 0 1-.612.998l-.135.138c-.33.312-.792.578-1.612 1.051l-1.354.78-.623.357c-.55.309-.907.481-1.281.56l-.166.032a3.2 3.2 0 0 1-1.006 0l-.166-.031c-.374-.08-.73-.252-1.281-.561l-.623-.356-1.354-.78c-.82-.474-1.281-.74-1.612-1.052l-.135-.138a3.2 3.2 0 0 1-.612-.998l-.057-.158c-.118-.363-.147-.758-.154-1.39L1.5 8.78V7.22c0-.946 0-1.479.105-1.921l.052-.186c.122-.374.312-.723.56-1.028l.11-.128c.255-.284.583-.507 1.126-.83l.62-.36 1.354-.78c.82-.473 1.281-.739 1.718-.869zM3 7.22v1.56c0 1.183.018 1.439.084 1.643l.064.167q.11.246.292.449l.059.06c.151.143.427.318 1.323.835l1.354.78.632.36c.188.104.33.178.442.233V8.482l-4.247-1.93zm5.75 1.262v4.826c.212-.106.533-.282 1.074-.594l1.354-.78.628-.368c.499-.297.646-.407.754-.527l.113-.14q.158-.218.243-.476l.022-.081c.035-.144.051-.351.058-.835L13 8.78V7.22l-.004-.668zM7.82 2.51l-.177.027c-.159.034-.328.106-.835.39l-.632.359-1.354.78c-.896.517-1.172.692-1.323.834l-.059.06q-.046.051-.086.104l4.645 2.112 4.645-2.112-.084-.103c-.109-.12-.255-.23-.754-.528l-.628-.367-1.354-.78c-.897-.517-1.186-.668-1.386-.728l-.08-.021a1.7 1.7 0 0 0-.538-.027"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function DatabaseListLabelIcon({ className, ...props }: IconProps) {
  return <DatabaseLabelIcon {...props} {...iconProps(className)} />;
}

export function DatabaseListAssigneeIcon({ className, ...props }: IconProps) {
  return <AssigneeIcon {...props} {...iconProps(cn("size-[18px]", className))} />;
}
