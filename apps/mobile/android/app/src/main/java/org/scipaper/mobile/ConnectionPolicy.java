package org.scipaper.mobile;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Locale;

/** Validates addresses received from clipboard, share intents and web navigation. */
public final class ConnectionPolicy {
    private ConnectionPolicy() {}

    public static URI requireRemoteHttps(String text) {
        if (text == null || text.length() > 8192 || !text.equals(text.trim())
                || text.chars().anyMatch(c -> c <= 32 || c == 127) || text.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("format");
        }
        final URI uri;
        try {
            uri = new URI(text);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("format");
        }
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null
                || uri.getRawUserInfo() != null || uri.getPort() == 0 || uri.getPort() > 65535) {
            throw new IllegalArgumentException("https");
        }
        String normalized = host.toLowerCase(Locale.ROOT);
        if (normalized.startsWith("[") && normalized.endsWith("]")) {
            normalized = normalized.substring(1, normalized.length() - 1);
        }
        normalized = normalized.replaceFirst("\\.$", "");
        if (normalized.equals("localhost") || normalized.endsWith(".localhost")
                || normalized.equals("::1") || normalized.equals("::")
                || normalized.equals("0:0:0:0:0:0:0:1")
                || normalized.startsWith("::ffff:127.") || normalized.startsWith("127.")
                || normalized.equals("0.0.0.0") || normalized.matches("[0-9]+")
                || normalized.matches("(?i)0x[0-9a-f]+")
                || (normalized.matches("[0-9.]+") && (normalized.split("\\.").length != 4
                    || normalized.matches(".*(?:^|\\.)0[0-9]+(?:\\.|$).*")))
                || isLoopbackLiteral(normalized)) {
            throw new IllegalArgumentException("loopback");
        }
        return uri;
    }

    private static boolean isLoopbackLiteral(String host) {
        if (!host.contains(":")) return false;
        if (host.contains("%")) return true;
        try {
            InetAddress address = InetAddress.getByName(host);
            return address.isLoopbackAddress() || address.isAnyLocalAddress();
        } catch (UnknownHostException error) {
            return true;
        }
    }

    /** The only address persisted by the native shell. Paths, query and fragments are omitted. */
    public static String origin(URI uri) {
        int port = uri.getPort();
        return "https://" + uri.getHost().toLowerCase(Locale.ROOT)
                + (port == -1 || port == 443 ? "" : ":" + port);
    }

    public static boolean sameOrigin(String origin, String target) {
        try {
            return origin != null && origin.equals(origin(requireRemoteHttps(target)));
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    public static boolean ownedBlob(String origin, String target) {
        return target != null && target.startsWith("blob:") && sameOrigin(origin, target.substring(5));
    }
}
