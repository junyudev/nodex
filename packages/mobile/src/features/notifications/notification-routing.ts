import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";

import { chatOfNotification } from "./notification-payload";

// A notification arrives while the app is open only in the moment before the desktop sees it connect.
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
});

/** Opens the chat behind a tapped notification, including the tap that launched the app. */
export const useNotificationRouting = (
  ready: boolean,
  openChat: (chat: NonNullable<ReturnType<typeof chatOfNotification>>) => void,
) => {
  useEffect(() => {
    if (!ready || Platform.OS !== "ios") return undefined;
    const open = (response: Notifications.NotificationResponse) => {
      const chat = chatOfNotification(response);
      if (chat) openChat(chat);
    };
    const launch = Notifications.getLastNotificationResponse();
    if (launch) {
      open(launch);
      Notifications.clearLastNotificationResponse();
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [openChat, ready]);
};
