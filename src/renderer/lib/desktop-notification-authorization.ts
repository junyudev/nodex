import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  defineRendererCommand,
  invokePlainCommandWithTrace,
  invokeRendererQuery,
} from "./renderer-command";
import { useRefetchOnFocus } from "./use-refetch-on-focus";

const requestAuthorization = defineRendererCommand({
  key: "desktop_notification_authorization.request",
  channel: "settings:notification-authorization:request",
  authority: "external",
  owner: "DesktopNotificationAuthorization",
  protocol: { kind: "pending_operation" },
});
const openAuthorizationSettings = defineRendererCommand({
  key: "desktop_notification_authorization.open_settings",
  channel: "settings:notification-authorization:open-settings",
  authority: "external",
  owner: "DesktopNotificationAuthorization",
  protocol: { kind: "pending_operation" },
});
const authorizationKey = ["desktop-notification-authorization"] as const;

/** Native authorization follows the running app bundle, independently of Profile preferences. */
export function useDesktopNotificationAuthorization(open: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: authorizationKey,
    queryFn: () => invokeRendererQuery("settings:notification-authorization:read"),
    enabled: open,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  useRefetchOnFocus(open, query.refetch);
  const request = useMutation({
    mutationFn: () => invokePlainCommandWithTrace(requestAuthorization, null),
    onSuccess: (status) => queryClient.setQueryData(authorizationKey, status),
  });
  const settings = useMutation({
    mutationFn: () => invokePlainCommandWithTrace(openAuthorizationSettings, null),
  });
  return { query, request, settings };
}
