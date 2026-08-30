import { useEffect, useState } from "react";
import { CoreAuthorityStatusNotice } from "@/components/core-authority-status";
import { NodexToastProvider } from "@/components/ui/toast";
import { WorkbenchShell } from "@/components/workbench/workbench-shell";
import { MermaidDiagramModalController } from "@/components/board/editor/mermaid-code-preview";
import { AppUpdateRestartNotice } from "@/components/workbench/app-update-restart-notice";
import { LocalConversationProvider } from "@/features/local-conversation";
import { HeartbeatAutomationController } from "@/features/local-conversation/heartbeat-automation-controller";
import { DesktopNotificationPermissionBootstrap } from "@/features/local-conversation/desktop-notification-permission-bootstrap";
import { LocalConversationViewStateCleanupController } from "@/features/local-conversation/view/local-conversation-view-state-cleanup-controller";
import { NodexModalHost } from "@/lib/modal-registry";
import type { WindowSessionBootstrap } from "@/lib/types";
import type { CoreAuthorityStatus } from "../shared/core-authority-status";
import { useAppUpdateStatus } from "./app-providers";
import { installAppUpdate } from "./lib/app-update-runtime";

const READY_CORE_AUTHORITY_STATUS = { kind: "ready" } as const;
const CORE_RECOVERY_NOTICE_DELAY_MS = 1_500;

export interface AppProps {
  readonly windowSessionBootstrap: WindowSessionBootstrap;
}

export default function App({ windowSessionBootstrap }: AppProps) {
  const appUpdateStatus = useAppUpdateStatus();
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const [coreAuthorityStatus, setCoreAuthorityStatus] = useState<CoreAuthorityStatus>(
    READY_CORE_AUTHORITY_STATUS,
  );
  const [showRecoveringCoreAuthority, setShowRecoveringCoreAuthority] = useState(false);

  useEffect(() => {
    if (coreAuthorityStatus.kind !== "recovering") {
      setShowRecoveringCoreAuthority(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setShowRecoveringCoreAuthority(true);
    }, CORE_RECOVERY_NOTICE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [coreAuthorityStatus.kind]);

  useEffect(() => {
    let cancelled = false;
    let observedPush = false;
    const unsubscribe = window.api?.onCoreAuthorityStatus?.((status) => {
      if (cancelled) return;
      observedPush = true;
      setCoreAuthorityStatus(status);
    });
    const statusSnapshot = window.api?.getCoreAuthorityStatus?.();
    if (statusSnapshot) {
      void statusSnapshot
        .then((status) => {
          if (cancelled || observedPush) return;
          setCoreAuthorityStatus(status);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const retryCoreAuthority = (): void => {
    void window.api?.retryCoreAuthority?.().catch(() => undefined);
  };

  const relaunchForCoreAuthority = (): void => {
    void window.api?.relaunchForCoreAuthority?.().catch(() => undefined);
  };

  return (
    <NodexToastProvider>
      <LocalConversationProvider>
        <DesktopNotificationPermissionBootstrap />
        <LocalConversationViewStateCleanupController />
        <HeartbeatAutomationController />
        <WorkbenchShell windowSessionBootstrap={windowSessionBootstrap} />
        <CoreAuthorityStatusNotice
          status={
            coreAuthorityStatus.kind === "recovering" && !showRecoveringCoreAuthority
              ? READY_CORE_AUTHORITY_STATUS
              : coreAuthorityStatus
          }
          onRetry={retryCoreAuthority}
          onRelaunch={relaunchForCoreAuthority}
        />
        {appUpdateStatus?.status === "downloaded" &&
        dismissedUpdateVersion !== appUpdateStatus.availableVersion ? (
          <div className="pointer-events-none fixed inset-x-3 bottom-14 z-[61] flex justify-center">
            <div className="pointer-events-auto">
              <AppUpdateRestartNotice
                status={appUpdateStatus}
                onDismiss={() => {
                  setDismissedUpdateVersion(appUpdateStatus.availableVersion);
                }}
                onRestart={() => {
                  void installAppUpdate();
                }}
              />
            </div>
          </div>
        ) : null}
        <MermaidDiagramModalController />
        <NodexModalHost />
      </LocalConversationProvider>
    </NodexToastProvider>
  );
}
