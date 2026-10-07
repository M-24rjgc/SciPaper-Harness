package org.scipaper.mobile;

import java.net.URI;

/** In-memory retry address for one connection; clean navigation retires the initial credential. */
public final class ConnectionNavigation {
    private final String origin;
    private String retryUrl;

    public ConnectionNavigation(URI initial) {
        origin = ConnectionPolicy.origin(initial);
        retryUrl = initial.toString();
    }

    public String origin() { return origin; }
    public String retryUrl() { return retryUrl; }

    /** A clean root navigation follows the pairing redirect, even if that page later fails to load. */
    public void observedNavigation(String url) {
        if (retryUrl != null && ConnectionPolicy.cleanAppPage(origin, url)) retryUrl = origin + "/";
    }

    public void close() { retryUrl = null; }
}
