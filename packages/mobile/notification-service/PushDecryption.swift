import CryptoKit
import Foundation

struct PushPayload: Decodable {
    enum Kind: String, Decodable {
        case needsYou = "needs_you"
        case finished
        case failed
    }

    let kind: Kind
    let sessionId: String
    let hostId: String?
    let title: String
    let body: String
}

enum PushDecryption {
    /// The wire format is base64url(nonce[12] || ciphertext || tag[16]).
    static func open(_ sealed: String, keyText: String) -> PushPayload? {
        guard let key = decodeBase64URL(keyText), key.count == 32,
              let combined = decodeBase64URL(sealed), combined.count >= 28,
              let box = try? ChaChaPoly.SealedBox(combined: combined),
              let plaintext = try? ChaChaPoly.open(box, using: SymmetricKey(data: key)) else {
            return nil
        }
        return try? JSONDecoder().decode(PushPayload.self, from: plaintext)
    }

    private static func decodeBase64URL(_ text: String) -> Data? {
        let base64 = text.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = String(repeating: "=", count: (4 - base64.utf8.count % 4) % 4)
        return Data(base64Encoded: base64 + padding)
    }
}
