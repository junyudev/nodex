import { z } from "zod";

/** A Core-authored Library identity. URLs and process generations never identify a Space. */
export type SpaceId = string;

/** Host-authored display metadata, independently of an endpoint or credential. */
export const SpaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((name) => Array.from(name).length <= 256 && !/\p{Cc}/u.test(name), {
    message: "A Space name needs 1 to 256 characters without control characters",
  });

/** Why Core would refuse this as a Member's name, or null when it accepts it. "You" is only ever
 * how Nodex shows a reader their own Member, so no stored name may claim it. */
export function memberNameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return "Enter your name";
  if (Array.from(name).length > 256) return "Use at most 256 characters";
  if (/\p{Cc}/u.test(name)) return "A name cannot contain control characters";
  if (name.toLowerCase() === "you")
    return "Choose a name others will recognize; Nodex shows each person their own actions as You";
  return null;
}

const MemberNameSchema = z
  .string()
  .trim()
  .superRefine((name, context) => {
    const problem = memberNameProblem(name);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

export type SpaceAvailability = "ready" | "reconnecting" | "unavailable" | "access-revoked";

export interface SpaceConnectionSummary {
  readonly spaceId: SpaceId;
  readonly kind: "personal" | "team";
  readonly name: string;
  readonly memberId: string | null;
  /** This computer's Device in a team Space; the personal Space is reached locally. */
  readonly deviceId: string | null;
  readonly availability: SpaceAvailability;
}

export const JoinSpaceInputSchema = z
  .object({
    inviteUrl: z.string().trim().min(1),
    fingerprint: z
      .string()
      .trim()
      .regex(/^[a-f\d]{64}$/iu),
    code: z.string().trim().min(1).max(512),
    displayName: MemberNameSchema,
    deviceLabel: z.string().trim().min(1).max(200),
  })
  .strict();

export type JoinSpaceInput = z.infer<typeof JoinSpaceInputSchema>;

/** Every content IPC request binds its arguments to one immutable Space coordinate. */
export interface SpaceRequest<Args extends readonly unknown[]> {
  readonly spaceId: SpaceId;
  readonly args: Args;
}

export const SpaceRequestSchema = z
  .object({
    spaceId: z.string().min(1).max(512),
    args: z.array(z.unknown()),
  })
  .strict();

export function parseSpaceInvite(invite: string): { url: string; fingerprint: string } {
  const url = new URL(invite);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Enter the HTTPS invite URL from the Space Owner");
  }
  const fingerprint =
    url.searchParams.get("fingerprint") ??
    new URLSearchParams(url.hash.slice(1)).get("fingerprint") ??
    "";
  url.search = "";
  url.hash = "";
  if (url.pathname !== "/") throw new Error("A Space invite must name an HTTPS origin");
  return { url: url.origin, fingerprint };
}

export const spaceAvailabilityLabel = (availability: SpaceAvailability): string => {
  if (availability === "ready") return "Connected";
  if (availability === "reconnecting") return "Reconnecting…";
  if (availability === "access-revoked") return "Access revoked";
  return "Unavailable";
};

export const REMOTE_AGENT_REASON = "Agents for this Space run on its host";
export const REMOTE_FILESYSTEM_REASON = "This feature needs a filesystem on the Space host";
export const HOSTED_CHAT_ACTION_REASON = "Not available for chats on this Space's host";
/** Why another Member's work in a shared chat cannot be stopped from here; Core refuses alike. */
export const CHAT_STOP_RESERVED_REASON =
  "Only the person who started this, or a Space Owner, can stop it.";

export interface SpaceConnectionIpcApi {
  "spaces:list": { args: []; result: readonly SpaceConnectionSummary[] };
  "spaces:context": { args: []; result: SpaceConnectionSummary };
  "spaces:join": { args: [input: JoinSpaceInput]; result: SpaceConnectionSummary };
  "spaces:leave": { args: [spaceId: SpaceId]; result: void };
  "spaces:switch": { args: [spaceId: SpaceId]; result: string };
  "spaces:open-link": { args: [url: string]; result: boolean };
}
