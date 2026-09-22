import ApplicationServices
import AppKit
import CoreAudio
import CoreGraphics
import CryptoKit
import Foundation

private let protocolVersion = 4
private let maximumMessageBytes = 64 * 1024
private let maximumPasteboardFormatBytes = 8 * 1024 * 1024
private let maximumPasteboardSnapshotBytes = 32 * 1024 * 1024
private let relevantFlags: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn]
private let modifierKeyCodes: Set<CGKeyCode> = [54, 55, 56, 58, 59, 60, 61, 62, 63]

private struct Hotkey {
    let id: String
    let mode: String
    let configurationGeneration: UInt64
    let modifiers: CGEventFlags
    let keyCode: CGKeyCode?
    let bareModifierKeyCodes: Set<CGKeyCode>?
    var pressed: Bool
    var suppressed = false
}

private final class HelperState {
    static let shared = HelperState()
    var hotkeys: [String: Hotkey] = [:]
    var eventTap: CFMachPort?
    var runLoopSource: CFRunLoopSource?
    var generation: UInt64 = 0
    var captureRequestId: String?
    var captureTimer: Timer?
    var modifierCapture = ModifierCapture()
    var heldKeys: Set<CGKeyCode> = []
    var paste: PasteTransaction?
    var shuttingDown = false
}

private let outputLock = NSLock()

#if !DICTATION_HELPER_TESTS
@main
private enum NodexDictationHelper {
    static func main() {
        emit([
            "type": "ready",
            "protocolVersion": protocolVersion,
        ])
        DispatchQueue.global(qos: .userInitiated).async {
            readCommands()
        }
        RunLoop.main.run()
    }
}

#endif

private func readCommands() {
    var line = Data()
    var oversized = false
    while let chunk = try? FileHandle.standardInput.read(upToCount: maximumMessageBytes), !chunk.isEmpty {
        for byte in chunk {
            if byte != 0x0A {
                if !oversized { line.append(byte) }
                if line.count > maximumMessageBytes { line.removeAll(keepingCapacity: true); oversized = true }
                continue
            }
            if !oversized, let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                // Backpressure the reader rather than queueing unbounded commands on Main.
                DispatchQueue.main.sync { handle(request) }
            } else {
                emitError(id: nil, code: "invalid-message")
            }
            line.removeAll(keepingCapacity: true)
            oversized = false
        }
    }
    DispatchQueue.main.async {
        uninstallEventTap()
        HelperState.shared.shuttingDown = true
        guard let paste = HelperState.shared.paste else { exit(EXIT_SUCCESS) }
        paste.cancel()
    }
}

private func handle(_ request: [String: Any]) {
    guard let id = request["id"] as? String,
          id.count <= 128,
          let type = request["type"] as? String
    else {
        emitError(id: nil, code: "invalid-request")
        return
    }

    switch type {
    case "capabilities":
        let inputMonitoring = CGPreflightListenEventAccess()
        let accessibilityOptions = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false,
        ] as CFDictionary
        let accessibility = AXIsProcessTrustedWithOptions(accessibilityOptions)
        emitResponse(id: id, value: [
            "inputMonitoring": inputMonitoring,
            "accessibility": accessibility,
        ])
    case "requestInputMonitoring":
        emitResponse(id: id, value: ["granted": CGRequestListenEventAccess()])
    case "requestAccessibility":
        let options = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
        ] as CFDictionary
        emitResponse(id: id, value: ["granted": AXIsProcessTrustedWithOptions(options)])
    case "replaceBindings":
        guard let generationValue = request["generation"] as? NSNumber,
              generationValue.uint64Value > 0,
              let rawBindings = request["bindings"] as? [[String: Any]],
              rawBindings.count <= 8,
              let bindings = parseBindings(rawBindings, generation: generationValue.uint64Value)
        else {
            emitError(id: id, code: "invalid-hotkey")
            return
        }
        if hasHotkeyConflict(bindings) {
            emitError(id: id, code: "hotkey-conflict")
            return
        }
        if bindings.count > 0 && !installEventTapIfNeeded() {
            emitError(id: id, code: "input-monitoring-denied")
            return
        }
        HelperState.shared.hotkeys = preservingHotkeyState(bindings, previous: HelperState.shared.hotkeys)
        uninstallEventTapIfUnused()
        emitResponse(id: id, value: [
            "applied": true,
            "generation": generationValue,
        ])
    case "armRegularRelease":
        guard let bindingId = request["bindingId"] as? String,
              let generation = request["generation"] as? NSNumber,
              var hotkey = HelperState.shared.hotkeys[bindingId],
              hotkey.keyCode != nil,
              hotkey.configurationGeneration == generation.uint64Value else {
            emitError(id: id, code: "invalid-hotkey")
            return
        }
        hotkey.pressed = true
        // The modifier may have been released while Electron's press crossed the pipe.
        let transition = transitionHotkey(
            &hotkey, type: .flagsChanged, keyCode: 0,
            flags: CGEventSource.flagsState(.combinedSessionState).intersection(relevantFlags),
            repeated: false, hasOtherKey: false, keyDown: { _ in false }
        )
        HelperState.shared.hotkeys[bindingId] = hotkey
        emitResponse(id: id, value: true)
        if let transition { emitHotkeyEvent(hotkey: hotkey, type: transition) }
    case "captureBareModifier":
        guard installEventTapIfNeeded() else {
            emitError(id: id, code: "input-monitoring-denied")
            return
        }
        if let previousId = HelperState.shared.captureRequestId {
            emitError(id: previousId, code: "capture-replaced")
        }
        HelperState.shared.captureRequestId = id
        HelperState.shared.modifierCapture = ModifierCapture(
            flags: CGEventSource.flagsState(.combinedSessionState).intersection(relevantFlags),
            keys: currentModifierKeys(),
            cancelled: !HelperState.shared.heldKeys.isEmpty
        )
        HelperState.shared.captureTimer?.invalidate()
        HelperState.shared.captureTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { _ in
            guard HelperState.shared.captureRequestId == id else { return }
            HelperState.shared.captureRequestId = nil
            HelperState.shared.captureTimer = nil
            emitError(id: id, code: "capture-timeout")
            uninstallEventTapIfUnused()
        }
    case "cancelCapture":
        if let captureId = HelperState.shared.captureRequestId,
           request["requestId"] as? String == captureId {
            HelperState.shared.captureRequestId = nil
            HelperState.shared.captureTimer?.invalidate()
            HelperState.shared.captureTimer = nil
            HelperState.shared.modifierCapture = ModifierCapture()
            emitError(id: captureId, code: "aborted")
            uninstallEventTapIfUnused()
        }
        emitResponse(id: id, value: true)
    case "captureClipboardFingerprint":
        guard let snapshot = snapshotPasteboard(.general) else {
            emitError(id: id, code: "clipboard-unavailable")
            return
        }
        emitResponse(id: id, value: snapshot.fingerprint)
    case "copy":
        guard let text = validPasteText(request), HelperState.shared.paste == nil else {
            emitError(id: id, code: "paste-unavailable")
            return
        }
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.setString(text, forType: .string) else {
            emitError(id: id, code: "paste-failed")
            return
        }
        emitResponse(id: id, value: true)
    case "safePaste":
        guard let text = validPasteText(request), HelperState.shared.paste == nil else {
            emitError(id: id, code: "paste-unavailable")
            return
        }
        let transaction = PasteTransaction(
            text: text,
            pasteboard: .general,
            trusted: AXIsProcessTrusted,
            dispatch: dispatchFocusedPaste,
            completion: { result in
                HelperState.shared.paste = nil
                switch result {
                case .success(let value): emitResponse(id: id, value: value)
                case .failure: emitError(id: id, code: "aborted")
                }
                if HelperState.shared.shuttingDown { exit(EXIT_SUCCESS) }
            }
        )
        transaction.requestId = id
        HelperState.shared.paste = transaction
        transaction.start(
            expectedFingerprint: request["clipboardFingerprint"] as? String,
            recordingStoppedAtMs: (request["recordingStoppedAtMs"] as? NSNumber)?.doubleValue
        )
    case "cancelPaste":
        if let requestId = request["requestId"] as? String,
           HelperState.shared.paste?.requestId == requestId {
            HelperState.shared.paste?.cancel()
        }
        emitResponse(id: id, value: true)
    case "queryBuiltInMic":
        emitResponse(id: id, value: preferredBuiltInMicrophoneName() ?? NSNull())
    default:
        emitError(id: id, code: "unsupported-request")
    }
}

private func validPasteText(_ request: [String: Any]) -> String? {
    guard let text = request["text"] as? String, !text.isEmpty,
          text.utf8.count <= maximumMessageBytes / 2 else { return nil }
    return text
}

private struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]

    var fingerprint: String {
        var hash = SHA256()
        // Length prefixes preserve item/format boundaries, including empty formats.
        func append(_ data: Data) {
            var length = UInt64(data.count).bigEndian
            withUnsafeBytes(of: &length) { hash.update(data: Data($0)) }
            hash.update(data: data)
        }
        append(Data(String(items.count).utf8))
        for item in items {
            append(Data(String(item.count).utf8))
            for type in item.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
                append(Data(type.rawValue.utf8))
                append(item[type]!)
            }
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

private func snapshotPasteboard(_ pasteboard: NSPasteboard) -> PasteboardSnapshot? {
    let changeCount = pasteboard.changeCount
    let sourceItems = pasteboard.pasteboardItems ?? []
    guard sourceItems.count <= 256 else { return nil }
    var totalBytes = 0
    var formatCount = 0
    var items: [[NSPasteboard.PasteboardType: Data]] = []
    for sourceItem in sourceItems {
        var item: [NSPasteboard.PasteboardType: Data] = [:]
        formatCount += sourceItem.types.count
        guard formatCount <= 1024 else { return nil }
        for type in sourceItem.types {
            guard type.rawValue.utf8.count <= 1024,
                  let data = sourceItem.data(forType: type),
                  data.count <= maximumPasteboardFormatBytes else { return nil }
            totalBytes += data.count
            guard totalBytes <= maximumPasteboardSnapshotBytes else { return nil }
            item[type] = data
        }
        items.append(item)
    }
    guard pasteboard.changeCount == changeCount else { return nil }
    return PasteboardSnapshot(items: items)
}

private func restorePasteboard(_ snapshot: PasteboardSnapshot, to pasteboard: NSPasteboard) {
    let items = snapshot.items.map { formats in
        let item = NSPasteboardItem()
        for (type, data) in formats { item.setData(data, forType: type) }
        return item
    }
    pasteboard.clearContents()
    if !items.isEmpty { _ = pasteboard.writeObjects(items) }
}

private final class PasteCancellation {
    private let lock = NSLock()
    private var value = false
    var cancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
    func cancel() {
        lock.lock()
        value = true
        lock.unlock()
    }
}

private enum PasteFailure: Error { case aborted }

/** Main-thread pasteboard authority. Accessibility work runs separately so Escape stays responsive. */
private final class PasteTransaction {
    var requestId = ""
    private let text: String
    private let pasteboard: NSPasteboard
    private let trusted: () -> Bool
    private let dispatch: (PasteCancellation, @escaping (Bool) -> Void) -> Void
    private let completion: (Result<[String: Any], PasteFailure>) -> Void
    private let cancellation = PasteCancellation()
    private var snapshot: PasteboardSnapshot?
    private var insertedFingerprint: String?
    private var dispatched = false
    private var finished = false

    init(text: String, pasteboard: NSPasteboard, trusted: @escaping () -> Bool,
         dispatch: @escaping (PasteCancellation, @escaping (Bool) -> Void) -> Void,
         completion: @escaping (Result<[String: Any], PasteFailure>) -> Void) {
        self.text = text
        self.pasteboard = pasteboard
        self.trusted = trusted
        self.dispatch = dispatch
        self.completion = completion
    }

    func start(expectedFingerprint: String?, recordingStoppedAtMs: Double?) {
        guard !finished else { return }
        guard let original = snapshotPasteboard(pasteboard) else {
            fail(reason: trusted() ? "paste" : "accessibility", copied: false)
            return
        }
        guard expectedFingerprint == nil || expectedFingerprint == original.fingerprint else {
            fail(reason: trusted() ? "clipboard-changed" : "accessibility", copied: false)
            return
        }
        snapshot = original
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            restorePasteboard(original, to: pasteboard)
            fail(reason: "paste", copied: false)
            return
        }
        insertedFingerprint = snapshotPasteboard(pasteboard)?.fingerprint
        guard trusted() else {
            fail(reason: "accessibility", copied: true)
            return
        }
        let elapsed = recordingStoppedAtMs.flatMap { $0.isFinite ? max(0, Date().timeIntervalSince1970 * 1000 - $0) : nil } ?? 0
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, 150 - elapsed) / 1000) {
            self.pasteAfterDelay()
        }
    }

    func cancel() {
        guard !finished else { return }
        cancellation.cancel()
        // Once dispatch begins, its completion owns the 700 ms consumption grace.
        if !dispatched { finishRestoring(aborted: true, restoreMs: 0) }
    }

    private func ownsClipboard() -> Bool {
        guard let insertedFingerprint else { return false }
        return snapshotPasteboard(pasteboard)?.fingerprint == insertedFingerprint
    }

    private func pasteAfterDelay() {
        guard !finished else { return }
        guard ownsClipboard() else {
            fail(reason: "clipboard-changed", copied: false)
            return
        }
        guard trusted() else {
            fail(reason: "accessibility", copied: true)
            return
        }
        dispatched = true
        dispatch(cancellation) { success in
            guard !self.finished else { return }
            if !success && !self.cancellation.cancelled {
                self.fail(reason: self.trusted() ? "paste" : "accessibility", copied: self.ownsClipboard())
                return
            }
            let started = DispatchTime.now().uptimeNanoseconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
                self.finishRestoring(aborted: self.cancellation.cancelled, restoreMs: elapsed)
            }
        }
    }

    private func finishRestoring(aborted: Bool, restoreMs: Double) {
        guard !finished else { return }
        if ownsClipboard(), let snapshot { restorePasteboard(snapshot, to: pasteboard) }
        finished = true
        completion(aborted ? .failure(.aborted) : .success([
            "pasted": true, "clipboardRestoreMs": restoreMs,
        ]))
    }

    private func fail(reason: String, copied: Bool) {
        finished = true
        // Failed dispatch deliberately leaves copied text available for manual paste.
        completion(.success([
            "pasted": false, "clipboardRestoreMs": 0,
            "failure": ["text": text, "copied": copied, "reason": reason],
        ]))
    }
}

private func audioDeviceId(selector: AudioObjectPropertySelector) -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var device = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device
    ) == noErr, device != kAudioObjectUnknown else { return nil }
    return device
}

private func audioDeviceUInt32(_ device: AudioDeviceID, selector: AudioObjectPropertySelector) -> UInt32? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else {
        return nil
    }
    return value
}

private func audioDevices() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
    ) == noErr, size > 0 else { return [] }
    var devices = Array(
        repeating: AudioDeviceID(kAudioObjectUnknown),
        count: Int(size) / MemoryLayout<AudioDeviceID>.size
    )
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices
    ) == noErr else { return [] }
    return devices
}

private func audioDeviceHasInput(_ device: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr && size > 0
}

private func audioDeviceName(_ device: AudioDeviceID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr,
          let value else {
        return nil
    }
    let name = value.takeUnretainedValue() as String
    return name.isEmpty ? nil : name
}

private func isBluetoothTransport(_ transport: UInt32?) -> Bool {
    transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
}

private func hasBuiltInDisplay() -> Bool {
    NSScreen.screens.contains { screen in
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return false }
        return CGDisplayIsBuiltin(CGDirectDisplayID(number.uint32Value)) != 0
    }
}

/** Avoids switching a Bluetooth output into the low-bandwidth headset profile. */
private func preferredBuiltInMicrophoneName() -> String? {
    guard hasBuiltInDisplay(),
          let defaultInput = audioDeviceId(selector: kAudioHardwarePropertyDefaultInputDevice),
          let defaultOutput = audioDeviceId(selector: kAudioHardwarePropertyDefaultOutputDevice),
          isBluetoothTransport(audioDeviceUInt32(defaultInput, selector: kAudioDevicePropertyTransportType)),
          isBluetoothTransport(audioDeviceUInt32(defaultOutput, selector: kAudioDevicePropertyTransportType)),
          audioDeviceUInt32(defaultOutput, selector: kAudioDevicePropertyDeviceIsAlive) == 1
    else { return nil }
    return audioDevices().first(where: { device in
        audioDeviceUInt32(device, selector: kAudioDevicePropertyTransportType)
            == kAudioDeviceTransportTypeBuiltIn && audioDeviceHasInput(device)
    }).flatMap(audioDeviceName)
}

private func installEventTapIfNeeded() -> Bool {
    if HelperState.shared.eventTap != nil { return true }
    guard CGPreflightListenEventAccess() else { return false }
    let mask = (1 << CGEventType.keyDown.rawValue)
        | (1 << CGEventType.keyUp.rawValue)
        | (1 << CGEventType.flagsChanged.rawValue)
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: CGEventMask(mask),
        callback: eventTapCallback,
        userInfo: nil
    ) else { return false }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    HelperState.shared.heldKeys = Set((0...127).map { CGKeyCode($0) }.filter {
        !modifierKeyCodes.contains($0) && CGEventSource.keyState(.combinedSessionState, key: $0)
    })
    HelperState.shared.eventTap = tap
    HelperState.shared.runLoopSource = source
    return true
}

private func uninstallEventTapIfUnused() {
    guard HelperState.shared.hotkeys.isEmpty,
          HelperState.shared.captureRequestId == nil else { return }
    uninstallEventTap()
}

private func uninstallEventTap() {
    if let source = HelperState.shared.runLoopSource {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
    }
    if let tap = HelperState.shared.eventTap {
        CFMachPortInvalidate(tap)
    }
    HelperState.shared.eventTap = nil
    HelperState.shared.runLoopSource = nil
    HelperState.shared.heldKeys.removeAll()
}

private let eventTapCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = HelperState.shared.eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    handleKeyboardEvent(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

private func handleKeyboardEvent(type: CGEventType, event: CGEvent) {
    let flags = event.flags.intersection(relevantFlags)
    let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))

    if let captureId = HelperState.shared.captureRequestId,
       let accelerator = HelperState.shared.modifierCapture.transition(type: type, flags: flags, keys: currentModifierKeys()) {
        HelperState.shared.captureRequestId = nil
        HelperState.shared.captureTimer?.invalidate()
        HelperState.shared.captureTimer = nil
        emitResponse(id: captureId, value: ["accelerator": accelerator])
        uninstallEventTapIfUnused()
    }

    let repeated = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
    if type == .keyDown { HelperState.shared.heldKeys.insert(keyCode) }
    if type == .keyUp { HelperState.shared.heldKeys.remove(keyCode) }
    for (id, var hotkey) in HelperState.shared.hotkeys {
        let transition = transitionHotkey(
            &hotkey, type: type, keyCode: keyCode, flags: flags, repeated: repeated,
            hasOtherKey: !HelperState.shared.heldKeys.isEmpty,
            keyDown: { CGEventSource.keyState(.combinedSessionState, key: $0) }
        )
        HelperState.shared.hotkeys[id] = hotkey
        if let transition { emitHotkeyEvent(hotkey: hotkey, type: transition) }
    }
}

private func currentModifierKeys() -> Set<CGKeyCode> {
    Set(modifierKeyCodes.filter { CGEventSource.keyState(.combinedSessionState, key: $0) })
}

/** One native authority captures both physical sides and family chords at first release. */
private struct ModifierCapture {
    var flags: CGEventFlags = []
    var keys: Set<CGKeyCode> = []
    var cancelled = false

    mutating func transition(type: CGEventType, flags next: CGEventFlags, keys nextKeys: Set<CGKeyCode> = []) -> String? {
        if type == .keyDown { cancelled = true; return nil }
        guard type == .flagsChanged else { return nil }
        let previous = flags
        let previousKeys = keys
        flags = next
        keys = nextKeys
        if cancelled {
            if next.isEmpty { cancelled = false }
            return nil
        }
        guard !previous.subtracting(next).isEmpty || !previousKeys.subtracting(nextKeys).isEmpty else { return nil }
        let families: [(CGEventFlags, String)] = [
            (.maskControl, "Ctrl"), (.maskCommand, "Command"), (.maskAlternate, "Alt"),
            (.maskShift, "Shift"), (.maskSecondaryFn, "Fn"),
        ]
        let names = families.compactMap { previous.contains($0.0) ? $0.1 : nil }
        if names.count >= 2 { return names.joined(separator: "+") }
        if previous == .maskSecondaryFn { return "Fn" }
        let named: [(Set<CGKeyCode>, String)] = [
            ([58], "LeftOption"), ([61], "RightOption"), ([58, 61], "DoubleOption"),
            ([55], "LeftCommand"), ([54], "RightCommand"), ([54, 55], "DoubleCommand"),
            ([59], "LeftControl"), ([56, 60], "DoubleShift"),
        ]
        return named.first { $0.0 == previousKeys }?.1
    }
}

/** Modifier-only gestures are invalidated by chords until their required keys are released. */
private func transitionHotkey(
    _ hotkey: inout Hotkey, type: CGEventType, keyCode: CGKeyCode,
    flags: CGEventFlags, repeated: Bool, hasOtherKey: Bool,
    keyDown: (CGKeyCode) -> Bool
) -> String? {
    if hotkey.keyCode != nil {
        guard hotkey.pressed, type == .flagsChanged, !flags.contains(hotkey.modifiers) else { return nil }
        hotkey.pressed = false
        return "released"
    }
    let bareKeys = hotkey.bareModifierKeyCodes
    let allDown = bareKeys?.allSatisfy(keyDown) ?? flags.contains(hotkey.modifiers)
    let anyDown = bareKeys?.contains(where: keyDown) ?? !flags.intersection(hotkey.modifiers).isEmpty
    if hotkey.suppressed {
        if !anyDown { hotkey.suppressed = false }
        return nil
    }
    let chord = hasOtherKey || !flags.subtracting(hotkey.modifiers).isEmpty
        || (bareKeys.map { modifierKeyCodes.subtracting($0).contains(where: keyDown) } ?? false)
    if hotkey.pressed && chord {
        hotkey.pressed = false
        hotkey.suppressed = anyDown
        return "cancelled"
    }
    if hotkey.pressed && !allDown {
        hotkey.pressed = false
        return "released"
    }
    guard type == .flagsChanged, bareKeys?.contains(keyCode) ?? true, allDown, !hotkey.pressed else { return nil }
    if chord {
        hotkey.suppressed = true
        return nil
    }
    hotkey.pressed = true
    return "pressed"
}

private func emitHotkeyEvent(hotkey: Hotkey, type: String) {
    HelperState.shared.generation += 1
    var event: [String: Any] = [
        "type": type,
        "bindingId": hotkey.id,
        "mode": hotkey.mode,
        "configurationGeneration": hotkey.configurationGeneration,
        "sequence": HelperState.shared.generation,
    ]
    if let application = NSWorkspace.shared.frontmostApplication {
        event["target"] = [
            "pid": application.processIdentifier,
            "bundleIdentifier": application.bundleIdentifier ?? "pid.\(application.processIdentifier)",
        ]
    }
    emit(event)
}

private func parseBindings(
    _ values: [[String: Any]],
    generation: UInt64
) -> [String: Hotkey]? {
    var result: [String: Hotkey] = [:]
    for value in values {
        guard let bindingId = value["bindingId"] as? String,
              !bindingId.isEmpty,
              bindingId.count <= 128,
              result[bindingId] == nil,
              let mode = value["mode"] as? String,
              mode == "hold" || mode == "toggle",
              let modifierNames = value["modifiers"] as? [String],
              !modifierNames.isEmpty,
              Set(modifierNames).count == modifierNames.count,
              value["keyCode"] is NSNumber || value["keyCode"] is NSNull,
              value["bareModifierKeyCodes"] is [NSNumber]
                || value["bareModifierKeyCodes"] is NSNull,
              let modifiers = parseModifiers(modifierNames)
        else { return nil }

        let keyNumber = value["keyCode"] as? NSNumber
        if let keyNumber, !isValidKeyCode(keyNumber) { return nil }
        let bareNumbers = value["bareModifierKeyCodes"] as? [NSNumber]
        if let bareNumbers, bareNumbers.contains(where: { !isValidKeyCode($0) }) { return nil }
        let keyCode = keyNumber.map { CGKeyCode($0.uint16Value) }
        let bareKeyCodes = bareNumbers.map { Set($0.map { CGKeyCode($0.uint16Value) }) }
        let hasKey = keyCode != nil
        let hasBareKeys = !(bareKeyCodes?.isEmpty ?? true)
        let hasBareFamilies = keyCode == nil && bareKeyCodes == nil && modifierNames.count >= 2
        guard (hasKey && !hasBareKeys) || (!hasKey && hasBareKeys) || hasBareFamilies else { return nil }

        let hotkey = Hotkey(
            id: bindingId,
            mode: mode,
            configurationGeneration: generation,
            modifiers: modifiers,
            keyCode: keyCode,
            bareModifierKeyCodes: bareKeyCodes,
            pressed: false
        )
        result[bindingId] = hotkey
    }
    return result
}

/** Replacing an unchanged registration updates its generation without synthesizing a fresh press. */
private func preservingHotkeyState(_ bindings: [String: Hotkey], previous: [String: Hotkey]) -> [String: Hotkey] {
    bindings.mapValues { binding in
        guard let old = previous[binding.id], old.mode == binding.mode,
              old.modifiers == binding.modifiers, old.keyCode == binding.keyCode,
              old.bareModifierKeyCodes == binding.bareModifierKeyCodes else { return binding }
        var next = binding
        next.pressed = old.pressed
        next.suppressed = old.suppressed
        return next
    }
}

private func hasHotkeyConflict(_ bindings: [String: Hotkey]) -> Bool {
    let values = Array(bindings.values)
    for index in values.indices {
        for candidateIndex in values.indices where candidateIndex > index {
            let value = values[index]
            let candidate = values[candidateIndex]
            if value.modifiers == candidate.modifiers
                && value.keyCode == candidate.keyCode
                && value.bareModifierKeyCodes == candidate.bareModifierKeyCodes {
                return true
            }
        }
    }
    return false
}

private func isValidKeyCode(_ value: NSNumber) -> Bool {
    let integer = value.intValue
    return integer >= 0 && integer <= 127 && value.doubleValue == Double(integer)
}

private func parseModifiers(_ values: [String]) -> CGEventFlags? {
    var modifiers: CGEventFlags = []
    for value in Set(values) {
        switch value {
        case "command": modifiers.insert(.maskCommand)
        case "control": modifiers.insert(.maskControl)
        case "function": modifiers.insert(.maskSecondaryFn)
        case "option": modifiers.insert(.maskAlternate)
        case "shift": modifiers.insert(.maskShift)
        default: return nil
        }
    }
    return modifiers
}

private let maximumMenuElements = 1000

private func axValue(_ element: AXUIElement, _ attribute: String, deadline: Date) -> CFTypeRef? {
    let remaining = deadline.timeIntervalSinceNow
    guard remaining > 0 else { return nil }
    AXUIElementSetMessagingTimeout(element, Float(min(0.2, remaining)))
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

private func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

/** Depth-first search prefers an explicit Paste command; an ambiguous Cmd-V fallback is rejected. */
private func findPasteCommand<Node>(root: Node, localizedTitle: String,
    attributes: (Node) -> (role: String?, enabled: Bool, identifier: String?, title: String?, character: String?, modifiers: Int?),
    children: (Node, Int) -> [Node]?, shouldContinue: () -> Bool
) -> Node? {
    var stack = [root]
    var visited = 0
    var shortcut: Node?
    var ambiguous = false
    while let node = stack.popLast() {
        visited += 1
        guard visited <= maximumMenuElements, shouldContinue() else { return nil }
        let value = attributes(node)
        if value.role == "AXMenuItem" {
            if !value.enabled { continue }
            if value.identifier?.range(of: "(?:^|[./_-])paste:?$", options: [.regularExpression, .caseInsensitive]) != nil { return node }
            if value.title == "Paste" || value.title == localizedTitle { return node }
            if value.character?.lowercased() == "v" && value.modifiers == 0 {
                if shortcut == nil { shortcut = node } else { ambiguous = true }
            }
        }
        let remaining = maximumMenuElements - visited - stack.count
        guard let descendants = children(node, remaining), descendants.count <= remaining else { return nil }
        stack.append(contentsOf: descendants.reversed())
    }
    return ambiguous ? nil : shortcut
}

private func pressFocusedPaste(_ cancellation: PasteCancellation) -> Bool {
    let deadline = Date().addingTimeInterval(2)
    let system = AXUIElementCreateSystemWide()
    guard let app = axElement(axValue(system, "AXFocusedApplication", deadline: deadline)),
          let menu = axElement(axValue(app, "AXMenuBar", deadline: deadline)) else { return false }
    let title = Bundle(identifier: "com.apple.AppKit")?.localizedString(forKey: "Paste", value: "Paste", table: "MenuCommands") ?? "Paste"
    let command = findPasteCommand(root: menu, localizedTitle: title, attributes: { element in
        func value(_ key: String) -> CFTypeRef? { axValue(element, key, deadline: deadline) }
        return (value("AXRole") as? String, (value("AXEnabled") as? NSNumber)?.boolValue ?? false,
                value("AXIdentifier") as? String, value("AXTitle") as? String,
                value("AXMenuItemCmdChar") as? String, (value("AXMenuItemCmdModifiers") as? NSNumber)?.intValue)
    }, children: { element, remaining in
        guard Date() < deadline else { return nil }
        var count: CFIndex = 0
        let status = AXUIElementGetAttributeValueCount(element, "AXChildren" as CFString, &count)
        if status == .attributeUnsupported || status == .noValue { return [] }
        guard status == .success, count >= 0, count <= remaining else { return nil }
        if count == 0 { return [] }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(element, "AXChildren" as CFString, 0, count, &values) == .success,
              let values = values as? [AXUIElement] else { return nil }
        return values
    }, shouldContinue: { !cancellation.cancelled && Date() < deadline })
    guard let command, !cancellation.cancelled, Date() < deadline else { return false }
    let result = AXUIElementPerformAction(command, "AXPress" as CFString)
    return result == .success || result.rawValue == -25204 || result.rawValue == -25205
}

private func dispatchFocusedPaste(_ cancellation: PasteCancellation, completion: @escaping (Bool) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
        let succeeded = !cancellation.cancelled &&
            (pressFocusedPaste(cancellation) || runPasteScript(cancellation))
        DispatchQueue.main.async { completion(succeeded) }
    }
}

private func runPasteScript(_ cancellation: PasteCancellation) -> Bool {
    guard !cancellation.cancelled, AXIsProcessTrusted() else { return false }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", "tell application \"System Events\" to keystroke \"v\" using command down"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return false }
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning && !cancellation.cancelled && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
    if process.isRunning {
        process.terminate()
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
        return false
    }
    return process.terminationStatus == 0
}

private func emitResponse(id: String, value: Any) {
    emit(["type": "response", "id": id, "ok": true, "value": value])
}

private func emitError(id: String?, code: String) {
    var payload: [String: Any] = ["type": "response", "ok": false, "error": code]
    if let id { payload["id"] = id }
    emit(payload)
}

private func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          data.count <= maximumMessageBytes
    else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}
