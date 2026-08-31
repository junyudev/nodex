import Darwin
import Foundation
import ServiceManagement

private let protocolVersion = 1
private let agentPlistName = "app.jyu.nodex.background-service.core.plist"
private let maximumConfigurationBytes: UInt64 = 64 * 1024

private struct ServiceConfiguration: Codable {
    let version: Int
    let home: String
}

private struct AdapterResponse: Encodable {
    let version = protocolVersion
    let adapter = "sm_app_service"
    let supported: Bool
    let status: String
    let configuredHome: String?
    let message: String?

    private enum CodingKeys: String, CodingKey {
        case version
        case adapter
        case supported
        case status
        case configuredHome = "configured_home"
        case message
    }
}

private enum AdapterCommand: String {
    case status
    case enable
    case disable
}

private enum AdapterFailure: LocalizedError {
    case invalidArguments
    case invalidHome
    case unsafeConfiguration(String)
    case invalidConfiguration(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "usage: nodex-service status|enable|disable --home <absolute-profile-home>"
        case .invalidHome:
            return "the selected Profile home must be absolute"
        case let .unsafeConfiguration(path):
            return "the background Core configuration is not a regular private file: \(path)"
        case let .invalidConfiguration(reason):
            return "the background Core configuration is invalid: \(reason)"
        }
    }
}

@main
private enum NodexService {
    static func main() {
        if CommandLine.arguments.count == 1 || CommandLine.arguments.dropFirst().first == "launch" {
            launchConfiguredCore()
            return
        }

        do {
            let (command, selectedHome) = try parseControlArguments()
            emit(control(command: command, selectedHome: selectedHome))
        } catch {
            emit(AdapterResponse(
                supported: false,
                status: "unavailable",
                configuredHome: nil,
                message: describe(error)
            ))
        }
    }
}

private func parseControlArguments() throws -> (AdapterCommand, URL) {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 3,
          let command = AdapterCommand(rawValue: arguments[0]),
          arguments[1] == "--home"
    else {
        throw AdapterFailure.invalidArguments
    }
    guard arguments[2].hasPrefix("/") else {
        throw AdapterFailure.invalidHome
    }
    let home = URL(fileURLWithPath: arguments[2]).standardizedFileURL
    return (command, home)
}

private func control(command: AdapterCommand, selectedHome: URL) -> AdapterResponse {
    let service = SMAppService.agent(plistName: agentPlistName)
    do {
        switch command {
        case .status:
            break
        case .enable:
            let existingHome = try readConfigurationIfPresent()?.home
            let selectedPath = selectedHome.path
            if existingHome != nil,
               existingHome != selectedPath,
               service.status != .notRegistered,
               service.status != .notFound
            {
                try service.unregister()
            }
            try writeConfiguration(home: selectedHome)
            if service.status == .notRegistered || service.status == .notFound {
                try service.register()
            }
        case .disable:
            if service.status != .notRegistered && service.status != .notFound {
                try service.unregister()
            }
            try removeConfigurationIfPresent()
        }
        return response(for: service, selectedHome: selectedHome, message: nil)
    } catch {
        let current = response(for: service, selectedHome: selectedHome, message: describe(error))
        if current.status == "requires_approval" {
            return current
        }
        return AdapterResponse(
            supported: true,
            status: "unavailable",
            configuredHome: configuredHomeIfReadable(),
            message: describe(error)
        )
    }
}

private func response(
    for service: SMAppService,
    selectedHome: URL,
    message: String?
) -> AdapterResponse {
    let configuredHome: String?
    do {
        configuredHome = try readConfigurationIfPresent()?.home
    } catch {
        return AdapterResponse(
            supported: true,
            status: "unavailable",
            configuredHome: nil,
            message: describe(error)
        )
    }
    let matchesSelectedProfile = configuredHome == selectedHome.path
    switch service.status {
    case .enabled:
        return AdapterResponse(
            supported: true,
            status: matchesSelectedProfile ? "enabled" : "enabled_other_profile",
            configuredHome: configuredHome,
            message: message
        )
    case .requiresApproval:
        return AdapterResponse(
            supported: true,
            status: "requires_approval",
            configuredHome: configuredHome,
            message: message ?? "allow Nodex in System Settings > General > Login Items"
        )
    case .notRegistered:
        return AdapterResponse(
            supported: true,
            status: "disabled",
            configuredHome: configuredHome,
            message: message
        )
    case .notFound:
        return AdapterResponse(
            supported: false,
            status: "unavailable",
            configuredHome: configuredHome,
            message: message ?? "the packaged LaunchAgent definition was not found"
        )
    @unknown default:
        return AdapterResponse(
            supported: false,
            status: "unavailable",
            configuredHome: configuredHome,
            message: message ?? "ServiceManagement returned an unknown status"
        )
    }
}

private func configurationURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Application Support", isDirectory: true)
        .appendingPathComponent("Nodex", isDirectory: true)
        .appendingPathComponent("background-core.json", isDirectory: false)
}

private func readConfigurationIfPresent() throws -> ServiceConfiguration? {
    let url = configurationURL()
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: url.path) else {
        return nil
    }
    let values = try url.resourceValues(forKeys: [
        .isRegularFileKey,
        .isSymbolicLinkKey,
        .fileSizeKey,
    ])
    guard values.isRegularFile == true,
          values.isSymbolicLink != true,
          UInt64(values.fileSize ?? 0) <= maximumConfigurationBytes
    else {
        throw AdapterFailure.unsafeConfiguration(url.path)
    }
    try validatePrivateConfigurationFile(url)
    let configuration = try JSONDecoder().decode(
        ServiceConfiguration.self,
        from: Data(contentsOf: url, options: [.mappedIfSafe])
    )
    guard configuration.version == protocolVersion,
          configuration.home.hasPrefix("/")
    else {
        throw AdapterFailure.invalidConfiguration("unsupported version or relative home")
    }
    return configuration
}

private func writeConfiguration(home: URL) throws {
    let url = configurationURL()
    let directory = url.deletingLastPathComponent()
    let fileManager = FileManager.default
    if fileManager.fileExists(atPath: directory.path) {
        let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw AdapterFailure.unsafeConfiguration(directory.path)
        }
    } else {
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    if fileManager.fileExists(atPath: url.path) {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw AdapterFailure.unsafeConfiguration(url.path)
        }
        try validatePrivateConfigurationFile(url)
    }
    let data = try JSONEncoder().encode(ServiceConfiguration(
        version: protocolVersion,
        home: home.path
    ))
    try data.write(to: url, options: [.atomic])
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

private func removeConfigurationIfPresent() throws {
    let url = configurationURL()
    guard FileManager.default.fileExists(atPath: url.path) else {
        return
    }
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
        throw AdapterFailure.unsafeConfiguration(url.path)
    }
    try validatePrivateConfigurationFile(url)
    try FileManager.default.removeItem(at: url)
}

private func validatePrivateConfigurationFile(_ url: URL) throws {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    let permissions = (attributes[.posixPermissions] as? NSNumber)?.uint16Value
    let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value
    guard permissions == 0o600, owner == getuid() else {
        throw AdapterFailure.unsafeConfiguration(url.path)
    }
}

private func configuredHomeIfReadable() -> String? {
    try? readConfigurationIfPresent()?.home
}

private func launchConfiguredCore() {
    do {
        guard let configuration = try readConfigurationIfPresent() else {
            return
        }
        guard let outerApplication = enclosingApplicationBundles().dropFirst().first else {
            return
        }
        let executable = outerApplication
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Resources", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
            .appendingPathComponent("nodex-core", isDirectory: false)
        let executableValues = try executable.resourceValues(forKeys: [
            .isRegularFileKey,
            .isSymbolicLinkKey,
            .isExecutableKey,
        ])
        guard executableValues.isRegularFile == true,
              executableValues.isSymbolicLink != true,
              executableValues.isExecutable == true
        else {
            return
        }
        replaceCurrentProcess(
            executable: executable.path,
            arguments: [executable.path, "--home", configuration.home]
        )
    } catch {
        FileHandle.standardError.write(Data("nodex-service: \(describe(error))\n".utf8))
    }
}

private func enclosingApplicationBundles() -> [URL] {
    var bundles: [URL] = []
    var candidate = Bundle.main.bundleURL.standardizedFileURL
    while candidate.path != "/" {
        if candidate.pathExtension == "app" {
            bundles.append(candidate)
        }
        candidate.deleteLastPathComponent()
    }
    return bundles
}

private func replaceCurrentProcess(executable: String, arguments: [String]) {
    var duplicated = arguments.map { strdup($0) }
    duplicated.append(nil)
    defer {
        for pointer in duplicated where pointer != nil {
            free(pointer)
        }
    }
    duplicated.withUnsafeMutableBufferPointer { buffer in
        _ = execv(executable, buffer.baseAddress)
    }
}

private func emit(_ response: AdapterResponse) {
    do {
        let data = try JSONEncoder().encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        FileHandle.standardOutput.write(Data(
            "{\"version\":1,\"adapter\":\"sm_app_service\",\"supported\":false,\"status\":\"unavailable\",\"configured_home\":null,\"message\":\"response encoding failed\"}\n".utf8
        ))
    }
}

private func describe(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? String(describing: error)
}
