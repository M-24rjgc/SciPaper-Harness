package org.scipaper.mobile;

import android.app.Activity;
import android.content.ContentValues;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URI;
import java.net.URL;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.util.ArrayList;
import javax.net.ssl.HttpsURLConnection;

/** Native device features around the same SciPaper web client used on the computer. */
public final class MainActivity extends Activity {
    private static final int PICK_FILES = 42;
    private int paper;
    private int ink;
    private int muted;
    private int teal;
    private int inputFill;
    private int inputBorder;
    private int warningFill;
    private int errorInk;
    private int primaryFill;
    private int primaryInk;
    private LinearLayout root;
    private LinearLayout connectionBanner;
    private WebView browser;
    private EditText address;
    private TextView validation;
    private String connectedOrigin;
    private boolean pairingHistoryPending;
    private boolean tlsBlocked;
    private ValueCallback<Uri[]> fileSelection;
    private final ArrayList<WebView> popups = new ArrayList<>();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        paper = Color.parseColor(dark ? "#1c211f" : "#faf9f6");
        ink = Color.parseColor(dark ? "#f9fafb" : "#1c1c19");
        muted = Color.parseColor(dark ? "#b6bab2" : "#68675f");
        teal = Color.parseColor(dark ? "#7bc4bb" : "#15635f");
        inputFill = Color.parseColor(dark ? "#2c322e" : "#ffffff");
        inputBorder = Color.parseColor(dark ? "#414941" : "#e0e2dc");
        warningFill = Color.parseColor(dark ? "#49352c" : "#f6edda");
        errorInk = Color.parseColor(dark ? "#e99a72" : "#b13c2b");
        primaryFill = Color.parseColor(dark ? "#3f8f86" : "#15635f");
        primaryInk = Color.parseColor(dark ? "#071b17" : "#ffffff");
        getWindow().setStatusBarColor(paper);
        getWindow().setNavigationBarColor(paper);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        }
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(paper);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                android.view.WindowInsetsController controller = view.getWindowInsetsController();
                if (controller != null) {
                    controller.setSystemBarsAppearance(dark ? 0
                            : android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                            android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
                }
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(root);
        if (Build.VERSION.SDK_INT < 30) {
            getWindow().getDecorView().setSystemUiVisibility(dark ? 0
                    : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        }
        showConnect();
        handleConnectionIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleConnectionIntent(intent);
    }

    private void handleConnectionIntent(Intent intent) {
        String link = null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            link = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            Uri uri = intent.getData();
            if ("scipaper".equals(uri.getScheme()) && "connect".equals(uri.getHost())) {
                link = uri.getQueryParameter("url");
            }
        }
        // Intent state is never a store for a pairing credential.
        intent.setData(null);
        intent.removeExtra(Intent.EXTRA_TEXT);
        if (link != null) connect(link.trim());
    }

    private void showConnect() {
        closeBrowser();
        connectedOrigin = null;
        root.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(28), dp(44), dp(28), dp(28));
        scroll.addView(page, new ScrollView.LayoutParams(-1, -2));
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.ic_scipaper);
        logo.setContentDescription("SciPaper");
        page.addView(logo, new LinearLayout.LayoutParams(dp(72), dp(72)));
        TextView title = text("SciPaper", 30, ink);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        page.addView(title);
        TextView subtitle = text(getString(R.string.tagline), 18, muted);
        subtitle.setPadding(0, dp(10), 0, dp(34));
        page.addView(subtitle);
        TextView label = text(getString(R.string.connect_computer), 20, ink);
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        page.addView(label);
        TextView hint = text(getString(R.string.connect_hint), 15, muted);
        hint.setPadding(0, dp(12), 0, dp(20));
        page.addView(hint);
        address = new EditText(this);
        address.setHint(R.string.link_hint);
        address.setTextSize(16);
        address.setTextColor(ink);
        address.setHintTextColor(muted);
        address.setSingleLine(false);
        address.setMaxLines(4);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI
                | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        address.setSaveEnabled(false);
        address.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        address.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        address.setPadding(dp(16), dp(12), dp(16), dp(12));
        address.setBackground(card(inputFill, inputBorder));
        page.addView(address, new LinearLayout.LayoutParams(-1, -2));
        validation = text("", 14, errorInk);
        validation.setPadding(0, dp(8), 0, dp(8));
        validation.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        page.addView(validation);
        Button connect = button(getString(R.string.connect), true);
        connect.setOnClickListener(view -> connect(address.getText().toString().trim()));
        page.addView(connect, new LinearLayout.LayoutParams(-1, dp(52)));
        String recent = getPreferences(MODE_PRIVATE).getString("recentOrigin", null);
        if (recent != null) {
            TextView recentLabel = text(getString(R.string.recent_connection), 14, muted);
            recentLabel.setPadding(0, dp(28), 0, dp(10));
            page.addView(recentLabel);
            Button recentButton = button(recent, false);
            recentButton.setAllCaps(false);
            recentButton.setOnClickListener(view -> connect(recent + "/"));
            page.addView(recentButton, new LinearLayout.LayoutParams(-1, dp(52)));
            Button forget = button(getString(R.string.remove_recent), false);
            forget.setOnClickListener(view -> {
                getPreferences(MODE_PRIVATE).edit().remove("recentOrigin").apply();
                CookieManager.getInstance().removeAllCookies(value -> showConnect());
            });
            page.addView(forget);
        }
    }

    private void connect(String link) {
        final URI validated;
        try {
            validated = ConnectionPolicy.requireRemoteHttps(link);
        } catch (IllegalArgumentException error) {
            if (browser != null) showConnect();
            validation.setText(switch (error.getMessage()) {
                case "https" -> R.string.https_required;
                case "loopback" -> R.string.loopback_rejected;
                default -> R.string.invalid_link;
            });
            return;
        }
        if (address != null) address.setText("");
        closeBrowser();
        connectedOrigin = ConnectionPolicy.origin(validated);
        pairingHistoryPending = validated.getRawQuery() != null || validated.getRawFragment() != null;
        tlsBlocked = false;
        getPreferences(MODE_PRIVATE).edit().putString("recentOrigin", connectedOrigin).apply();
        root.removeAllViews();
        connectionBanner = new LinearLayout(this);
        connectionBanner.setOrientation(LinearLayout.VERTICAL);
        connectionBanner.setPadding(dp(16), dp(8), dp(16), dp(8));
        connectionBanner.setBackgroundColor(warningFill);
        connectionBanner.setVisibility(View.GONE);
        root.addView(connectionBanner, new LinearLayout.LayoutParams(-1, -2));
        browser = new WebView(this);
        browser.setSaveEnabled(false);
        browser.setBackgroundColor(paper);
        WebSettings settings = browser.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);
        browser.setWebViewClient(new BrowserClient());
        browser.setWebChromeClient(new BrowserChrome());
        browser.setDownloadListener(this::download);
        root.addView(browser, new LinearLayout.LayoutParams(-1, 0, 1));
        browser.loadUrl(link);
    }

    private final class BrowserClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String target = request.getUrl().toString();
            if (ConnectionPolicy.sameOrigin(connectedOrigin, target)) return false;
            if (!request.isForMainFrame() && ConnectionPolicy.ownedBlob(connectedOrigin, target)) return false;
            if (request.isForMainFrame() && request.hasGesture()) openExternal(target);
            return true;
        }
        @Override public void onPageFinished(WebView view, String url) {
            if (view != browser) return;
            if (ConnectionPolicy.sameOrigin(connectedOrigin, url)) {
                CookieManager.getInstance().flush();
                // Drop the pairing entry once the Host redirects to its normal client address.
                Uri uri = Uri.parse(url);
                if (pairingHistoryPending && uri.getQueryParameter("pair") == null
                        && uri.getQueryParameter("token") == null && uri.getFragment() == null) {
                    view.clearHistory();
                    pairingHistoryPending = false;
                }
            }
        }
        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (view == browser && request.isForMainFrame() && !tlsBlocked) showConnectionError(getString(R.string.connection_failed));
        }
        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (view == browser && request.isForMainFrame()) showConnectionError(getString(
                    response.getStatusCode() == 401 || response.getStatusCode() == 403
                            ? R.string.connection_refused : R.string.connection_http_error));
        }
        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (view == browser) {
                tlsBlocked = true;
                showConnectionError(getString(R.string.certificate_failed));
            }
        }
    }

    private final class BrowserChrome extends WebChromeClient {
        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (!ConnectionPolicy.sameOrigin(connectedOrigin, view.getUrl())) return false;
            if (fileSelection != null) fileSelection.onReceiveValue(null);
            fileSelection = callback;
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            ArrayList<String> mimeTypes = new ArrayList<>();
            for (String type : params.getAcceptTypes()) {
                if (type.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+*-]+")) mimeTypes.add(type);
            }
            if (!mimeTypes.isEmpty()) pick.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toArray(new String[0]));
            try {
                startActivityForResult(pick, PICK_FILES);
            } catch (ActivityNotFoundException error) {
                fileSelection.onReceiveValue(null);
                fileSelection = null;
                toast(getString(R.string.picker_unavailable));
            }
            return true;
        }
        @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
            if (!gesture) return false;
            WebView popup = new WebView(MainActivity.this);
            popups.add(popup);
            popup.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView window, WebResourceRequest request) {
                    String target = request.getUrl().toString();
                    if (browser != null && ConnectionPolicy.sameOrigin(connectedOrigin, target)) browser.loadUrl(target);
                    else openExternal(target);
                    popups.remove(popup);
                    popup.destroy();
                    return true;
                }
            });
            ((WebView.WebViewTransport) result.obj).setWebView(popup);
            result.sendToTarget();
            return true;
        }
        @Override public void onCloseWindow(WebView window) {
            popups.remove(window);
            window.destroy();
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != PICK_FILES || fileSelection == null) return;
        ArrayList<Uri> files = new ArrayList<>();
        if (result == RESULT_OK && data != null) {
            ClipData selected = data.getClipData();
            if (selected != null) {
                for (int i = 0; i < selected.getItemCount(); i++) {
                    Uri uri = selected.getItemAt(i).getUri();
                    if (uri != null && "content".equals(uri.getScheme())) files.add(uri);
                }
            } else if (data.getData() != null && "content".equals(data.getData().getScheme())) {
                files.add(data.getData());
            }
        }
        fileSelection.onReceiveValue(files.isEmpty() ? null : files.toArray(new Uri[0]));
        fileSelection = null;
    }

    private void download(String url, String agent, String disposition, String mime, long length) {
        if (!ConnectionPolicy.sameOrigin(connectedOrigin, url)) {
            toast(getString(url.startsWith("blob:") ? R.string.preview_download_unavailable : R.string.external_download));
            return;
        }
        String filename = URLUtil.guessFileName(url, disposition, mime).replaceAll("[\\\\/\\p{Cntrl}]", "_");
        String cookie = CookieManager.getInstance().getCookie(url);
        String downloadOrigin = connectedOrigin;
        toast(getString(R.string.downloading));
        new Thread(() -> {
            Uri output = null;
            HttpsURLConnection connection = null;
            try {
                String current = url;
                for (int redirects = 0; redirects <= 5; redirects++) {
                    if (!ConnectionPolicy.sameOrigin(downloadOrigin, current)) throw new IOException("External redirect");
                    connection = (HttpsURLConnection) new URL(current).openConnection();
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(20000);
                    connection.setReadTimeout(60000);
                    connection.setRequestProperty("User-Agent", agent);
                    if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                    int status = connection.getResponseCode();
                    if (status >= 300 && status < 400) {
                        String next = connection.getHeaderField("Location");
                        if (next == null || redirects == 5) throw new IOException("Invalid redirect");
                        current = new URI(current).resolve(next).toString();
                        connection.disconnect();
                        continue;
                    }
                    if (status != 200) throw new IOException("Download refused");
                    break;
                }
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, mime != null ? mime : "application/octet-stream");
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SciPaper");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                output = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (output == null) throw new IOException("Download destination unavailable");
                try (InputStream source = connection.getInputStream();
                        OutputStream destination = getContentResolver().openOutputStream(output)) {
                    if (destination == null) throw new IOException("Download destination unavailable");
                    byte[] buffer = new byte[32768];
                    int count;
                    while ((count = source.read(buffer)) != -1) destination.write(buffer, 0, count);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(output, values, null, null);
                output = null;
                runOnUiThread(() -> toast(getString(R.string.download_complete)));
            } catch (Exception error) {
                runOnUiThread(() -> toast(getString(R.string.download_failed)));
            } finally {
                if (connection != null) connection.disconnect();
                if (output != null) getContentResolver().delete(output, null, null);
            }
        }, "scipaper-download").start();
    }

    private void openExternal(String target) {
        try {
            URI safe = ConnectionPolicy.requireRemoteHttps(target);
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(safe.toString()))
                    .addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (IllegalArgumentException | ActivityNotFoundException error) {
            toast(getString(R.string.link_unavailable));
        }
    }

    private void showConnectionError(String message) {
        connectionBanner.removeAllViews();
        connectionBanner.addView(text(message, 14, ink));
        LinearLayout actions = new LinearLayout(this);
        Button retry = button(getString(R.string.retry), false);
        retry.setOnClickListener(view -> {
            connectionBanner.setVisibility(View.GONE);
            tlsBlocked = false;
            browser.loadUrl(connectedOrigin + "/");
        });
        actions.addView(retry);
        Button change = button(getString(R.string.reconnect), false);
        change.setOnClickListener(view -> showConnect());
        actions.addView(change);
        connectionBanner.addView(actions);
        connectionBanner.setVisibility(View.VISIBLE);
    }

    @Override public void onBackPressed() { navigateBack(); }

    private void navigateBack() {
        if (browser == null) finish();
        else if (browser.canGoBack()) browser.goBack();
        else showConnect();
    }

    @Override protected void onDestroy() {
        closeBrowser();
        super.onDestroy();
    }

    private void closeBrowser() {
        if (fileSelection != null) { fileSelection.onReceiveValue(null); fileSelection = null; }
        for (WebView popup : popups) popup.destroy();
        popups.clear();
        if (browser == null) return;
        browser.stopLoading();
        if (browser.getParent() instanceof ViewGroup parent) parent.removeView(browser);
        browser.destroy();
        browser = null;
    }

    private TextView text(String value, int size, int color) {
        TextView text = new TextView(this);
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(color);
        text.setLineSpacing(dp(3), 1);
        return text;
    }

    private Button button(String value, boolean primary) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(15);
        button.setTextColor(primary ? primaryInk : teal);
        button.setBackground(card(primary ? primaryFill : Color.TRANSPARENT, Color.TRANSPARENT));
        button.setMinimumHeight(dp(48));
        return button;
    }

    private GradientDrawable card(int fill, int border) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(fill);
        background.setCornerRadius(dp(14));
        background.setStroke(dp(1), border);
        return background;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
