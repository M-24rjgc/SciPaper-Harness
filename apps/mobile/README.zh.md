# SciPaper Mobile

[English](README.md) | 中文

## 概述

SciPaper Mobile 打开与桌面应用相同的研究项目、会话和文件。电脑执行科研任务，手机提供连接后的操作界面。Android 使用系统 WebView，iOS 使用 WKWebView，两者均从已配对电脑加载 SciPaper 网页客户端。

## 目录

- [连接](#mobile-connection)
- [设备功能](#mobile-device-features)
- [Android 构建](#mobile-android-build)
- [iOS 项目](#mobile-ios-project)
- [限制](#mobile-limitations)

<a id="mobile-connection"></a>

## 连接

在桌面的手机连接设置中生成链接，并粘贴到 App。Android 也接受其他应用分享的文本链接。两个平台均接受 `scipaper://connect?url=<URL 编码的 HTTPS 链接>`。

原生壳只保存 HTTPS 服务 origin 作为最近连接。配对链接不会写入原生偏好设置或应用日志。身份验证使用网页客户端的 Cookie。移除 Android 最近连接也会移除 WebView Cookie。

连接要求 HTTPS 和有效证书。HTTP、内嵌用户名或密码、回环地址和本地文件导航会被拒绝。电脑需要保持唤醒，Host 持续运行，两个设备均联网。

<a id="mobile-device-features"></a>

## 设备功能

Android 文件输入使用系统文档选择器，支持多选。同源 HTTPS 下载保存在下载 / SciPaper。下载重定向不能把身份验证 Cookie 发往其他 origin。外部 HTTPS 链接在系统浏览器打开。Android 返回操作先回退网页历史，再返回连接页面；iOS 提供网页返回手势与电脑按钮。

两个原生壳均使用系统正常 TLS 验证。连接、授权和证书失败均提供重试或重新连接的入口。原生连接界面具有英文和简体中文文案。科研界面的功能归共享网页客户端所有。

<a id="mobile-android-build"></a>

## Android 构建

[独立构建脚本](tools/build-android.ps1)通过 `JdkHome` 接收 JDK 17 安装路径。它使用固定版本并验证 SHA-256 的 AAPT2、D8、apksig 和 zipflinger 依赖，以及 Robolectric 发布的 AOSP API jar。编译和策略测试在临时目录运行。生成的 APK 经过签名验证后，复制到 `build/SciPaper-Android-0.1.0-preview.1.apk`。

默认构建在工具目录创建或复用本地预览签名密钥。使用已有密钥时，传入 `SigningStore`，并为当前进程设置 `SCIPAPER_SIGNING_PASSWORD`。不得提交签名密钥。[Android Gradle 项目](android/app/build.gradle)提供用于 Android SDK 环境的常规构建配置。

Android 要求版本 10 或更新版本。应用只申请联网权限；文件选择和下载使用系统文档与媒体接口。

<a id="mobile-ios-project"></a>

## iOS 项目

在安装 Xcode 15 或更新版本的 macOS 上[打开 Xcode 项目](ios/SciPaperMobile.xcodeproj/project.pbxproj)。项目包含 SwiftUI 连接页面、WKWebView 容器和共享 scheme，无需 XcodeGen 步骤。iOS 要求版本 16.4 或更新版本。模拟器构建可以关闭签名；真机安装需要 Apple 签名团队。

iOS 维护者负责 Xcode 编译、模拟器检查和真机签名。Windows 无法编译或签名该目标。

<a id="mobile-limitations"></a>

## 限制

APK 使用预览签名身份，尚非生产发布签名。构建和签名检查不能替代 Android 真机安装与连接检查。iOS 源码在分发前需要在 Xcode 中验证。

手机无法访问休眠、关机或断网的电脑。原生壳未实现锁屏通知和推送送达。生成的 blob 预览暂不支持直接下载，可从共享文件列表下载原文件。
