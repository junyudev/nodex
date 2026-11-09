import ExpoModulesCore
import Foundation
import Network
import Security

private let bodyLimit = 8 * 1024 * 1024
private let frameLimit = 1024 * 1024

struct TlsOptions: Record {
  @Field var url: String = ""
  @Field var fingerprint: String = ""
  @Field var headers: [String: String] = [:]
  @Field var timeoutMs: Int = 15000
  @Field var method: String = "GET"
  @Field var body: String = ""
}

/// A validated operation target. The pin is the only trust authority, at every address form.
private struct Target {
  let url: URL
  let host: String
  let port: UInt16
  let named: Bool
  let pin: [UInt8]
  let headers: [String: String]
  let timeoutMs: Int
  let method: String
  let body: Data

  init?(_ options: TlsOptions, socket: Bool) {
    guard let url = URL(string: options.url), url.scheme == (socket ? "wss" : "https"),
      url.user == nil, url.password == nil, url.fragment == nil,
      let raw = url.host(percentEncoded: false), !raw.isEmpty,
      let pin = LeafPin.parse(options.fingerprint),
      (1...60000).contains(options.timeoutMs),
      let body = Data(base64Encoded: options.body), body.count <= bodyLimit,
      PinnedHttp.validHeaders(options.headers),
      socket || PinnedHttp.validMethod(options.method),
      socket || body.isEmpty || !(options.method == "GET" || options.method == "HEAD"),
      let port = UInt16(exactly: url.port ?? 443), port > 0
    else { return nil }
    let host = raw.hasPrefix("[") && raw.hasSuffix("]") ? String(raw.dropFirst().dropLast()) : raw
    self.url = url
    self.host = host
    self.port = port
    // IP literals carry no server name; names are sent as SNI.
    self.named = IPv4Address(host) == nil && IPv6Address(host) == nil
    self.pin = pin
    self.headers = options.headers
    self.timeoutMs = options.timeoutMs
    self.method = socket ? "GET" : options.method
    self.body = socket ? Data() : body
  }

  var authority: String {
    let name = named || IPv4Address(host) != nil ? host : "[\(host)]"
    return url.port == nil ? name : "\(name):\(port)"
  }

  var requestTarget: String {
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let path = components?.percentEncodedPath ?? ""
    let query = components?.percentEncodedQuery.map { "?\($0)" } ?? ""
    return (path.isEmpty ? "/" : path) + query
  }
}

/// One operation owns one private `NWConnection`. Network.framework is not the URL Loading
/// System, so App Transport Security does not evaluate it, at any address: the TLS verify block
/// below is the whole trust decision. The handshake completes only after the leaf certificate's
/// complete DER matches the pin, and no application byte, the WebSocket upgrade included, is
/// written before it completes. Do not move this transport back to `URLSession`, whose ATS
/// evaluation cancels a self-signed certificate at tailnet, public and DNS addresses.
private final class Operation: @unchecked Sendable {
  let id: String
  let socket: Bool
  private let target: Target
  private let queue: DispatchQueue
  private let emit: ([String: Any]) -> Void
  private let remove: (Operation) -> Void
  private let lock = NSLock()
  private var connection: NWConnection?
  private var deadline: DispatchWorkItem?
  private var terminal = false
  private var opened = false
  private var pendingSendBytes = 0
  private var reader: PinnedHttp.ResponseReader

  init(
    id: String, target: Target, socket: Bool, emit: @escaping ([String: Any]) -> Void,
    remove: @escaping (Operation) -> Void
  ) {
    self.id = id
    self.target = target
    self.socket = socket
    self.emit = emit
    self.remove = remove
    queue = DispatchQueue(label: "app.nodex.tls.\(id)")
    reader = PinnedHttp.ResponseReader(method: target.method, bodyLimit: bodyLimit)
  }

  func start() {
    let tls = NWProtocolTLS.Options()
    let security = tls.securityProtocolOptions
    sec_protocol_options_set_min_tls_protocol_version(security, .TLSv12)
    sec_protocol_options_add_tls_application_protocol(security, "http/1.1")
    // Every operation decides its pin afresh: no resumption, tickets, renegotiation or
    // data before the handshake finishes.
    sec_protocol_options_set_tls_resumption_enabled(security, false)
    sec_protocol_options_set_tls_tickets_enabled(security, false)
    sec_protocol_options_set_tls_renegotiation_enabled(security, false)
    sec_protocol_options_set_tls_false_start_enabled(security, false)
    sec_protocol_options_set_peer_authentication_required(security, true)
    if target.named { sec_protocol_options_set_tls_server_name(security, target.host) }
    let pin = target.pin
    sec_protocol_options_set_verify_block(
      security,
      { [weak self] _, trust, complete in
        let accepted = Operation.leafMatches(sec_trust_copy_ref(trust).takeRetainedValue(), pin)
        complete(accepted)
        if !accepted { self?.finish(["type": "error", "code": "pin"]) }
      }, queue)
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    let parameters = NWParameters(tls: tls, tcp: tcp)
    // A system proxy is only Network.framework's fallback; the pinned session still ends at
    // the host.
    parameters.preferNoProxies = true
    let endpoint: NWEndpoint
    if socket {
      let options = NWProtocolWebSocket.Options()
      options.autoReplyPing = true
      options.maximumMessageSize = frameLimit
      options.setAdditionalHeaders(
        target.headers.sorted { $0.key < $1.key }.map { (name: $0.key, value: $0.value) })
      parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
      endpoint = .url(target.url)
    } else {
      endpoint = .hostPort(
        host: NWEndpoint.Host(target.host), port: NWEndpoint.Port(rawValue: target.port)!)
    }
    let connection = NWConnection(to: endpoint, using: parameters)
    // A request is bounded as a whole; a socket only until it opens, after which the
    // connection owner's heartbeat and session deadlines apply.
    let deadline = DispatchWorkItem { [weak self] in
      self?.finish(["type": "error", "code": "timeout"])
    }
    lock.lock()
    self.connection = connection
    self.deadline = deadline
    lock.unlock()
    connection.stateUpdateHandler = { [weak self] state in self?.update(state) }
    queue.asyncAfter(deadline: .now() + .milliseconds(target.timeoutMs), execute: deadline)
    connection.start(queue: queue)
  }

  private static func leafMatches(_ trust: SecTrust, _ pin: [UInt8]) -> Bool {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first
    else { return false }
    return LeafPin.matches(der: SecCertificateCopyData(leaf) as Data, pin: pin)
  }

  private func update(_ state: NWConnection.State) {
    switch state {
    case .ready:
      if socket {
        lock.lock()
        opened = true
        let deadline = self.deadline
        lock.unlock()
        deadline?.cancel()
        event(["type": "open"])
        receiveMessage()
      } else {
        writeRequest()
      }
    // Waiting would retry on a path change; a pinned operation fails and lets its owner decide.
    case .waiting(let error), .failed(let error):
      finish(["type": "error", "code": Operation.code(error)])
    case .cancelled:
      finish(["type": "error", "code": "transport"])
    default:
      break
    }
  }

  private static func code(_ error: NWError) -> String {
    switch error {
    case .posix(.ETIMEDOUT): return "timeout"
    case .posix(.EMSGSIZE): return "limit"
    default: return "transport"
    }
  }

  private func writeRequest() {
    guard let connection = current() else { return }
    let request = PinnedHttp.request(
      method: target.method, target: target.requestTarget, authority: target.authority,
      headers: target.headers, body: target.body)
    connection.send(
      content: request,
      completion: .contentProcessed { [weak self] error in
        if let error { self?.finish(["type": "error", "code": Operation.code(error)]) }
      })
    receiveResponse()
  }

  private func receiveResponse() {
    guard let connection = current() else { return }
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      do {
        if let data, !data.isEmpty, let response = try self.reader.consume(data) {
          return self.respond(response)
        }
        if let error { return self.finish(["type": "error", "code": Operation.code(error)]) }
        if isComplete { return self.respond(try self.reader.end()) }
        self.receiveResponse()
      } catch PinnedHttp.Failure.limit {
        self.finish(["type": "error", "code": "limit"])
      } catch {
        self.finish(["type": "error", "code": "transport"])
      }
    }
  }

  private func respond(_ response: PinnedHttp.Response) {
    finish([
      "type": "response", "status": response.status, "headers": response.headers,
      "body": response.body.base64EncodedString(),
    ])
  }

  private func receiveMessage() {
    guard let connection = current() else { return }
    connection.receiveMessage { [weak self] content, context, _, error in
      guard let self else { return }
      if let error { return self.finish(["type": "error", "code": Operation.code(error)]) }
      guard
        let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
          as? NWProtocolWebSocket.Metadata
      else {
        // The stream ended without a close frame.
        return self.finish(["type": "error", "code": "transport"])
      }
      let data = content ?? Data()
      switch metadata.opcode {
      case .close:
        return self.finish(["type": "close", "code": Operation.code(metadata.closeCode)])
      case .text:
        guard data.count <= frameLimit else {
          return self.finish(["type": "error", "code": "limit"])
        }
        guard let text = String(data: data, encoding: .utf8) else {
          return self.finish(["type": "error", "code": "transport"])
        }
        self.event(["type": "message", "text": text])
      case .binary:
        guard data.count <= frameLimit else {
          return self.finish(["type": "error", "code": "limit"])
        }
        self.event(["type": "message", "body": data.base64EncodedString()])
      case .ping, .pong, .cont:
        break
      @unknown default:
        return self.finish(["type": "error", "code": "transport"])
      }
      self.receiveMessage()
    }
  }

  private static func code(_ close: NWProtocolWebSocket.CloseCode) -> Int {
    switch close {
    case .protocolCode(let defined): return Int(defined.rawValue)
    case .applicationCode(let code), .privateCode(let code): return Int(code)
    @unknown default: return 1006
    }
  }

  func send(_ data: Data, binary: Bool) {
    guard socket else { return }
    lock.lock()
    guard !terminal, let connection else {
      lock.unlock()
      return
    }
    // Bound buffered outgoing bytes as well as each individual message.
    guard data.count <= frameLimit, pendingSendBytes + data.count <= bodyLimit else {
      lock.unlock()
      return finish(["type": "error", "code": "limit"])
    }
    pendingSendBytes += data.count
    lock.unlock()
    let message = NWProtocolWebSocket.Metadata(opcode: binary ? .binary : .text)
    connection.send(
      content: data,
      contentContext: NWConnection.ContentContext(identifier: "message", metadata: [message]),
      isComplete: true,
      completion: .contentProcessed { [weak self] error in
        guard let self else { return }
        self.lock.lock()
        self.pendingSendBytes -= data.count
        self.lock.unlock()
        if let error { self.finish(["type": "error", "code": Operation.code(error)]) }
      })
  }

  private func current() -> NWConnection? {
    lock.lock()
    defer { lock.unlock() }
    return terminal ? nil : connection
  }

  func event(_ value: [String: Any]) {
    lock.lock()
    defer { lock.unlock() }
    guard !terminal else { return }
    emit(value.merging(["id": id]) { _, new in new })
  }

  /// Ends the operation once: its last event, if any, then release of the connection.
  func finish(_ value: [String: Any]?) {
    lock.lock()
    guard !terminal else {
      lock.unlock()
      return
    }
    if let value { emit(value.merging(["id": id]) { _, new in new }) }
    terminal = true
    let connection = self.connection
    let deadline = self.deadline
    let opened = self.opened
    lock.unlock()
    deadline?.cancel()
    remove(self)
    guard let connection else { return }
    connection.stateUpdateHandler = nil
    guard opened else { return connection.cancel() }
    // An open socket says goodbye with a close frame, bounded so a stalled peer cannot hold it.
    let close = NWProtocolWebSocket.Metadata(opcode: .close)
    close.closeCode = .protocolCode(.normalClosure)
    connection.send(
      content: nil,
      contentContext: NWConnection.ContentContext(identifier: "close", metadata: [close]),
      isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
    queue.asyncAfter(deadline: .now() + 2) { connection.cancel() }
  }
}

public final class PinnedTlsModule: Module, @unchecked Sendable {
  private var operations: [String: Operation] = [:]
  private let lock = NSRecursiveLock()

  public func definition() -> ModuleDefinition {
    Name("NodexPinnedTls")
    Events("event")
    Function("startRequest") { (id: String, options: TlsOptions) in
      self.start(id, options, socket: false)
    }
    Function("openSocket") { (id: String, options: TlsOptions) in
      self.start(id, options, socket: true)
    }
    Function("cancel") { (id: String) in
      self.operation(id)?.finish(nil)
    }
    Function("send") { (id: String, body: String, binary: Bool) in
      guard let operation = self.operation(id) else { return }
      guard let data = binary ? Data(base64Encoded: body) : Data(body.utf8) else {
        return operation.finish(["type": "error", "code": "invalid"])
      }
      operation.send(data, binary: binary)
    }
    OnDestroy {
      self.lock.lock()
      let active = Array(self.operations.values)
      self.lock.unlock()
      active.forEach { $0.finish(nil) }
    }
  }

  private func operation(_ id: String) -> Operation? {
    lock.lock()
    defer { lock.unlock() }
    return operations[id]
  }

  private func start(_ id: String, _ options: TlsOptions, socket: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard operations[id] == nil, operations.count < 32 else {
      sendEvent("event", ["id": id, "type": "error", "code": "limit"])
      return
    }
    guard let target = Target(options, socket: socket) else {
      sendEvent("event", ["id": id, "type": "error", "code": "invalid"])
      return
    }
    let operation = Operation(
      id: id, target: target, socket: socket,
      emit: { [weak self] in self?.sendEvent("event", $0) },
      remove: { [weak self] operation in
        guard let self else { return }
        self.lock.lock()
        if self.operations[id] === operation { self.operations.removeValue(forKey: id) }
        self.lock.unlock()
      })
    operations[id] = operation
    operation.start()
  }
}
