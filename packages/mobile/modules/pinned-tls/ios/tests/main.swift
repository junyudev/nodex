import CryptoKit
import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else { fatalError(message) }
}

func bytes(_ text: String) -> Data { Data(text.utf8) }

/// Feeds a response in pieces of `step` bytes, then reports the peer's close.
func read(
  _ chunks: [Data], method: String = "POST", limit: Int = 1024, step: Int = .max, close: Bool = true
) -> Result<PinnedHttp.Response?, PinnedHttp.Failure> {
  var reader = PinnedHttp.ResponseReader(method: method, bodyLimit: limit)
  do {
    for chunk in chunks {
      var index = chunk.startIndex
      while index < chunk.endIndex {
        let end = chunk.index(index, offsetBy: min(step, chunk.endIndex - index))
        if let response = try reader.consume(chunk[index..<end]) { return .success(response) }
        index = end
      }
    }
    return .success(close ? try reader.end() : nil)
  } catch let failure as PinnedHttp.Failure {
    return .failure(failure)
  } catch {
    fatalError("Unexpected error \(error)")
  }
}

func response(_ text: String, step: Int = .max, method: String = "POST", limit: Int = 1024)
  -> PinnedHttp.Response?
{
  if case .success(let response) = read([bytes(text)], method: method, limit: limit, step: step) {
    return response
  }
  return nil
}

func failure(_ text: String, limit: Int = 1024, close: Bool = true) -> PinnedHttp.Failure? {
  if case .failure(let failure) = read([bytes(text)], limit: limit, close: close) { return failure }
  return nil
}

// The pin is the complete DER digest, exact to the byte and case-insensitive as hex.
let der = Data([0x30, 0x82, 0x01, 0x0a, 0xff])
let digest = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
check(LeafPin.parse(digest).map { LeafPin.matches(der: der, pin: $0) } == true, "Correct pin")
check(LeafPin.parse(digest.uppercased()) == LeafPin.parse(digest), "Uppercase pin")
check(LeafPin.matches(der: der + Data([0]), pin: LeafPin.parse(digest)!) == false, "Reissued DER")
var flipped = LeafPin.parse(digest)!
flipped[31] ^= 1
check(!LeafPin.matches(der: der, pin: flipped), "Accepted a wrong pin")
check(!LeafPin.matches(der: der, pin: Array(flipped.prefix(31))), "Accepted a short pin")
check(LeafPin.parse(String(digest.dropLast())) == nil, "Accepted a short hex pin")
check(LeafPin.parse(String(digest.dropLast()) + "g") == nil, "Accepted non-hex")

// Requests close the connection and frame their own body; caller headers cannot.
check(
  PinnedHttp.request(
    method: "POST", target: "/enroll?x=%20", authority: "[fd00::1]:8471",
    headers: ["content-type": "application/json", "Authorization": "Bearer a"], body: bytes("{}"))
    == bytes(
      "POST /enroll?x=%20 HTTP/1.1\r\nHost: [fd00::1]:8471\r\nAuthorization: Bearer a\r\n"
        + "content-type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"),
  "POST request bytes")
check(
  PinnedHttp.request(method: "GET", target: "/", authority: "h", headers: [:], body: Data())
    == bytes("GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n"), "GET has no length")
check(
  PinnedHttp.request(method: "POST", target: "/", authority: "h", headers: [:], body: Data())
    == bytes("POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
  "Empty POST declares its length")
check(PinnedHttp.validHeaders(["Authorization": "Bearer x", "x-proof": "π"]), "Valid headers")
for invalid in [
  ["Authorization": "a\r\nx: injected"], ["x": "a\nb"], ["x": "a\u{0}"], ["Host": "other"],
  ["Content-Length": "1"], ["transfer-encoding": "chunked"], ["Connection": "keep-alive"],
  ["Upgrade": "h2c"], ["Sec-WebSocket-Key": "x"], ["bad name": "x"], ["": "x"],
  ["x": String(repeating: "a", count: PinnedHttp.requestHeaderLimit)],
] {
  check(!PinnedHttp.validHeaders(invalid), "Accepted headers \(invalid)")
}
check(PinnedHttp.validMethod("POST") && !PinnedHttp.validMethod("post"), "Method case")
check(!PinnedHttp.validMethod("CONNECT") && !PinnedHttp.validMethod("TRACE"), "Tunnel methods")

// Content-Length, in any segmentation; field names fold to lowercase and repeats join.
let fixed = "HTTP/1.1 201 Created\r\nContent-Length: 5\r\nX-A: 1\r\nx-a: 2\r\n\r\nhello"
for step in [1, 2, 7, .max] {
  let parsed = response(fixed, step: step)
  check(parsed?.status == 201 && parsed?.body == bytes("hello"), "Fixed body at step \(step)")
  check(parsed?.headers == ["content-length": "5", "x-a": "1, 2"], "Header fields")
}
check(
  read([bytes(fixed)], close: false)
    == .success(
      PinnedHttp.Response(
        status: 201, headers: ["content-length": "5", "x-a": "1, 2"], body: bytes("hello"))),
  "A complete fixed body does not wait for close")
check(
  response("HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\nhello")?.body == bytes("hello"),
  "Repeated equal lengths")
check(response("HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n")?.body == Data(), "Reason is optional")

// Chunked coding, with extensions and trailers, wins over a stated length.
let chunked =
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\nContent-Length: 99\r\n\r\n"
  + "5;name=value\r\nhello\r\n1 \r\n \r\n6\r\nworld!\r\n0\r\nX-Trailer: t\r\n\r\n"
for step in [1, 3, .max] {
  check(response(chunked, step: step)?.body == bytes("hello world!"), "Chunked at step \(step)")
}
check(
  read([bytes(chunked)], close: false).map { $0?.body } == .success(bytes("hello world!")),
  "A complete chunked body does not wait for close")

// Without framing the body runs until close; only that kind of body may end at close.
check(
  response("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nraw bytes")?.body
    == bytes("raw bytes"), "Non-chunked coding reads until close")
check(
  response("HTTP/1.1 200 OK\r\n\r\nuntil close", step: 4)?.body == bytes("until close"),
  "Unframed body")
check(
  read([bytes("HTTP/1.1 200 OK\r\n\r\npartial")], close: false) == .success(nil),
  "An unframed body waits for close")

// Bodiless responses and interim responses.
check(
  response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n", method: "HEAD")?.body == Data(),
  "HEAD has no body")
check(response("HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\n")?.status == 204, "204")
check(response("HTTP/1.1 304 Not Modified\r\n\r\n")?.status == 304, "304")
check(
  response("HTTP/1.1 100 Continue\r\nX-A: 1\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
    .map { ($0.status, $0.headers) }.map { $0.0 == 200 && $0.1 == ["content-length": "2"] }
    == true, "Interim responses are skipped")
check(failure("HTTP/1.1 101 Switching Protocols\r\n\r\n") == .malformed, "Unrequested upgrade")

// Bounds: the header section, a stated length, chunks and an unframed body.
check(
  failure(
    "HTTP/1.1 200 OK\r\nX: " + String(repeating: "a", count: PinnedHttp.headerLimit),
    close: false) == .limit, "Unbounded header section")
check(
  failure("HTTP/1.1 200 OK\r\nContent-Length: 1025\r\n\r\n", close: false) == .limit,
  "Length over the limit")
check(
  failure(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n400\r\n"
      + String(repeating: "a", count: 1024) + "\r\n1\r\n", close: false) == .limit,
  "Chunks over the limit")
check(
  failure("HTTP/1.1 200 OK\r\n\r\n" + String(repeating: "a", count: 1025), close: false)
    == .limit, "Unframed body over the limit")
check(
  response("HTTP/1.1 200 OK\r\nContent-Length: 1024\r\n\r\n" + String(repeating: "a", count: 1024))?
    .body.count == 1024, "A body at the limit")

// Malformed or truncated responses never yield a response.
for malformed in [
  "HTTP/2 200 OK\r\n\r\n", "HTTP/1.1 20 OK\r\n\r\n", "HTTP/1.1 2000 OK\r\n\r\n",
  "HTTP/1.1 099 Low\r\n\r\n", "HTTPS/1.1 200 OK\r\n\r\n", "HTTP/1.1 200 OK\r\n folded\r\n\r\n",
  "HTTP/1.1 200 OK\r\nName : value\r\n\r\n", "HTTP/1.1 200 OK\r\n: value\r\n\r\n",
  "HTTP/1.1 200 OK\r\nContent-Length: 5, 6\r\n\r\nhello",
  "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n",
  "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5 x\r\nhello\r\n0\r\n\r\n",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloXX0\r\n\r\n",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n",
  "HTTP/1.1 200 OK\r\nContent", "",
] {
  check(
    failure(malformed) == .malformed, "Accepted malformed response \(malformed.debugDescription)")
}

print("Pinned HTTP passed")
