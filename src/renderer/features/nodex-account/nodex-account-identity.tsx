import { useState } from "react";
import { NODEX_ACCOUNT_ERROR_COPY } from "../../../shared/nodex-account-copy";
import type { NodexAccountIdentity } from "../../../shared/nodex-account";
import { NodexLogoMarkIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import type { useNodexAccount } from "./use-nodex-account";

type NodexAccountState = ReturnType<typeof useNodexAccount>;

export interface NodexAccountIdentityView {
  readonly label: string;
  readonly detail: string | null;
  readonly initials: string;
  readonly imageUrl: string | null;
  readonly hue: number;
}

export interface NodexAccountNotice {
  readonly message: string;
  readonly tone: "error" | "warning";
}

const TRANSPORT_NOTICE: NodexAccountNotice = {
  message: "Could not complete the request. Try again.",
  tone: "error",
};

function secureImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function initialsOf(source: string): string {
  const words = source.split(/[ ._-]+/u).filter(Boolean);
  const first = Array.from(words[0] ?? "")[0] ?? "";
  const last = words.length > 1 ? (Array.from(words.at(-1) ?? "")[0] ?? "") : "";
  return `${first}${last}`.toLocaleUpperCase();
}

function hueOf(seed: string): number {
  let hue = 0;
  for (const char of seed) hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hue;
}

/** Null without a remembered identity, so no state claims an account it cannot name. */
export function resolveNodexAccountIdentity(
  account: NodexAccountIdentity | null,
): NodexAccountIdentityView | null {
  if (!account) return null;
  const name = account.name?.trim() || null;
  const email = account.email?.trim() || null;
  return {
    label: name ?? email ?? "Nodex Account",
    detail: name && email && name !== email ? email : null,
    initials: initialsOf(name ?? email?.split("@")[0] ?? ""),
    imageUrl: secureImageUrl(account.imageUrl),
    hue: hueOf(`${account.issuer}#${account.subject}`),
  };
}

/** One presentation of account status shared by the rail menu and the Account page. */
export function resolveNodexAccountView(account: NodexAccountState) {
  const snapshot = account.snapshot;
  const configured = snapshot?.configured === true;
  const status = configured ? snapshot.status : null;
  const signedIn = status === "signed-in";
  const reauthentication = status === "reauthentication-required";
  const offline =
    signedIn && snapshot?.connection === "unavailable" && snapshot.error === "network";
  const failure = account.failure;
  const suppressed =
    account.failed ||
    (failure === "not-configured" && !configured) ||
    (failure === "invalid-grant" && reauthentication) ||
    (failure === "network" && offline);
  const notice: NodexAccountNotice | null =
    !failure || suppressed
      ? null
      : failure === "transport"
        ? TRANSPORT_NOTICE
        : NODEX_ACCOUNT_ERROR_COPY[failure];
  return {
    configured,
    status,
    signedIn,
    signingIn: status === "signing-in",
    signedOut: status === "signed-out",
    reauthentication,
    offline,
    memoryOnly: signedIn && snapshot?.persistence === "memory",
    identity:
      signedIn || reauthentication ? resolveNodexAccountIdentity(snapshot?.account ?? null) : null,
    notice,
  };
}

export type NodexAccountView = ReturnType<typeof resolveNodexAccountView>;

export type NodexAccountAvatarSize = "sm" | "md" | "lg";

const AVATAR_SIZE: Record<NodexAccountAvatarSize, string> = {
  sm: "size-4.5 text-[10px]",
  md: "size-6 text-[12px]",
  lg: "size-10 text-base",
};

const BRAND_SIZE: Record<NodexAccountAvatarSize, string> = {
  sm: "size-4",
  md: "size-5",
  lg: "size-9",
};

export function NodexAccountAvatar({
  identity,
  size = "md",
  className,
}: {
  identity: NodexAccountIdentityView | null;
  size?: NodexAccountAvatarSize;
  className?: string;
}) {
  const [brokenImage, setBrokenImage] = useState<string | null>(null);
  const box = cn(
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium leading-none",
    AVATAR_SIZE[size],
    className,
  );
  const image = identity?.imageUrl && identity.imageUrl !== brokenImage ? identity.imageUrl : null;
  if (image) {
    return (
      <span aria-hidden="true" className={cn(box, "bg-token-foreground/8")}>
        <img
          src={image}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full rounded-full object-cover"
          onError={() => setBrokenImage(image)}
        />
      </span>
    );
  }
  const initials = !identity
    ? ""
    : size === "sm"
      ? (Array.from(identity.initials)[0] ?? "")
      : identity.initials;
  if (!identity || !initials) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 select-none items-center justify-center",
          AVATAR_SIZE[size],
          className,
        )}
      >
        <NodexLogoMarkIcon monochrome className={cn("shrink-0", BRAND_SIZE[size])} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(box, "text-white")}
      style={{ backgroundColor: `oklch(0.56 0.11 ${identity.hue})` }}
    >
      {initials}
    </span>
  );
}
