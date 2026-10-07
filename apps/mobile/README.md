# SciPaper Mobile

English | [中文](README.zh.md)

## Summary

SciPaper Mobile opens the same research projects, conversations and files as the desktop application. The computer runs the research tasks; the phone provides a connected interface. Android uses the system WebView and iOS uses WKWebView. Both load the SciPaper web client from the paired computer.

## Table of Contents

- [Connection](#mobile-connection)
- [Device features](#mobile-device-features)
- [Android build](#mobile-android-build)
- [iOS project](#mobile-ios-project)
- [Limitations](#mobile-limitations)

<a id="mobile-connection"></a>

## Connection

Create a connection link in the desktop mobile-access settings and paste it into the app. Android also accepts a text link shared from another app. Both platforms accept `scipaper://connect?url=<URL-encoded HTTPS link>`.

The shell saves only the HTTPS service origin for recent connections. Pairing links stay out of native preferences and application logs. Before the first pairing redirect, Retry retains the initial link in memory; after navigation reaches the clean service root, retries use that root. Disconnecting clears the pending link. Authentication uses the web client's cookies. Removing the Android recent connection also removes WebView cookies.

Connections require HTTPS with a valid certificate. HTTP, embedded usernames or passwords, loopback addresses and local-file navigation are rejected. Keep the computer awake, the Host running and both devices online.

<a id="mobile-device-features"></a>

## Device features

The Android file input uses the system document picker, including multiple selection. Same-origin HTTPS downloads are saved under Downloads / SciPaper. Download redirects cannot send authentication cookies to another origin. External HTTPS links open in the system browser. Android Back returns through web history, then to the connection screen; iOS provides web back gestures and a Computers button.

Both shells use normal system TLS verification. Connection, authorization and certificate failures have a retry or reconnection path. The native connection interface has English and Simplified Chinese strings. Research interface features belong to the shared web client.

<a id="mobile-android-build"></a>

## Android build

[The standalone build script](tools/build-android.ps1) takes `JdkHome` pointing to a JDK 17 installation. It uses pinned, SHA-256-checked AAPT2, D8, apksig and zipflinger dependencies plus the AOSP API jar published by Robolectric. Compilation and policy tests run in a temporary directory. The resulting APK is signature-verified and copied to `build/SciPaper-Android-0.3.0.apk`.

The default build creates or reuses a local preview signing key in the tools directory. To sign with an existing key, supply `SigningStore` and set `SCIPAPER_SIGNING_PASSWORD` for that process. Never commit signing keys. [The Android Gradle project](android/app/build.gradle) provides the conventional build configuration for an Android SDK environment.

Android requires version 10 or later and an up-to-date Android System WebView with `Promise.withResolvers` and `AbortSignal.any` support. The OS version alone does not establish WebView compatibility. The application requests only Internet permission; file selection and downloads use the system document and media APIs.

<a id="mobile-ios-project"></a>

## iOS project

[Open the Xcode project](ios/SciPaperMobile.xcodeproj/project.pbxproj) on macOS with Xcode 15.3 or later. It contains the SwiftUI connection screen, WKWebView container and shared scheme; no XcodeGen step is required. iOS requires version 17.4 or later for the shared client's `Promise.withResolvers` and `AbortSignal.any` APIs. Simulator builds can use signing disabled; device installation requires an Apple signing team.

The iOS maintainer owns Xcode compilation, simulator checks and device signing. Windows cannot compile or sign this target.

<a id="mobile-limitations"></a>

## Limitations

The APK uses a preview signing identity, not a production release identity. A build and signature check do not replace installation and connection checks on an Android device. iOS source requires validation in Xcode before distribution.

The phone cannot reach a computer that is asleep, shut down or disconnected. Lockscreen notifications and push delivery are not implemented by the native shells. Direct downloads of generated blob previews are not supported; download the original file from the shared file list instead.
