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

export type SpaceAvailability = "ready" | "reconnecting" | "unavailable" | "access-revoked";

export interface SpaceConnectionSummary {
  readonly spaceId: SpaceId;
  readonly kind: "personal" | "team";
  readonly name: string;
  readonly memberId: string | null;
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

export interface SpaceConnectionIpcApi {
  "spaces:list": { args: []; result: readonly SpaceConnectionSummary[] };
  "spaces:context": { args: []; result: SpaceConnectionSummary };
  "spaces:join": { args: [input: JoinSpaceInput]; result: SpaceConnectionSummary };
  "spaces:leave": { args: [spaceId: SpaceId]; result: void };
  "spaces:switch": { args: [spaceId: SpaceId]; result: string };
  "spaces:open-link": { args: [url: string]; result: boolean };
}
