import ApplicationServices
import AppKit
import CoreAudio
import CoreGraphics
import Foundation

private let protocolVersion = 3
private let maximumMessageBytes = 64 * 1024
private let maximumPasteboardFormatBytes = 8 * 1024 * 1024
private let maximumPasteboardSnapshotBytes = 32 * 1024 * 1024
private let relevantFlags: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn]

private struct Hotkey {
    let id: String
    let mode: String
    let configurationGeneration: UInt64
    let modifiers: CGEventFlags
    let keyCode: CGKeyCode?
    let bareModifierKeyCodes: Set<CGKeyCode>?
    var pressed: Bool
}

private final class HelperState {
    static let shared = HelperState()
    var hotkeys: [String: Hotkey] = [:]
    var eventTap: CFMachPort?
    var runLoopSource: CFRunLoopSource?
    var generation: UInt64 = 0
    var captureRequestId: String?
    var captureTimer: Timer?
}

private let outputLock = NSLock()

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

private func readCommands() {
    while let line = readLine(strippingNewline: true) {
        guard line.utf8.count <= maximumMessageBytes,
              let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            emitError(id: nil, code: "invalid-message")
            continue
        }
        DispatchQueue.main.async {
            handle(request)
        }
    }
    DispatchQueue.main.async {
        uninstallEventTap()
        exit(EXIT_SUCCESS)
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
        HelperState.shared.hotkeys = bindings
        if bindings.isEmpty && HelperState.shared.captureRequestId == nil { uninstallEventTap() }
        emitResponse(id: id, value: [
            "applied": true,
            "generation": generationValue,
        ])
    case "captureFn":
        guard installEventTapIfNeeded() else {
            emitError(id: id, code: "input-monitoring-denied")
            return
        }
        if let previousId = HelperState.shared.captureRequestId {
            emitError(id: previousId, code: "capture-replaced")
        }
        HelperState.shared.captureRequestId = id
        HelperState.shared.captureTimer?.invalidate()
        HelperState.shared.captureTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { _ in
            guard HelperState.shared.captureRequestId == id else { return }
            HelperState.shared.captureRequestId = nil
            HelperState.shared.captureTimer = nil
            emitError(id: id, code: "capture-timeout")
            if HelperState.shared.hotkeys.isEmpty { uninstallEventTap() }
        }
    case "safePaste":
        guard let target = request["target"] as? [String: Any],
              let pidValue = target["pid"] as? NSNumber,
              let bundleIdentifier = target["bundleIdentifier"] as? String,
              let text = request["text"] as? String,
              !text.isEmpty,
              text.utf8.count <= maximumMessageBytes / 2
        else {
            emitError(id: id, code: "invalid-target")
            return
        }
        let pid = pid_t(pidValue.int32Value)
        guard foregroundMatches(pid: pid, bundleIdentifier: bundleIdentifier) else {
            emitError(id: id, code: "target-changed")
            return
        }
        guard AXIsProcessTrusted() else {
            emitError(id: id, code: "accessibility-denied")
            return
        }
        guard let snapshot = snapshotPasteboard() else {
            emitError(id: id, code: "paste-failed")
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            restorePasteboard(snapshot)
            emitError(id: id, code: "paste-failed")
            return
        }
        let dictationChangeCount = pasteboard.changeCount
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            guard foregroundMatches(pid: pid, bundleIdentifier: bundleIdentifier),
                  AXIsProcessTrusted(),
                  postPasteShortcut(pid: pid)
            else {
                restorePasteboardIfUnchanged(
                    snapshot,
                    insertedText: text,
                    expectedChangeCount: dictationChangeCount
                )
                emitError(id: id, code: "paste-failed")
                return
            }
            let pasteDispatchedAt = DispatchTime.now().uptimeNanoseconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                restorePasteboardIfUnchanged(
                    snapshot,
                    insertedText: text,
                    expectedChangeCount: dictationChangeCount
                )
                emitResponse(id: id, value: [
                    "pasted": true,
                    "clipboardRestoreMs": Double(DispatchTime.now().uptimeNanoseconds - pasteDispatchedAt) / 1_000_000,
                ])
            }
        }
    case "queryBuiltInMic":
        emitResponse(id: id, value: preferredBuiltInMicrophoneName() ?? NSNull())
    default:
        emitError(id: id, code: "unsupported-request")
    }
}

private func snapshotPasteboard() -> [NSPasteboardItem]? {
    let pasteboard = NSPasteboard.general
    var totalBytes = 0
    var snapshot: [NSPasteboardItem] = []
    for sourceItem in pasteboard.pasteboardItems ?? [] {
        let item = NSPasteboardItem()
        for type in sourceItem.types {
            guard let data = sourceItem.data(forType: type),
                  data.count <= maximumPasteboardFormatBytes
            else { return nil }
            totalBytes += data.count
            guard totalBytes <= maximumPasteboardSnapshotBytes else { return nil }
            guard item.setData(data, forType: type) else { return nil }
        }
        snapshot.append(item)
    }
    return snapshot
}

private func restorePasteboard(_ snapshot: [NSPasteboardItem]) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    _ = pasteboard.writeObjects(snapshot)
}

private func restorePasteboardIfUnchanged(
    _ snapshot: [NSPasteboardItem],
    insertedText: String,
    expectedChangeCount: Int
) {
    let pasteboard = NSPasteboard.general
    guard pasteboard.changeCount == expectedChangeCount,
          pasteboard.string(forType: .string) == insertedText
    else { return }
    restorePasteboard(snapshot)
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
    HelperState.shared.eventTap = tap
    HelperState.shared.runLoopSource = source
    return true
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
       type == .flagsChanged,
       keyCode == 63,
       flags.contains(.maskSecondaryFn) {
        HelperState.shared.captureRequestId = nil
        HelperState.shared.captureTimer?.invalidate()
        HelperState.shared.captureTimer = nil
        emitResponse(id: captureId, value: ["accelerator": "Fn"])
        if HelperState.shared.hotkeys.isEmpty { uninstallEventTap() }
        return
    }

    for (id, var hotkey) in HelperState.shared.hotkeys {
        if let bareModifierKeyCodes = hotkey.bareModifierKeyCodes {
            guard type == .flagsChanged, bareModifierKeyCodes.contains(keyCode) else { continue }
            let allKeysDown = bareModifierKeyCodes.count == 1
                ? flags.contains(hotkey.modifiers)
                : bareModifierKeyCodes.allSatisfy {
                    CGEventSource.keyState(.combinedSessionState, key: $0)
                }
            let isPressed = allKeysDown
            let isReleased = hotkey.pressed && !allKeysDown
            if isPressed && !hotkey.pressed {
                hotkey.pressed = true
                HelperState.shared.hotkeys[id] = hotkey
                emitHotkeyEvent(hotkey: hotkey, type: "pressed")
            } else if isReleased {
                hotkey.pressed = false
                HelperState.shared.hotkeys[id] = hotkey
                emitHotkeyEvent(hotkey: hotkey, type: "released")
            }
            continue
        }

        let modifiersMatch = flags == hotkey.modifiers
        let keyMatches = hotkey.keyCode == keyCode
        let isPressed = modifiersMatch && keyMatches && type == .keyDown
        let isReleased = hotkey.pressed && keyMatches && type == .keyUp
        if isPressed && !hotkey.pressed {
            hotkey.pressed = true
            HelperState.shared.hotkeys[id] = hotkey
            emitHotkeyEvent(hotkey: hotkey, type: "pressed")
        } else if isReleased {
            hotkey.pressed = false
            HelperState.shared.hotkeys[id] = hotkey
            emitHotkeyEvent(hotkey: hotkey, type: "released")
        }
    }
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
        guard hasKey != hasBareKeys else { return nil }

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

private func foregroundMatches(pid: pid_t, bundleIdentifier: String) -> Bool {
    guard let app = NSWorkspace.shared.frontmostApplication else { return false }
    let actualBundle = app.bundleIdentifier ?? "pid.\(app.processIdentifier)"
    return app.processIdentifier == pid && actualBundle == bundleIdentifier
}

private func postPasteShortcut(pid: pid_t) -> Bool {
    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
    else { return false }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.postToPid(pid)
    up.postToPid(pid)
    return true
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
