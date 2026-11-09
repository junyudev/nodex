import CryptoKit
import Foundation

/// The leaf pin: SHA-256 of the complete certificate DER, compared in constant time.
enum LeafPin {
  static func parse(_ hex: String) -> [UInt8]? {
    let digits = Array(hex.utf8)
    guard digits.count == 64 else { return nil }
    var bytes: [UInt8] = []
    bytes.reserveCapacity(32)
    for index in stride(from: 0, to: 64, by: 2) {
      guard let high = nibble(digits[index]), let low = nibble(digits[index + 1]) else {
        return nil
      }
      bytes.append(high << 4 | low)
    }
    return bytes
  }

  static func matches(der: Data, pin: [UInt8]) -> Bool {
    let digest = Array(SHA256.hash(data: der))
    guard digest.count == pin.count else { return false }
    var difference: UInt8 = 0
    for index in digest.indices { difference |= digest[index] ^ pin[index] }
    return difference == 0
  }

  private static func nibble(_ digit: UInt8) -> UInt8? {
    switch digit {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): return digit - UInt8(ascii: "0")
    case UInt8(ascii: "a")...UInt8(ascii: "f"): return digit - UInt8(ascii: "a") + 10
    case UInt8(ascii: "A")...UInt8(ascii: "F"): return digit - UInt8(ascii: "A") + 10
    default: return nil
    }
  }
}

/// One bounded HTTP/1.1 exchange on a stream that is already pinned: the request asks the
/// server to close, and the response is framed by Content-Length, chunked coding or close.
enum PinnedHttp {
  static let headerLimit = 64 * 1024
  static let requestHeaderLimit = 16 * 1024

  enum Failure: Error, Equatable {
    /// The response is larger than the caller admits.
    case limit
    /// The response is not well-formed HTTP/1.1, or ended early.
    case malformed
  }

  struct Response: Equatable {
    var status: Int
    var headers: [String: String]
    var body: Data
  }

  /// The caller's headers, which must not reach framing, connection or upgrade semantics.
  static func validHeaders(_ headers: [String: String]) -> Bool {
    var size = 0
    for (name, value) in headers {
      size += name.utf8.count + value.utf8.count
      let lower = name.lowercased()
      guard !name.isEmpty, name.utf8.allSatisfy(isToken),
        !value.utf8.contains(where: { $0 == 0 || $0 == 10 || $0 == 13 }),
        !["host", "connection", "upgrade", "content-length", "transfer-encoding"].contains(lower),
        !lower.hasPrefix("sec-websocket-")
      else { return false }
    }
    return size <= requestHeaderLimit
  }

  static func validMethod(_ method: String) -> Bool {
    !method.isEmpty && method.utf8.count <= 16
      && method.utf8.allSatisfy { (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains($0) }
      && method != "CONNECT" && method != "TRACE"
  }

  /// `target` is the URL's percent-encoded path and query; `authority` is its Host value.
  static func request(
    method: String, target: String, authority: String, headers: [String: String], body: Data
  ) -> Data {
    var head = "\(method) \(target) HTTP/1.1\r\nHost: \(authority)\r\n"
    for name in headers.keys.sorted() { head += "\(name): \(headers[name]!)\r\n" }
    if !body.isEmpty || !(method == "GET" || method == "HEAD") {
      head += "Content-Length: \(body.count)\r\n"
    }
    head += "Connection: close\r\n\r\n"
    return Data(head.utf8) + body
  }

  /// Reads one response as bytes arrive. `consume` returns the response once it is complete;
  /// `end` is called when the peer closes and accepts only a body delimited by that close.
  struct ResponseReader {
    private enum Stage {
      case head
      case fixed(Int)
      case chunkSize
      case chunkData(Int)
      case chunkEnd
      case trailers(Int)
      case untilClose
      case done
    }

    private let method: String
    private let bodyLimit: Int
    private var buffer: [UInt8] = []
    private var offset = 0
    private var stage = Stage.head
    private var status = 0
    private var headers: [String: String] = [:]
    private var body: [UInt8] = []

    init(method: String, bodyLimit: Int) {
      self.method = method
      self.bodyLimit = bodyLimit
    }

    mutating func consume(_ bytes: Data) throws -> Response? {
      if case .done = stage { return response }
      compact()
      buffer.append(contentsOf: bytes)
      return try advance()
    }

    mutating func end() throws -> Response {
      switch stage {
      case .untilClose, .done:
        stage = .done
        return response
      default: throw Failure.malformed
      }
    }

    private var response: Response { Response(status: status, headers: headers, body: Data(body)) }
    private var available: Int { buffer.count - offset }

    private mutating func advance() throws -> Response? {
      while true {
        switch stage {
        case .head:
          guard let end = find([13, 10, 13, 10]) else {
            if available > PinnedHttp.headerLimit { throw Failure.limit }
            return nil
          }
          guard end + 4 - offset <= PinnedHttp.headerLimit else { throw Failure.limit }
          let head = Array(buffer[offset..<end])
          offset = end + 4
          try begin(head)
        case .fixed(let remaining):
          let count = take(remaining)
          if count < remaining {
            stage = .fixed(remaining - count)
            return nil
          }
          stage = .done
        case .chunkSize:
          guard let end = find([13, 10]) else {
            if available > 1024 { throw Failure.malformed }
            return nil
          }
          let size = try chunkSize(Array(buffer[offset..<end]))
          offset = end + 2
          guard size <= bodyLimit - body.count else { throw Failure.limit }
          stage = size == 0 ? .trailers(0) : .chunkData(size)
        case .chunkData(let remaining):
          let count = take(remaining)
          if count < remaining {
            stage = .chunkData(remaining - count)
            return nil
          }
          stage = .chunkEnd
        case .chunkEnd:
          guard available >= 2 else { return nil }
          guard buffer[offset] == 13, buffer[offset + 1] == 10 else { throw Failure.malformed }
          offset += 2
          stage = .chunkSize
        case .trailers(let size):
          guard let end = find([13, 10]) else {
            if size + available > PinnedHttp.headerLimit { throw Failure.limit }
            return nil
          }
          let line = end - offset
          offset = end + 2
          guard size + line + 2 <= PinnedHttp.headerLimit else { throw Failure.limit }
          stage = line == 0 ? .done : .trailers(size + line + 2)
        case .untilClose:
          guard body.count + available <= bodyLimit else { throw Failure.limit }
          _ = take(available)
          return nil
        case .done:
          return response
        }
      }
    }

    /// Parses a response head and chooses how its body is delimited (RFC 9112 §6.3).
    private mutating func begin(_ head: [UInt8]) throws {
      var lines = head.split(separator: 10, omittingEmptySubsequences: false).map { line in
        line.last == 13 ? Array(line.dropLast()) : Array(line)
      }
      guard !lines.isEmpty else { throw Failure.malformed }
      let statusLine = lines.removeFirst()
      // HTTP-version SP 3DIGIT [SP reason-phrase]
      guard statusLine.count >= 12, Array(statusLine[0..<7]) == Array("HTTP/1.".utf8),
        (48...57).contains(statusLine[7]), statusLine[8] == 32,
        statusLine[9...11].allSatisfy({ (48...57).contains($0) }),
        statusLine.count == 12 || statusLine[12] == 32
      else { throw Failure.malformed }
      let code = statusLine[9...11].reduce(0) { $0 * 10 + Int($1 - 48) }
      guard (100...599).contains(code) else { throw Failure.malformed }
      var fields: [String: String] = [:]
      for line in lines {
        // Obsolete line folding, whitespace before the colon and nameless fields are refused.
        guard let colon = line.firstIndex(of: 58), colon > 0,
          line[..<colon].allSatisfy(PinnedHttp.isToken)
        else { throw Failure.malformed }
        let name = String(decoding: line[..<colon], as: UTF8.self).lowercased()
        var start = colon + 1
        var end = line.count
        while start < end, line[start] == 32 || line[start] == 9 { start += 1 }
        while end > start, line[end - 1] == 32 || line[end - 1] == 9 { end -= 1 }
        let bytes = line[start..<end]
        guard !bytes.contains(0) else { throw Failure.malformed }
        let value =
          String(bytes: bytes, encoding: .utf8) ?? String(bytes: bytes, encoding: .isoLatin1) ?? ""
        fields[name] = fields[name].map { "\($0), \(value)" } ?? value
      }
      if (100...199).contains(code) {
        // An interim response precedes the final one; this client never asks to switch protocols.
        guard code != 101 else { throw Failure.malformed }
        stage = .head
        return
      }
      status = code
      headers = fields
      if method == "HEAD" || code == 204 || code == 304 {
        stage = .done
      } else if let codings = fields["transfer-encoding"] {
        let last = codings.split(separator: ",").last?.trimmingCharacters(in: .whitespaces)
        stage = last?.lowercased() == "chunked" ? .chunkSize : .untilClose
      } else if let lengths = fields["content-length"] {
        let values = Set(
          lengths.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
        guard values.count == 1, let text = values.first, !text.isEmpty, text.count <= 18,
          text.utf8.allSatisfy({ (48...57).contains($0) }), let length = Int(text)
        else { throw Failure.malformed }
        guard length <= bodyLimit else { throw Failure.limit }
        stage = length == 0 ? .done : .fixed(length)
      } else {
        stage = .untilClose
      }
    }

    /// `chunk-size [BWS ";" chunk-ext]`; extensions carry nothing this client uses.
    private func chunkSize(_ line: [UInt8]) throws -> Int {
      let digits = line.prefix { $0 != 59 && $0 != 32 && $0 != 9 }
      let rest = line.dropFirst(digits.count).drop { $0 == 32 || $0 == 9 }
      guard !digits.isEmpty, digits.count <= 15, rest.first == nil || rest.first == 59 else {
        throw Failure.malformed
      }
      var size = 0
      for digit in digits {
        let value: Int
        switch digit {
        case 48...57: value = Int(digit - 48)
        case 97...102: value = Int(digit - 87)
        case 65...70: value = Int(digit - 55)
        default: throw Failure.malformed
        }
        size = size << 4 | value
      }
      return size
    }

    /// Moves up to `limit` buffered bytes into the body.
    private mutating func take(_ limit: Int) -> Int {
      let count = min(limit, available)
      body.append(contentsOf: buffer[offset..<(offset + count)])
      offset += count
      return count
    }

    private func find(_ pattern: [UInt8]) -> Int? {
      guard available >= pattern.count else { return nil }
      var index = offset
      search: while index + pattern.count <= buffer.count {
        for (step, byte) in pattern.enumerated() where buffer[index + step] != byte {
          index += 1
          continue search
        }
        return index
      }
      return nil
    }

    private mutating func compact() {
      if offset > 0 && offset == buffer.count {
        buffer.removeAll(keepingCapacity: true)
        offset = 0
      } else if offset > 64 * 1024 {
        buffer.removeFirst(offset)
        offset = 0
      }
    }
  }

  fileprivate static func isToken(_ byte: UInt8) -> Bool {
    switch byte {
    case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"),
      UInt8(ascii: "0")...UInt8(ascii: "9"):
      return true
    default: return Array("!#$%&'*+-.^_`|~".utf8).contains(byte)
    }
  }
}
