import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { encode } from "uqr";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { subscribeMobileAccessChanges } from "@/lib/api";
import { readableIpcError } from "@/lib/ipc-error-message";
import {
  beginMobilePairing,
  cancelMobilePairing,
  readMobileAccessStatus,
  revokeMobileDevice,
  setMobileAccessEnabled,
} from "@/lib/mobile-access-runtime";
import { queryKeys } from "@/lib/query-keys";
import type { MobileAccessStatus } from "../../../shared/mobile-access";
import {
  describeDevice,
  formatPairingCountdown,
  routeAddresses,
} from "./mobile-access-presentation";

const MOBILE_DOWNLOAD_URL = "https://nodex.jyu.app/download/#mobile";

/** For someone who hasn't installed the app yet, wherever pairing first asks them to use it. */
function GetTheAppLink() {
  return (
    <a
      href={MOBILE_DOWNLOAD_URL}
      target="_blank"
      rel="noreferrer"
      className="text-token-text-link-foreground hover:underline"
    >
      Get the app.
    </a>
  );
}

/**
 * A change only says to read again, so a pairing secret reaches this window by its own request and
 * never by a broadcast to every window.
 */
function useMobileAccessStatus(open: boolean) {
  const queryClient = useQueryClient();
  const refresh = useEffectEvent(() =>
    queryClient.invalidateQueries({ queryKey: queryKeys.mobileAccess.status() }),
  );
  useEffect(() => subscribeMobileAccessChanges(() => void refresh()), []);
  return useQuery({
    queryKey: queryKeys.mobileAccess.status(),
    queryFn: readMobileAccessStatus,
    enabled: open,
  });
}

/** Modules are drawn as one path, so the code stays crisp at any scale and light to render. */
function PairingCode({ uri }: { readonly uri: string }) {
  // A screen doesn't get scuffed, so the lowest correction level buys a coarser, easier-to-scan code.
  const { data, size } = encode(uri, { ecc: "L", border: 2 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((filled, x) => {
      if (filled) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      aria-label="Pairing code"
      className="size-60 shrink-0 rounded-lg bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

function PairingOffer({
  pairing,
  onCancel,
}: {
  readonly pairing: NonNullable<MobileAccessStatus["pairing"]>;
  readonly onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-5 p-4">
      <PairingCode uri={pairing.uri} />
      <div className="flex min-w-48 flex-1 flex-col gap-2">
        <ol className="flex list-inside list-decimal flex-col gap-1 text-sm">
          <li>
            Open Nodex Mobile on your phone. <GetTheAppLink />
          </li>
          <li>Scan this code.</li>
        </ol>
        <p className="text-sm text-token-text-secondary">
          The phone must be on the same network or tailnet as this computer. The code works once and
          expires in{" "}
          <span className="tabular-nums">{formatPairingCountdown(pairing.expiresAt, now)}</span>.
        </p>
        <div className="flex items-center gap-1.5 pt-1">
          <NodexButton
            size="xs"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard
                .writeText(pairing.uri)
                .then(() => toast.success("Pairing link copied"));
            }}
          >
            Copy link
          </NodexButton>
          <NodexButton size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </NodexButton>
        </div>
      </div>
    </div>
  );
}

const failed = (title: string) => (cause: unknown) => {
  toast.danger(title, { description: readableIpcError(cause) });
};

export function MobileAccessSettingsPage({ open }: { readonly open: boolean }) {
  const queryClient = useQueryClient();
  const statusQuery = useMobileAccessStatus(open);
  const status = statusQuery.data;
  const [now, setNow] = useState(() => Date.now());
  const knownDevices = useRef<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const deviceCount = status?.devices.length ?? null;
  const newest = status?.devices.at(-1)?.name;
  useEffect(() => {
    if (deviceCount === null) return;
    if (knownDevices.current !== null && deviceCount > knownDevices.current && newest) {
      toast.success(`Paired with ${newest}`);
    }
    knownDevices.current = deviceCount;
  }, [deviceCount, newest]);

  const apply = (task: Promise<MobileAccessStatus>, failure: string) => {
    task
      .then((next) => queryClient.setQueryData(queryKeys.mobileAccess.status(), next))
      .catch(failed(failure));
  };

  const addresses = status ? routeAddresses(status.routes) : [];
  const listening = status?.state === "listening";

  return (
    <SettingsPageSurface
      title="Mobile"
      subtitle="Capture to the Inbox and follow your chats from your phone."
    >
      <SectionBlock>
        <SettingRow
          label="Allow phones to connect"
          description={
            status?.state === "failed" && status.failureMessage
              ? status.failureMessage
              : "Only phones you pair can connect, and everything they exchange with Nodex is encrypted end to end. Chats run here, so Nodex stays open."
          }
        >
          <NodexSwitch
            ariaLabel="Allow phones to connect"
            checked={status?.enabled ?? false}
            disabled={!status}
            onCheckedChange={(enabled) =>
              apply(setMobileAccessEnabled(enabled), "Could not change mobile access")
            }
          />
        </SettingRow>
        {listening ? (
          <SettingRow
            label="Reachable at"
            description={
              addresses.length > 0
                ? "A phone connects over any of these."
                : "This computer isn't on a network a phone can reach. Connect to Wi-Fi or a tailnet."
            }
          >
            {addresses.length > 0 ? (
              <span className="text-sm tabular-nums text-token-text-secondary">
                {addresses.join(", ")}
              </span>
            ) : null}
          </SettingRow>
        ) : null}
      </SectionBlock>

      {listening ? (
        <SectionBlock title="Pair a phone">
          {status.pairing ? (
            <PairingOffer
              pairing={status.pairing}
              onCancel={() => apply(cancelMobilePairing(), "Could not cancel pairing")}
            />
          ) : (
            <SettingRow
              label="Show a pairing code"
              description={
                status.failureMessage ?? (
                  <>
                    Scan it with Nodex Mobile to connect that phone to this Profile.{" "}
                    <GetTheAppLink />
                  </>
                )
              }
            >
              <NodexButton
                size="xs"
                variant="primary"
                onClick={() => apply(beginMobilePairing(), "Could not start pairing")}
              >
                Pair a phone
              </NodexButton>
            </SettingRow>
          )}
        </SectionBlock>
      ) : null}

      {status && status.devices.length > 0 ? (
        <SectionBlock title="Paired phones">
          {status.devices.map((device) => (
            <SettingRow
              key={device.id}
              label={device.name}
              description={describeDevice(device, now)}
            >
              <NodexButton
                size="xs"
                variant="ghost"
                onClick={() => apply(revokeMobileDevice(device.id), "Could not remove the phone")}
              >
                Remove
              </NodexButton>
            </SettingRow>
          ))}
        </SectionBlock>
      ) : null}
    </SettingsPageSurface>
  );
}
