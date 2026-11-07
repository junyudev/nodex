import CryptoKit
import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fatalError(message)
    }
}

func encode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

// The exact vector in mobile-protocol/src/push.test.ts: key 0...31, nonce 200...211.
let key = Data((0..<32).map { UInt8($0) })
let keyText = encode(key)
let vector = "yMnKy8zNzs_Q0dLTbkT45gkuYkck2C-D4afMDutszgvQzPVu6-VXMlyOKjAkfGWxcsBg4ezErFwEHA3hYwZ13225mh7BPd1rfJwSQ93V2-0nQKJHTpP46nDWZ5T3qZ9muHmpLqJRRwQdZKHBwXbl2fQNPHuh2JI"
guard let payload = PushDecryption.open(vector, keyText: keyText) else {
    fatalError("Could not open the protocol vector")
}
check(payload.kind == .needsYou, "Wrong kind")
check(payload.sessionId == "session-1", "Wrong session")
check(payload.title == "修复登录", "UTF-8 title was not preserved")
check(payload.body == "Apply a patch?", "Wrong body")
check(PushDecryption.open(String(vector.dropLast(2)) + "AA", keyText: keyText) == nil, "Accepted a tampered tag")
check(PushDecryption.open(vector, keyText: encode(Data(repeating: 0, count: 32))) == nil, "Accepted a wrong key")
check(PushDecryption.open(vector, keyText: "bad-key") == nil, "Accepted a malformed key")
check(PushDecryption.open("bad payload!", keyText: keyText) == nil, "Accepted malformed base64")
check(PushDecryption.open("AA", keyText: keyText) == nil, "Accepted a truncated sealed box")

// Authenticated bytes must still satisfy the payload contract.
func seal(_ text: String) throws -> String {
    let nonce = try ChaChaPoly.Nonce(data: Data((200..<212).map { UInt8($0) }))
    return encode(try ChaChaPoly.seal(Data(text.utf8), using: SymmetricKey(data: key), nonce: nonce).combined)
}
for invalid in [
    "not json",
    #"{"kind":"other","sessionId":"session-1","title":"Title","body":"Body"}"#,
    #"{"kind":"finished","sessionId":"session-1","title":"Title"}"#,
    #"{"kind":"failed","sessionId":1,"title":"Title","body":"Body"}"#,
] {
    let sealed = try seal(invalid)
    check(PushDecryption.open(sealed, keyText: keyText) == nil, "Accepted an invalid payload")
}
for kind in ["finished", "failed"] {
    let sealed = try seal("{\"kind\":\"\(kind)\",\"sessionId\":\"session-1\",\"title\":\"Title\",\"body\":\"Body\",\"future\":true}")
    check(PushDecryption.open(sealed, keyText: keyText)?.kind.rawValue == kind, "Rejected a valid kind or an extra field")
}
print("Push decryption passed")
