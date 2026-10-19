package ai.deepseek.dshmobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
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
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.util.Locale;

/**
 * DSH Mobile: a plain-framework WebView shell around the desktop DSH mobile web page
 * (e.g. http://192.168.17.174:7860/m/).
 *
 * No AndroidX, no support libraries - only android.* framework APIs, so the whole app can be
 * built with aapt2 + javac + d8 without Gradle.
 */
public class MainActivity extends Activity {

    private static final String TAG = "DshMobile";

    /** Prefilled default address of the desktop DSH LAN bridge (user editable). */
    private static final String DEFAULT_URL = "http://192.168.17.174:7860/m/";

    /** Appended to the WebView user agent so the mobile page can enable APK full-screen mode. */
    private static final String UA_SUFFIX = " DSHMobileApp/0.2";
    private static final String APP_VERSION = "0.2.3";

    private static final String PREFS = "dsh_prefs";
    private static final String PREF_URL = "server_url";
    private static final String EXTRA_URL = "dsh_url";

    private static final int REQ_FILE = 1001;
    private static final long DOUBLE_BACK_MS = 2200L;

    private static final int COLOR_BG = 0xFF0B0F19;
    private static final int COLOR_TEXT = 0xFFE8EEF7;
    private static final int COLOR_TEXT_SECONDARY = 0xFF8A97AB;
    private static final int COLOR_TEXT_MUTED = 0xFF6B7A90;
    private static final int COLOR_ERROR = 0xFFFF6B6B;
    private static final int COLOR_ACCENT = 0xFF2563EB;

    private FrameLayout root;
    private FrameLayout webContainer;
    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout setupPanel;
    private ScrollView setupScroll;
    private LinearLayout setupContent;
    private EditText urlInput;
    private TextView errorText;
    private Button connectButton;
    private Button retryButton;
    private Button backButton;

    private SharedPreferences prefs;
    private ValueCallback<Uri[]> filePathCallback;
    private String currentUrl = "";
    private String serverHost = "";
    private boolean webHasContent = false;
    private boolean loadFailed = false;
    private long lastBackPress = 0L;
    private int statusBarHeightPx = 0;

    // ------------------------------------------------------------------------------------
    // Activity lifecycle
    // ------------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        statusBarHeightPx = resolveStatusBarHeight();

        applyEdgeToEdge();

        root = new FrameLayout(this);
        root.setBackgroundColor(COLOR_BG);
        root.setFitsSystemWindows(false);

        webContainer = new FrameLayout(this);
        webContainer.setBackgroundColor(COLOR_BG);
        // Keep the page below the status bar while the window itself stays edge-to-edge and the
        // status bar is transparent: the result is a seamless dark chrome without overlapping text.
        webContainer.setPadding(0, statusBarHeightPx, 0, 0);
        root.addView(webContainer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webContainer.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWebView(webView);

        installImeInsets();

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setIndeterminate(false);
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);
        if (Build.VERSION.SDK_INT >= 21) {
            progressBar.setProgressTintList(ColorStateList.valueOf(COLOR_ACCENT));
            progressBar.setProgressBackgroundTintList(ColorStateList.valueOf(0xFF16213A));
        }
        FrameLayout.LayoutParams progressLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        progressLp.gravity = Gravity.TOP;
        webContainer.addView(progressBar, progressLp);

        setupPanel = buildSetupPanel();
        root.addView(setupPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        String intentUrl = extractUrlFromIntent(getIntent());
        if (intentUrl != null) {
            connectTo(intentUrl);
            return;
        }
        String saved = prefs.getString(PREF_URL, null);
        if (saved == null || saved.trim().isEmpty()) {
            // First launch: show the native setup screen with the default URL prefilled.
            // Do not focus the URL input: the soft keyboard should only appear on a tap.
            showSetup(null, false);
        } else {
            loadWebUrl(saved);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = extractUrlFromIntent(intent);
        if (url != null) {
            connectTo(url);
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            try {
                webContainer.removeView(webView);
                webView.destroy();
            } catch (Exception e) {
                Log.w(TAG, "webview destroy failed", e);
            }
            webView = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------------------------
    // Edge-to-edge + status bar
    // ------------------------------------------------------------------------------------

    private void applyEdgeToEdge() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 21) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(COLOR_BG);
        }
        // Keep the keyboard in resize mode; the IME inset is applied as bottom padding in
        // installImeInsets(), so the WebView (and the chat input inside it) always stays above
        // the soft keyboard / pinyin candidate bar.
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_UNCHANGED);
        if (Build.VERSION.SDK_INT >= 30) {
            // Edge-to-edge: draw under the system bars and handle the IME inset ourselves.
            window.setDecorFitsSystemWindows(false);
        } else {
            // Legacy edge-to-edge; FLAG_LAYOUT_NO_LIMITS is only safe here because the old
            // WebView viewport still shrinks for the IME via the inset listener fallback.
            window.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
        }
        View decor = window.getDecorView();
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        decor.setFitsSystemWindows(false);
    }

    /**
     * Shrink the page container by the soft-keyboard height. Without this the thin edge-to-edge
     * window keeps full height and the chat composer hides behind the pinyin IME panel.
     */
    private void installImeInsets() {
        if (webContainer == null) return;
        webContainer.setOnApplyWindowInsetsListener((view, insets) -> {
            int bottomInset = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                int imeBottom = insets.getInsets(WindowInsets.Type.ime()).bottom;
                int navBottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
                bottomInset = Math.max(imeBottom, navBottom);
            } else {
                // Legacy path: systemWindowInsetBottom already equals the IME height while the
                // keyboard is open, and the navigation-bar height while it is closed.
                bottomInset = Math.max(0, insets.getSystemWindowInsetBottom());
            }
            if (view.getPaddingTop() != statusBarHeightPx || view.getPaddingBottom() != bottomInset) {
                view.setPadding(0, statusBarHeightPx, 0, bottomInset);
            }
            return insets;
        });
        webContainer.requestApplyInsets();
    }

    private int resolveNavigationBarHeight() {
        int resId = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
        if (resId > 0) {
            return getResources().getDimensionPixelSize(resId);
        }
        return (int) (48f * getResources().getDisplayMetrics().density);
    }

    private int resolveStatusBarHeight() {
        int resId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resId > 0) {
            return getResources().getDimensionPixelSize(resId);
        }
        return (int) (26f * getResources().getDisplayMetrics().density);
    }

    // ------------------------------------------------------------------------------------
    // WebView setup
    // ------------------------------------------------------------------------------------

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureWebView(WebView view) {
        view.setBackgroundColor(COLOR_BG);
        view.setVerticalScrollBarEnabled(false);
        // Local-only companion app: allow DevTools inspection over adb for troubleshooting.
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) {
            cm.setAcceptThirdPartyCookies(view, true);
        }

        s.setSupportMultipleWindows(false);
        view.setWebViewClient(new DshWebViewClient());
        view.setWebChromeClient(new DshChromeClient());
        view.addJavascriptInterface(new DshAppBridge(), "DshApp");
        view.setDownloadListener(new DshDownloadListener());
    }

    private void loadWebUrl(String url) {
        currentUrl = url;
        serverHost = hostOf(url);
        loadFailed = false;
        webHasContent = false;
        progressBar.setVisibility(View.VISIBLE);
        webView.loadUrl(withAppParam(url));
    }

    // ------------------------------------------------------------------------------------
    // Setup / settings screen
    // ------------------------------------------------------------------------------------

    private LinearLayout buildSetupPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(COLOR_BG);
        panel.setVisibility(View.GONE);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(COLOR_BG);
        setupScroll = scroll;

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padH = dp(24);
        content.setPadding(padH, statusBarHeightPx + dp(28), padH, dp(32));
        setupContent = content;
        scroll.addView(content, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        panel.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setText(getString(R.string.setup_title));
        title.setTextColor(COLOR_TEXT);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        content.addView(title, wrapParams(0, 0));

        TextView hint = new TextView(this);
        hint.setText(getString(R.string.setup_hint));
        hint.setTextColor(COLOR_TEXT_SECONDARY);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        LinearLayout.LayoutParams hintLp = wrapParams(0, 0);
        hintLp.topMargin = dp(10);
        content.addView(hint, hintLp);

        urlInput = new EditText(this);
        urlInput.setText(DEFAULT_URL);
        urlInput.setSingleLine(true);
        urlInput.setHint(DEFAULT_URL);
        urlInput.setTextColor(COLOR_TEXT);
        urlInput.setHintTextColor(COLOR_TEXT_MUTED);
        urlInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        urlInput.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setBackgroundResource(R.drawable.bg_input);
        urlInput.setPadding(dp(16), dp(14), dp(16), dp(14));
        urlInput.setSelectAllOnFocus(false);
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputLp.topMargin = dp(22);
        content.addView(urlInput, inputLp);

        errorText = new TextView(this);
        errorText.setTextColor(COLOR_ERROR);
        errorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        errorText.setVisibility(View.GONE);
        LinearLayout.LayoutParams errorLp = wrapParams(0, 0);
        errorLp.topMargin = dp(10);
        content.addView(errorText, errorLp);

        connectButton = new Button(this);
        connectButton.setText(getString(R.string.connect));
        connectButton.setAllCaps(false);
        connectButton.setTextColor(Color.WHITE);
        connectButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        connectButton.setBackgroundResource(R.drawable.bg_button_primary);
        connectButton.setMinHeight(0);
        connectButton.setMinimumHeight(0);
        connectButton.setStateListAnimator(null);
        LinearLayout.LayoutParams connectLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        connectLp.topMargin = dp(18);
        content.addView(connectButton, connectLp);
        connectButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                connectTo(urlInput.getText().toString());
            }
        });

        retryButton = new Button(this);
        retryButton.setText(getString(R.string.retry));
        retryButton.setAllCaps(false);
        retryButton.setTextColor(COLOR_TEXT);
        retryButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        retryButton.setBackgroundResource(R.drawable.bg_button_secondary);
        retryButton.setMinHeight(0);
        retryButton.setMinimumHeight(0);
        retryButton.setStateListAnimator(null);
        LinearLayout.LayoutParams retryLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        retryLp.topMargin = dp(12);
        content.addView(retryButton, retryLp);
        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (currentUrl != null && !currentUrl.isEmpty() && webHasContent) {
                    hideSetup();
                    loadWebUrl(currentUrl);
                } else {
                    connectTo(urlInput.getText().toString());
                }
            }
        });

        backButton = new Button(this);
        backButton.setText(getString(R.string.back_to_page));
        backButton.setAllCaps(false);
        backButton.setTextColor(COLOR_TEXT_SECONDARY);
        backButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        backButton.setBackgroundResource(R.drawable.bg_button_secondary);
        backButton.setMinHeight(0);
        backButton.setMinimumHeight(0);
        backButton.setStateListAnimator(null);
        backButton.setVisibility(View.GONE);
        LinearLayout.LayoutParams backLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        backLp.topMargin = dp(12);
        content.addView(backButton, backLp);
        backButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (webHasContent) {
                    hideSetup();
                }
            }
        });

        TextView note = new TextView(this);
        note.setText(getString(R.string.setup_note));
        note.setTextColor(COLOR_TEXT_MUTED);
        note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        note.setLineSpacing(dp(2), 1f);
        LinearLayout.LayoutParams noteLp = wrapParams(0, 0);
        noteLp.topMargin = dp(22);
        content.addView(note, noteLp);

        return panel;
    }

    private void showSetup(String errorMessage, boolean focusInput) {
        if (setupPanel == null) return;
        setupPanel.setVisibility(View.VISIBLE);
        progressBar.setVisibility(View.GONE);
        if (errorMessage != null && !errorMessage.isEmpty()) {
            errorText.setText(errorMessage);
            errorText.setVisibility(View.VISIBLE);
        } else {
            errorText.setVisibility(View.GONE);
        }
        String saved = prefs.getString(PREF_URL, null);
        urlInput.setText(saved != null && !saved.isEmpty() ? saved : DEFAULT_URL);
        urlInput.setSelection(urlInput.getText().length());
        retryButton.setEnabled(currentUrl != null && !currentUrl.isEmpty());
        backButton.setVisibility(webHasContent ? View.VISIBLE : View.GONE);
        if (focusInput) {
            urlInput.requestFocus();
        }
    }

    private void hideSetup() {
        if (setupPanel == null) return;
        setupPanel.setVisibility(View.GONE);
        webView.requestFocus();
    }

    // ------------------------------------------------------------------------------------
    // URL handling
    // ------------------------------------------------------------------------------------

    private static String hostOf(String url) {
        try {
            Uri uri = Uri.parse(url);
            String host = uri.getHost();
            return host == null ? "" : host.toLowerCase(Locale.US);
        } catch (Exception e) {
            return "";
        }
    }

    /** Prefix http:// when missing and append /m/ when the user typed only host[:port]. */
    private static String normalizeUrl(String raw) {
        if (raw == null) return null;
        String u = raw.trim();
        if (u.isEmpty()) return null;
        String lower = u.toLowerCase(Locale.US);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            if (lower.contains("://")) return null; // unsupported scheme
            u = "http://" + u;
        }
        try {
            Uri uri = Uri.parse(u);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) return null;
            scheme = scheme.toLowerCase(Locale.US);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            String path = uri.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) {
                uri = uri.buildUpon().path("/m/").build();
            }
            return uri.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static String withAppParam(String url) {
        if (url == null) return null;
        return url + (url.contains("?") ? "&" : "?") + "app=1";
    }

    private void connectTo(String rawUrl) {
        String normalized = normalizeUrl(rawUrl);
        if (normalized == null) {
            showSetup(getString(R.string.invalid_url), false);
            return;
        }
        prefs.edit().putString(PREF_URL, normalized).apply();
        hideSetup();
        loadWebUrl(normalized);
    }

    private String extractUrlFromIntent(Intent intent) {
        if (intent == null) return null;
        String extra = intent.getStringExtra(EXTRA_URL);
        if (extra != null && !extra.trim().isEmpty()) return extra.trim();
        Uri data = intent.getData();
        if (data != null) {
            String scheme = data.getScheme();
            if (scheme != null) {
                String s = scheme.toLowerCase(Locale.US);
                if ("http".equals(s) || "https".equals(s)) return data.toString();
                if ("dshmobile".equals(s)) {
                    String q = data.getQueryParameter("url");
                    if (q != null && !q.trim().isEmpty()) return q.trim();
                }
            }
        }
        return null;
    }

    // ------------------------------------------------------------------------------------
    // WebViewClient
    // ------------------------------------------------------------------------------------

    private class DshWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(request.getUrl());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            loadFailed = false;
            progressBar.setVisibility(View.VISIBLE);
            errorText.setVisibility(View.GONE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progressBar.setVisibility(View.GONE);
            if (!loadFailed) {
                webHasContent = true;
                hideSetup();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                                    WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                handleMainFrameError(error == null ? 0 : error.getErrorCode(),
                        error == null ? "unknown" : String.valueOf(error.getDescription()));
            }
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView view, int errorCode, String description,
                                    String failingUrl) {
            handleMainFrameError(errorCode, description);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse errorResponse) {
            // Do not hijack 401 auth pages: the mobile shell shows its pairing view for those.
            Log.d(TAG, "http error " + (errorResponse == null ? "?" : errorResponse.getStatusCode())
                    + " for " + (request == null ? "?" : request.getUrl()));
        }
    }

    private void handleMainFrameError(int errorCode, String description) {
        String desc = description == null ? "" : description;
        if (desc.contains("ERR_ABORTED") || desc.contains("ERR_BLOCKED")) {
            return; // navigation was superseded by the user; not a real failure
        }
        loadFailed = true;
        webHasContent = false;
        progressBar.setVisibility(View.GONE);
        Log.w(TAG, "main frame load error " + errorCode + ": " + desc);
        showSetup("加载失败：" + (desc.isEmpty() ? "网络错误" : desc), false);
    }

    private boolean handleNavigation(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        String s = scheme.toLowerCase(Locale.US);
        if ("http".equals(s) || "https".equals(s)) {
            String host = uri.getHost();
            if (serverHost != null && !serverHost.isEmpty() && host != null
                    && !serverHost.equalsIgnoreCase(host)) {
                return openExternal(uri);
            }
            return false; // same DSH server: keep inside the WebView
        }
        if ("about".equals(s) || "javascript".equals(s) || "data".equals(s) || "blob".equals(s)) {
            return false;
        }
        return openExternal(uri);
    }

    private boolean openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "no activity for " + uri);
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.w(TAG, "open external failed", e);
        }
        return true;
    }

    // ------------------------------------------------------------------------------------
    // WebChromeClient: progress, file chooser, console
    // ------------------------------------------------------------------------------------

    private class DshChromeClient extends WebChromeClient {

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                filePathCallback = null;
                Log.w(TAG, "no file picker", e);
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
            if (consoleMessage != null) {
                Log.d(TAG, "[page] " + consoleMessage.message()
                        + " (" + consoleMessage.lineNumber() + ")");
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (filePathCallback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    results = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        results[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------------------------------
    // Downloads
    // ------------------------------------------------------------------------------------

    private class DshDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimeType, long contentLength) {
            if (url == null) return;
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                Toast.makeText(MainActivity.this, "该下载类型暂不支持", Toast.LENGTH_SHORT).show();
                return;
            }
            try {
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                if (mimeType != null) request.setMimeType(mimeType);
                if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) request.addRequestHeader("Cookie", cookie);
                request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setTitle(fileName);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    request.setDestinationInExternalPublicDir(
                            Environment.DIRECTORY_DOWNLOADS, fileName);
                } else {
                    // API 26-28: writing the public Downloads dir would need a runtime storage
                    // permission; the app deliberately requests INTERNET only, so use the
                    // app-specific downloads folder instead (still visible in the notification).
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir != null && !dir.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        dir.mkdirs();
                    }
                    request.setDestinationInExternalFilesDir(MainActivity.this,
                            Environment.DIRECTORY_DOWNLOADS, fileName);
                }
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) {
                    dm.enqueue(request);
                    Toast.makeText(MainActivity.this,
                            getString(R.string.download_started), Toast.LENGTH_SHORT).show();
                }
            } catch (Exception e) {
                Log.w(TAG, "download failed", e);
                Toast.makeText(MainActivity.this, "下载失败", Toast.LENGTH_SHORT).show();
            }
        }
    }

    // ------------------------------------------------------------------------------------
    // JS bridge exposed to the mobile page as window.DshApp
    // ------------------------------------------------------------------------------------

    public class DshAppBridge {

        @JavascriptInterface
        public int getTopInsetPx() {
            return statusBarHeightPx;
        }

        @JavascriptInterface
        public String getAppVersion() {
            return APP_VERSION;
        }

        @JavascriptInterface
        public boolean isApp() {
            return true;
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showSetup(null, false);
                }
            });
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) webView.reload();
                }
            });
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }

        @JavascriptInterface
        public void loadUrl(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    connectTo(url);
                }
            });
        }
    }

    // ------------------------------------------------------------------------------------
    // Back button: history first, then in-app settings, double-back to exit
    // ------------------------------------------------------------------------------------

    @Override
    public void onBackPressed() {
        boolean setupVisible = setupPanel != null && setupPanel.getVisibility() == View.VISIBLE;
        if (!setupVisible && webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (!setupVisible) {
            // First back on the root page: turn the setup screen into in-app settings.
            showSetup(null, false);
            lastBackPress = now;
            return;
        }
        if (now - lastBackPress < DOUBLE_BACK_MS) {
            finish();
            return;
        }
        lastBackPress = now;
        Toast.makeText(this, getString(R.string.exit_hint), Toast.LENGTH_SHORT).show();
    }

    // ------------------------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------------------------

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private LinearLayout.LayoutParams wrapParams(int marginTopDp, int marginBottomDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(marginTopDp);
        lp.bottomMargin = dp(marginBottomDp);
        return lp;
    }
}
