import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";

import { targetOfNotification, type NotificationTarget } from "../../runtime/notification-payload";

// A notification arrives while the app is open only in the moment before its Space sees it connect.
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
});

/** Opens what a tapped notification names, including the tap that launched the app. */
export const useNotificationRouting = (
  ready: boolean,
  openTarget: (target: NotificationTarget) => void,
) => {
  useEffect(() => {
    if (!ready || Platform.OS !== "ios") return undefined;
    const open = (response: Notifications.NotificationResponse) => {
      const target = targetOfNotification(response);
      if (target) openTarget(target);
    };
    const launch = Notifications.getLastNotificationResponse();
    if (launch) {
      open(launch);
      Notifications.clearLastNotificationResponse();
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [openTarget, ready]);
};
