import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AppStatusNotice, AppStatusNoticeAction } from "@/components/app-status-notice";
import {
  acknowledgeProductAnalyticsNotice,
  markProductAnalyticsNoticePresented,
  readProductAnalyticsNotice,
} from "@/lib/product-analytics";

/**
 * Says once what Nodex shares. Main holds every analytics event until this has been on screen long
 * enough to act on, so choosing Manage and turning sharing off sends nothing at all.
 */
export function ProductAnalyticsNotice({ onManage }: { readonly onManage: () => void }) {
  const { data } = useQuery({
    queryKey: ["product-analytics-notice"],
    queryFn: readProductAnalyticsNotice,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const [dismissed, setDismissed] = useState(false);
  const present = data?.present === true && !dismissed;

  useEffect(() => {
    if (present) void markProductAnalyticsNoticePresented().catch(() => undefined);
  }, [present]);

  if (!present) return null;
  const dismiss = () => {
    setDismissed(true);
    void acknowledgeProductAnalyticsNotice().catch(() => undefined);
  };

  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-[61] flex justify-end">
      <AppStatusNotice
        icon={null}
        label="Nodex shares anonymous usage and crash data"
        detail="Never your prompts, code or files."
        actions={
          <>
            <AppStatusNoticeAction
              subdued
              onClick={() => {
                dismiss();
                onManage();
              }}
            >
              Manage
            </AppStatusNoticeAction>
            <AppStatusNoticeAction onClick={dismiss}>Got it</AppStatusNoticeAction>
          </>
        }
      />
    </div>
  );
}
