import Foundation
import LocalAuthentication
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        lock.lock()
        original = request.content
        handler = contentHandler
        lock.unlock()

        guard let sealed = request.content.userInfo["n"] as? String,
              let keyText = readPushKey(),
              let payload = PushDecryption.open(sealed, keyText: keyText),
              let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            deliver()
            return
        }

        content.title = payload.title
        content.body = payload.body
        content.threadIdentifier = payload.sessionId
        content.userInfo["sessionId"] = payload.sessionId
        content.userInfo["kind"] = payload.kind.rawValue
        if let hostId = payload.hostId { content.userInfo["hostId"] = hostId }
        deliver(content)
    }

    override func serviceExtensionTimeWillExpire() {
        deliver()
    }

    /// Completion and expiry can race. Deliver once, always falling back to the original alert.
    private func deliver(_ decrypted: UNNotificationContent? = nil) {
        lock.lock()
        let callback = handler
        let content = decrypted ?? original
        handler = nil
        original = nil
        lock.unlock()
        guard let callback, let content else { return }
        callback(content)
    }

    private func readPushKey() -> String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "NodexPushKeychainGroup") as? String,
              !group.isEmpty else { return nil }

        // Matches expo-secure-store's unauthenticated alias, including its Data-valued attributes.
        let account = Data("push-key".utf8)
        let context = LAContext()
        context.interactionNotAllowed = true
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "nodex-push:no-auth",
            kSecAttrAccount as String: account,
            kSecAttrGeneric as String: account,
            kSecAttrAccessGroup as String: group,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: context,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
