import Foundation
import Network

enum ConnectionPolicy {
    static func remoteHTTPS(_ value: String) -> URL? {
        guard value.count <= 8192,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              !value.contains("\\"),
              let parts = URLComponents(string: value),
              parts.scheme?.lowercased() == "https",
              parts.user == nil, parts.password == nil,
              let rawHost = parts.host, !rawHost.isEmpty,
              parts.port == nil || (1...65535).contains(parts.port!),
              let url = parts.url else { return nil }
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        guard host != "localhost", !host.hasSuffix(".localhost"),
              host != "::1", host != "::", host != "0:0:0:0:0:0:0:1",
              host != "0.0.0.0", !host.hasPrefix("127."), !host.hasPrefix("::ffff:127."),
              !host.hasPrefix("::ffff:7f"), !host.contains("%"), !isLoopbackLiteral(host),
              host.range(of: "^[0-9]+$|^0x[0-9a-f]+$|(^|\\.)0[0-9]+(\\.|$)", options: .regularExpression) == nil
        else { return nil }
        if host.range(of: "^[0-9.]+$", options: .regularExpression) != nil {
            guard host.split(separator: ".").count == 4 else { return nil }
        }
        return url
    }

    private static func isLoopbackLiteral(_ host: String) -> Bool {
        guard host.contains(":") else { return false }
        guard let address = IPv6Address(host) else { return true }
        let bytes = Array(address.rawValue)
        let zeros = bytes.prefix(15).allSatisfy { $0 == 0 }
        let mapped = bytes.prefix(10).allSatisfy { $0 == 0 } && bytes[10] == 255 && bytes[11] == 255
        return (zeros && (bytes[15] == 0 || bytes[15] == 1))
            || (mapped && (bytes[12] == 127 || bytes.suffix(4).allSatisfy { $0 == 0 }))
    }

    static func origin(_ url: URL) -> String? {
        guard let url = remoteHTTPS(url.absoluteString), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = parts.host else { return nil }
        let authority = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return "https://\(authority.lowercased())" + (parts.port == nil || parts.port == 443 ? "" : ":\(parts.port!)")
    }

    static func sameOrigin(_ url: URL, _ origin: String) -> Bool {
        Self.origin(url) == origin
    }

    static func ownedBlob(_ url: URL, _ origin: String) -> Bool {
        guard url.absoluteString.hasPrefix("blob:"), let embedded = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return sameOrigin(embedded, origin)
    }

    static func cleanAppPage(_ url: URL, _ origin: String) -> Bool {
        guard sameOrigin(url, origin), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return (parts.path.isEmpty || parts.path == "/") && parts.query == nil && parts.fragment == nil
    }
}
