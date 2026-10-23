import type { ReactNode, SVGProps } from "react";

type AccountIconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function AccountIcon({
  children,
  className,
  ...props
}: AccountIconProps & { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      className={className ?? "icon-base shrink-0"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.33}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SignInIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <path d="M11.5 3.5h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3" />
      <path d="M8 6.5 11.5 10 8 13.5" />
      <path d="M11.5 10h-8" />
    </AccountIcon>
  );
}

export function SignOutIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <path d="M8.5 16.5h-3a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3" />
      <path d="M12.5 6.5 16 10l-3.5 3.5" />
      <path d="M16 10H8" />
    </AccountIcon>
  );
}
