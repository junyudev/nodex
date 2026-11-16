import { FormattedMessage, useIntl } from "@/lib/i18n";
import type { components } from "@nodex/core-protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NodexSettingsAddRow,
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { readableIpcError } from "@/lib/ipc-error-message";
import { useLocalMember, useMembers } from "@/lib/members-runtime";
import { spaceQueryKey } from "@/lib/renderer-space";
import * as admin from "@/lib/space-administration";
import {
  memberNameProblem,
  spaceAvailabilityMessage,
  type SpaceConnectionSummary,
} from "../../../shared/space-connection";
import { useOpenJoinSpace } from "./join-space-dialog";
import { SpaceAvatar } from "./space-avatar";
import { DeviceLinkCode } from "./device-link-code";
import {
  activeDevices,
  describeDevice,
  describeExpiry,
  joinLinkFor,
  peopleInOrder,
  roleLabel,
  routeHosts,
} from "./space-administration-presentation";
import { currentSpace, leaveSpace, switchSpace, useSpaceConnections } from "./spaces-runtime";

type Member = components["schemas"]["Member"];

const keys = {
  devices: () => spaceQueryKey(["space-admin", "devices"]),
  remoteAccess: () => spaceQueryKey(["space-admin", "remote-access"]),
};

const failed = (title: string) => (cause: unknown) =>
  toast.danger(title, { description: readableIpcError(cause) });

const nowSeconds = () => Math.floor(Date.now() / 1000);

const MOBILE_DOWNLOAD_URL = "https://nodex.jyu.app/download/#mobile";

/** For someone who hasn't installed the app yet, wherever linking first asks them to use it. */
function GetTheAppLink() {
  return (
    <a
      href={MOBILE_DOWNLOAD_URL}
      target="_blank"
      rel="noreferrer"
      className="text-token-text-link-foreground hover:underline"
    >
      <FormattedMessage id="spaces.spacesSettingsPage.getTheApp" defaultMessage="Get the app." />
    </a>
  );
}

/** A clock for countdowns and "seen" times that only ticks while something needs it. */
function useNowSeconds(intervalMs: number): number {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const intl = useIntl();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-token-text-secondary">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-md bg-token-foreground/5 px-2 py-1 text-xs">
        {value}
      </code>
      <NodexButton
        size="xs"
        variant="ghost"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() =>
            toast.success(
              intl.formatMessage(
                {
                  id: "spaces.spacesSettingsPage.valueCopied",
                  defaultMessage: "{value1} copied",
                },
                { value1: label },
              ),
            ),
          )
        }
      >
        <FormattedMessage id="spaces.spacesSettingsPage.copy" defaultMessage="Copy" />
      </NodexButton>
    </div>
  );
}

/** A one-time offer: a link that pins this host's certificate and the code that redeems it. */
function OfferPanel({
  intro,
  link,
  code,
  expiresAt,
  phoneUri,
  onDone,
}: {
  intro: ReactNode;
  link: string;
  code: string;
  expiresAt: number;
  phoneUri?: string;
  onDone: () => void;
}) {
  const intl = useIntl();
  const now = useNowSeconds(1000);
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3">
      {phoneUri ? (
        <div className="flex flex-col items-center gap-2 pb-1">
          <p className="text-sm text-token-text-secondary">
            <FormattedMessage
              id="spaces.spacesSettingsPage.scanWithNodexMobile"
              defaultMessage="Scan with Nodex Mobile."
            />{" "}
            <GetTheAppLink />
          </p>
          <DeviceLinkCode uri={phoneUri} />
          <NodexButton
            size="xs"
            variant="ghost"
            onClick={() =>
              void navigator.clipboard.writeText(phoneUri).then(() =>
                toast.success(
                  intl.formatMessage({
                    id: "spaces.spacesSettingsPage.phoneLinkCopied",
                    defaultMessage: "Phone link copied",
                  }),
                ),
              )
            }
          >
            <FormattedMessage
              id="spaces.spacesSettingsPage.copyPhoneLink"
              defaultMessage="Copy phone link"
            />
          </NodexButton>
        </div>
      ) : null}
      <p className="text-sm text-token-text-secondary">{intro}</p>
      <CopyField
        label={intl.formatMessage({ id: "spaces.spacesSettingsPage.link", defaultMessage: "Link" })}
        value={link}
      />
      <CopyField
        label={intl.formatMessage({
          id: "spaces.spacesSettingsPage.oneTimeCode",
          defaultMessage: "One-time code",
        })}
        value={code}
      />
      <div className="flex items-center justify-between pt-0.5">
        <span className="text-xs text-token-text-secondary tabular-nums">
          {describeExpiry(expiresAt, now, intl)}
        </span>
        <NodexButton size="xs" variant="ghost" onClick={onDone}>
          <FormattedMessage id="spaces.spacesSettingsPage.done" defaultMessage="Done" />
        </NodexButton>
      </div>
    </div>
  );
}

/**
 * Edits one name in its own row: the label becomes the field and the actions Cancel and Save.
 * Core stays the authority; `problem` only explains a name it would refuse before sending it.
 */
function useNameEditor({
  field,
  failure,
  save,
  onSaved,
  problem,
}: {
  field: string;
  failure: string;
  save: (name: string) => Promise<unknown>;
  onSaved: () => void;
  problem?: (name: string) => string | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: () => {
      setDraft(null);
      onSaved();
    },
    onError: failed(failure),
  });
  // An empty draft blocks Save without a message; a refused one says why.
  const reason = draft === null ? null : (problem?.(draft) ?? (draft.trim() ? null : ""));
  const submit = () => {
    if (draft !== null && reason === null) mutation.mutate(draft.trim());
  };
  return {
    reason: reason || null,
    label: (name: ReactNode) =>
      draft === null ? (
        name
      ) : (
        <Input
          aria-label={field}
          aria-invalid={reason ? true : undefined}
          autoFocus
          className="h-8 w-56"
          maxLength={256}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
            if (event.key === "Escape") setDraft(null);
          }}
        />
      ),
    actions: (current: string, rename: { readonly label: string } | null) =>
      draft === null ? (
        rename ? (
          <NodexButton
            size="xs"
            variant="ghost"
            aria-label={rename.label}
            onClick={() => setDraft(current)}
          >
            <FormattedMessage id="spaces.spacesSettingsPage.rename" defaultMessage="Rename" />
          </NodexButton>
        ) : null
      ) : (
        <>
          <NodexButton size="xs" variant="ghost" onClick={() => setDraft(null)}>
            <FormattedMessage id="spaces.spacesSettingsPage.cancel" defaultMessage="Cancel" />
          </NodexButton>
          <NodexButton
            size="xs"
            variant="primary"
            disabled={reason !== null || mutation.isPending}
            onClick={submit}
          >
            <FormattedMessage id="spaces.spacesSettingsPage.save" defaultMessage="Save" />
          </NodexButton>
        </>
      ),
  };
}

function ThisSpace({
  space,
  me,
  remoteAccess,
}: {
  space: SpaceConnectionSummary;
  me: Member | null;
  remoteAccess: ReturnType<typeof useRemoteAccess>;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const owner = me?.role === "owner";
  const name = useNameEditor({
    field: intl.formatMessage({
      id: "spaces.spacesSettingsPage.spaceName",
      defaultMessage: "Space name",
    }),
    failure: intl.formatMessage({
      id: "spaces.spacesSettingsPage.couldNotRenameThisSpace",
      defaultMessage: "Could not rename this Space",
    }),
    save: (name) => admin.rename({ name }),
    onSaved: () =>
      void queryClient.invalidateQueries({ queryKey: ["desktop", "space-connections"] }),
  });
  const access = remoteAccess.query.data;
  const listener = access?.listener ?? null;
  const hosts = listener ? routeHosts(listener.routes) : [];
  const accessDescription = () => {
    if (remoteAccess.query.isError)
      return intl.formatMessage({
        id: "spaces.spacesSettingsPage.remoteAccessIsUnavailable",
        defaultMessage: "Remote access is unavailable.",
      });
    if (access?.routesChanged)
      return intl.formatMessage({
        id: "spaces.spacesSettingsPage.thisComputerSAddressChanged",
        defaultMessage: "This computer’s address changed. Link your devices again.",
      });
    if (listener && hosts.length)
      return intl.formatMessage(
        {
          id: "spaces.spacesSettingsPage.yourLinkedDevicesReachThis",
          defaultMessage: "Your linked devices reach this Space at {value1}.",
        },
        { value1: hosts.join(", ") },
      );
    if (listener)
      return intl.formatMessage({
        id: "spaces.spacesSettingsPage.onButThisComputerIsn",
        defaultMessage: "On, but this computer isn't on a network another device can reach.",
      });
    if (access?.intent?.enabled)
      return intl.formatMessage({
        id: "spaces.spacesSettingsPage.remoteAccessIsOnBut",
        defaultMessage: "Remote access is on, but the listener is unavailable.",
      });
    return intl.formatMessage({
      id: "spaces.spacesSettingsPage.letYourPhoneAndOther",
      defaultMessage:
        "Let your phone and other computers reach this Space over your network or tailnet. Nodex stays open to serve them.",
    });
  };
  return (
    <NodexSettingsSection>
      <NodexSettingsRow
        label={
          <span className="flex items-center gap-2.5">
            <SpaceAvatar space={space} size="page" />
            {name.label(<span className="truncate">{space.name}</span>)}
          </span>
        }
        description={
          space.kind === "personal"
            ? intl.formatMessage({
                id: "spaces.spacesSettingsPage.yourPersonalSpace",
                defaultMessage: "Your personal Space",
              })
            : me
              ? intl.formatMessage(
                  {
                    id: "spaces.spacesSettingsPage.yourTeamRole",
                    defaultMessage: "Team Space · You are {role}",
                  },
                  { role: roleLabel(me.role, intl).toLocaleLowerCase(intl.locale) },
                )
              : intl.formatMessage({
                  id: "spaces.spacesSettingsPage.teamSpace",
                  defaultMessage: "Team Space",
                })
        }
      >
        {name.actions(
          space.name,
          owner
            ? {
                label: intl.formatMessage({
                  id: "spaces.spacesSettingsPage.renameThisSpace",
                  defaultMessage: "Rename this Space",
                }),
              }
            : null,
        )}
      </NodexSettingsRow>
      {space.kind === "personal" && owner ? (
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "spaces.spacesSettingsPage.remoteAccess",
            defaultMessage: "Remote access",
          })}
          description={accessDescription()}
        >
          <NodexSwitch
            ariaLabel={intl.formatMessage({
              id: "spaces.spacesSettingsPage.remoteAccess",
              defaultMessage: "Remote access",
            })}
            checked={remoteAccess.query.data?.intent?.enabled ?? false}
            disabled={
              remoteAccess.query.isPending ||
              remoteAccess.query.isError ||
              remoteAccess.toggle.isPending
            }
            onCheckedChange={(on) => remoteAccess.toggle.mutate(on)}
          />
        </NodexSettingsRow>
      ) : null}
    </NodexSettingsSection>
  );
}

function useRemoteAccess(enabled: boolean) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: keys.remoteAccess(),
    queryFn: admin.remoteAccess,
    enabled,
  });
  const toggle = useMutation({
    mutationFn: async (on: boolean) =>
      on
        ? admin.remoteAccessOn({ address: query.data?.intent?.address ?? "0.0.0.0:0" })
        : admin.remoteAccessOff(),
    onSuccess: (state) => queryClient.setQueryData(keys.remoteAccess(), state),
    onError: failed(
      intl.formatMessage({
        id: "spaces.spacesSettingsPage.couldNotChangeRemoteAccess",
        defaultMessage: "Could not change remote access",
      }),
    ),
  });
  return { query, toggle };
}

function Devices({
  me,
  members,
  canLink,
  thisDeviceId,
}: {
  me: Member | null;
  members: readonly Member[];
  canLink: boolean;
  thisDeviceId: string | null;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const now = useNowSeconds(30_000);
  const devices = useQuery({ queryKey: keys.devices(), queryFn: admin.devices });
  const [offer, setOffer] = useState<components["schemas"]["DeviceLinkOffer"] | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.devices() });
  const link = useMutation({
    mutationFn: admin.linkDevice,
    onSuccess: setOffer,
    onError: failed(
      intl.formatMessage({
        id: "spaces.spacesSettingsPage.couldNotLinkADevice",
        defaultMessage: "Could not link a device",
      }),
    ),
  });
  const revoke = useMutation({
    mutationFn: (deviceId: string) => admin.revokeDevice({ device_id: deviceId }),
    onSuccess: refresh,
    onError: failed(
      intl.formatMessage({
        id: "spaces.spacesSettingsPage.couldNotRevokeThisDevice",
        defaultMessage: "Could not revoke this device",
      }),
    ),
  });
  const nameOf = (memberId: string) =>
    memberId === me?.id
      ? null
      : (members.find((member) => member.id === memberId)?.display_name ?? "Someone");
  const listed = activeDevices(devices.data ?? [], me?.id ?? null);
  const route = offer?.routes[0];
  return (
    <NodexSettingsSection
      title={intl.formatMessage({
        id: "spaces.spacesSettingsPage.devices",
        defaultMessage: "Devices",
      })}
    >
      {listed.map((device) => (
        <NodexSettingsRow
          key={device.id}
          label={device.label}
          description={describeDevice(
            device,
            nameOf(device.member_id),
            device.id === thisDeviceId,
            now,
            intl,
          )}
        >
          {/* This computer leaves a Space from Your Spaces, not by revoking itself. */}
          {device.id === thisDeviceId ? null : (
            <NodexButton
              size="xs"
              variant="ghost"
              aria-label={intl.formatMessage(
                { id: "spaces.spacesSettingsPage.revokeValue", defaultMessage: "Revoke {value1}" },
                { value1: device.label },
              )}
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(device.id)}
            >
              <FormattedMessage id="spaces.spacesSettingsPage.revoke" defaultMessage="Revoke" />
            </NodexButton>
          )}
        </NodexSettingsRow>
      ))}
      {listed.length === 0 && devices.isSuccess && !offer ? (
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "spaces.spacesSettingsPage.noLinkedDevices",
            defaultMessage: "No linked devices",
          })}
          description={
            <>
              <FormattedMessage
                id="spaces.spacesSettingsPage.phonesAndOtherComputersYou"
                defaultMessage="Phones and other computers you link appear here."
              />{" "}
              <GetTheAppLink />
            </>
          }
        >
          {null}
        </NodexSettingsRow>
      ) : null}
      {offer && route ? (
        <OfferPanel
          intro="On your other computer, choose Join a Space and enter this link and code."
          phoneUri={admin.deviceLinkUri(offer)}
          link={joinLinkFor(route, offer.fingerprint)}
          code={offer.code}
          expiresAt={offer.expires_at}
          onDone={() => {
            setOffer(null);
            refresh();
          }}
        />
      ) : offer ? (
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "spaces.spacesSettingsPage.noReachableAddress",
            defaultMessage: "No reachable address",
          })}
          description={intl.formatMessage({
            id: "spaces.spacesSettingsPage.connectThisComputerToWi",
            defaultMessage: "Connect this computer to Wi-Fi or a tailnet, then link again.",
          })}
        >
          <NodexButton size="xs" variant="ghost" onClick={() => setOffer(null)}>
            <FormattedMessage id="spaces.spacesSettingsPage.done" defaultMessage="Done" />
          </NodexButton>
        </NodexSettingsRow>
      ) : (
        <NodexSettingsAddRow
          label={
            canLink
              ? intl.formatMessage({
                  id: "spaces.spacesSettingsPage.linkADevice",
                  defaultMessage: "Link a device",
                })
              : intl.formatMessage({
                  id: "spaces.spacesSettingsPage.linkADeviceTurnOn",
                  defaultMessage: "Link a device · turn on Remote access first",
                })
          }
          disabled={!canLink || link.isPending}
          onClick={() => link.mutate()}
        />
      )}
    </NodexSettingsSection>
  );
}

function People({ me, members }: { me: Member | null; members: readonly Member[] }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const owner = me?.role === "owner";
  const [invitation, setInvitation] = useState<components["schemas"]["InviteResponse"] | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => admin.invite({ role: "member", member_id: null }),
    onSuccess: setInvitation,
    onError: failed(
      intl.formatMessage({
        id: "spaces.spacesSettingsPage.couldNotCreateAnInvitation",
        defaultMessage: "Could not create an invitation",
      }),
    ),
  });
  // Someone who joins or leaves changes both who is here and which devices reach the Space.
  const refreshPeople = () => {
    void queryClient.invalidateQueries({ queryKey: spaceQueryKey(["library", "members"]) });
    void queryClient.invalidateQueries({ queryKey: keys.devices() });
  };
  const remove = useMutation({
    mutationFn: (memberId: string) => admin.removeMember({ member_id: memberId }),
    onSuccess: () => {
      setRemoving(null);
      refreshPeople();
    },
    onError: failed(
      intl.formatMessage({
        id: "spaces.spacesSettingsPage.couldNotRemoveThisPerson",
        defaultMessage: "Could not remove this person",
      }),
    ),
  });
  // Everyone else sees this name on what you do here; "You" is only how you see yourself.
  const myName = useNameEditor({
    field: intl.formatMessage({
      id: "spaces.spacesSettingsPage.yourName",
      defaultMessage: "Your name",
    }),
    failure: intl.formatMessage({
      id: "spaces.spacesSettingsPage.couldNotChangeYourName",
      defaultMessage: "Could not change your name",
    }),
    save: (name) => admin.renameMember({ name }),
    onSaved: () => {
      void queryClient.invalidateQueries({ queryKey: spaceQueryKey(["library", "members"]) });
      void queryClient.invalidateQueries({ queryKey: spaceQueryKey(["library", "localMember"]) });
    },
    problem: memberNameProblem,
  });
  return (
    <NodexSettingsSection
      title={intl.formatMessage({
        id: "spaces.spacesSettingsPage.people",
        defaultMessage: "People",
      })}
    >
      {peopleInOrder(members, me?.id ?? null).map((member) => (
        <NodexSettingsRow
          key={member.id}
          label={member.id === me?.id ? myName.label(member.display_name) : member.display_name}
          description={
            member.id !== me?.id ? (
              roleLabel(member.role, intl)
            ) : myName.reason ? (
              <span role="alert" className="text-danger">
                {myName.reason}
              </span>
            ) : (
              intl.formatMessage(
                { id: "spaces.spacesSettingsPage.valueYou", defaultMessage: "{value1} · You" },
                { value1: roleLabel(member.role, intl) },
              )
            )
          }
        >
          {member.id === me?.id
            ? myName.actions(member.display_name, {
                label: intl.formatMessage({
                  id: "spaces.spacesSettingsPage.changeYourName",
                  defaultMessage: "Change your name",
                }),
              })
            : null}
          {owner && member.id !== me?.id ? (
            removing === member.id ? (
              <>
                <NodexButton size="xs" variant="ghost" onClick={() => setRemoving(null)}>
                  <FormattedMessage id="spaces.spacesSettingsPage.keep" defaultMessage="Keep" />
                </NodexButton>
                <NodexButton
                  size="xs"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(member.id)}
                >
                  <FormattedMessage id="spaces.spacesSettingsPage.remove" defaultMessage="Remove" />{" "}
                  {member.display_name}
                </NodexButton>
              </>
            ) : (
              <NodexButton
                size="xs"
                variant="ghost"
                aria-label={intl.formatMessage(
                  {
                    id: "spaces.spacesSettingsPage.removeValueFromThisSpace",
                    defaultMessage: "Remove {value1} from this Space",
                  },
                  { value1: member.display_name },
                )}
                onClick={() => setRemoving(member.id)}
              >
                <FormattedMessage id="spaces.spacesSettingsPage.remove" defaultMessage="Remove" />
              </NodexButton>
            )
          ) : null}
        </NodexSettingsRow>
      ))}
      {owner ? (
        invitation ? (
          <OfferPanel
            intro="Send both to the person you're inviting. In Nodex, they choose Join a Space."
            link={joinLinkFor(invitation.url, invitation.fingerprint)}
            code={invitation.code}
            expiresAt={invitation.expires_at}
            onDone={() => {
              setInvitation(null);
              refreshPeople();
            }}
          />
        ) : (
          <NodexSettingsAddRow
            label={intl.formatMessage({
              id: "spaces.spacesSettingsPage.inviteSomeone",
              defaultMessage: "Invite someone",
            })}
            disabled={invite.isPending}
            onClick={() => invite.mutate()}
          />
        )
      ) : null}
    </NodexSettingsSection>
  );
}

function AllSpaces() {
  const intl = useIntl();
  const spaces = useSpaceConnections();
  const openJoin = useOpenJoinSpace();
  const bound = currentSpace();
  return (
    <NodexSettingsSection
      title={intl.formatMessage({
        id: "spaces.spacesSettingsPage.yourSpaces",
        defaultMessage: "Your Spaces",
      })}
    >
      {(spaces.data ?? []).map((space) => (
        <NodexSettingsRow
          key={space.spaceId}
          label={
            <span className="flex items-center gap-2">
              <SpaceAvatar space={space} size="menu" />
              <span className="truncate">{space.name}</span>
            </span>
          }
          description={
            space.spaceId === bound.spaceId
              ? intl.formatMessage(
                  {
                    id: "spaces.spacesSettingsPage.valueOpenNow",
                    defaultMessage: "{value1} · Open now",
                  },
                  { value1: intl.formatMessage(spaceAvailabilityMessage(space.availability)) },
                )
              : intl.formatMessage(spaceAvailabilityMessage(space.availability))
          }
        >
          {space.spaceId !== bound.spaceId ? (
            <NodexButton
              size="xs"
              variant="ghost"
              onClick={() =>
                void switchSpace(space.spaceId).catch(
                  failed(
                    intl.formatMessage({
                      id: "spaces.spacesSettingsPage.couldNotSwitch",
                      defaultMessage: "Could not switch",
                    }),
                  ),
                )
              }
            >
              <FormattedMessage id="spaces.spacesSettingsPage.open" defaultMessage="Open" />
            </NodexButton>
          ) : null}
          {space.kind === "team" ? (
            <NodexButton
              size="xs"
              variant="ghost"
              onClick={() => {
                void leaveSpace(space.spaceId)
                  .then(async () => {
                    if (bound.spaceId !== space.spaceId) return;
                    const personal = spaces.data?.find((entry) => entry.kind === "personal");
                    if (personal) await switchSpace(personal.spaceId);
                  })
                  .catch(
                    failed(
                      intl.formatMessage({
                        id: "spaces.spacesSettingsPage.couldNotLeaveThisSpace",
                        defaultMessage: "Could not leave this Space",
                      }),
                    ),
                  );
              }}
            >
              <FormattedMessage id="spaces.spacesSettingsPage.leave" defaultMessage="Leave" />
            </NodexButton>
          ) : null}
        </NodexSettingsRow>
      ))}
      <NodexSettingsAddRow
        label={intl.formatMessage({
          id: "spaces.spacesSettingsPage.joinASpace",
          defaultMessage: "Join a Space",
        })}
        onClick={openJoin}
      />
    </NodexSettingsSection>
  );
}

/**
 * Everything about reaching a Space in one place: the Space open now, the devices that reach it,
 * the people in it, and the other Spaces this computer has joined.
 */
export function SpacesSettingsPage() {
  const intl = useIntl();
  const bound = currentSpace();
  const space =
    useSpaceConnections().data?.find((entry) => entry.spaceId === bound.spaceId) ?? bound;
  const me = useLocalMember().data ?? null;
  const members = useMembers().data ?? [];
  const owner = me?.role === "owner";
  const remoteAccess = useRemoteAccess(space.kind === "personal" && owner);
  const canLink = space.kind === "team" || remoteAccess.query.data?.listener != null;
  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "spaces.spacesSettingsPage.spaces",
        defaultMessage: "Spaces",
      })}
      subtitle={intl.formatMessage({
        id: "spaces.spacesSettingsPage.whoCanReachThisSpace",
        defaultMessage: "Who can reach this Space, and from which devices.",
      })}
    >
      <ThisSpace space={space} me={me} remoteAccess={remoteAccess} />
      <Devices me={me} members={members} canLink={canLink} thisDeviceId={space.deviceId} />
      {space.kind === "team" || (owner && remoteAccess.query.data?.listener) ? (
        <People me={me} members={members} />
      ) : null}
      <AllSpaces />
    </NodexSettingsPageSurface>
  );
}
