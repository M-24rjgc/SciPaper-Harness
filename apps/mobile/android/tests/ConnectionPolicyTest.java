package org.scipaper.mobile;

public final class ConnectionPolicyTest {
    public static void main(String[] args) {
        require("https://research.example:8443/?pair=private-value#section", "https://research.example:8443");
        require("https://research.example:443/", "https://research.example");
        require("https://192.168.1.2/pair", "https://192.168.1.2");
        require("https://[2001:db8::2]/pair", "https://[2001:db8::2]");
        for (String rejected : new String[] {
                "http://research.example/", "javascript:alert(1)", "file:///storage/data",
                "https://user:password@research.example/", "https://localhost/", "https://test.localhost/",
                "https://127.0.0.1/", "https://127.1/", "https://0177.0.0.1/", "https://2130706433/", "https://0x7f000001/",
                "https://[::1]/", "https://[0:0:0:0:0:0:0:1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/",
                "https://0.0.0.0/", "https://research.example:0/", "https://research.example:65536/",
                "https://research.example/\n", "https://research.example\\@evil.example/",
                "https://research.example/path with spaces", "https://research.example/%"
        }) {
            try {
                ConnectionPolicy.requireRemoteHttps(rejected);
                throw new AssertionError("Unsafe address admitted: " + rejected);
            } catch (IllegalArgumentException expected) {
                // The expected failure is the policy result, not a network request.
            }
        }
        check(ConnectionPolicy.sameOrigin("https://research.example", "https://research.example:443/api/file"));
        check(!ConnectionPolicy.sameOrigin("https://research.example", "https://research.example:8443/api/file"));
        check(!ConnectionPolicy.sameOrigin("https://research.example", "https://evil.example/api/file"));
        check(!ConnectionPolicy.sameOrigin("https://research.example", "file:///secret"));
        check(!ConnectionPolicy.sameOrigin(null, "https://research.example/"));
        check(ConnectionPolicy.ownedBlob("https://research.example", "blob:https://research.example/preview-id"));
        check(!ConnectionPolicy.ownedBlob("https://research.example", "blob:https://evil.example/preview-id"));
        check(!ConnectionPolicy.ownedBlob("https://research.example", "blob:null/preview-id"));
        System.out.println("Connection policy passed: HTTPS origins, token removal and navigation isolation.");
    }
    private static void require(String value, String expected) {
        check(ConnectionPolicy.origin(ConnectionPolicy.requireRemoteHttps(value)).equals(expected));
    }
    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Connection policy check failed");
    }
}
