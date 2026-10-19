/* ============================================================================
 * DSH Mobile — shell application logic (vanilla JS, no dependencies)
 *
 * v0.3.6 「沉浸式原生」production shell, ported from the approved design
 * archive (design/preview/index.html). Served by the mobile-bridge plugin at
 * /m/app.js, same origin as the proxied DSH Web GUI ("/").
 *
 * Contract (see docs/ARCHITECTURE.md "Mobile shell contract"):
 *   GET  /m/api/state -> { ok, paired, host, dshUrl: "/", pinRequired }
 *   POST /m/api/pair  { code } -> 200 { ok:true, url, expiresInMs }
 *                              -> 401 { ok:false, error:"bad-pin", attemptsLeft? }
 *                              -> 429 { ok:false, error:"locked", retryAfterMs }
 *
 * Login flow: the tokenised `url` is loaded in a hidden same-origin iframe so
 * DSH sets its auth cookie for this origin *without* navigating the shell away,
 * then the real GUI is shown in a full-screen same-origin iframe.
 *
 * The chat area is always the REAL DSH GUI; this shell owns the chrome around
 * it: floating status capsule, glass Dock, session drawer, quick-actions sheet,
 * pairing page, settings/diagnostics page, APK full-screen mode and animations.
 * ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* constants                                                           */
  /* ------------------------------------------------------------------ */

  const API = {
    state: '/m/api/state',
    pair: '/m/api/pair',
  };

  const APP_VERSION = '0.3.20';

  const WATCHDOG_INTERVAL_MS = 5000; // poll /m/api/state while foreground
  const STATE_TIMEOUT_MS = 4000; // per state probe
  const TOKEN_REDEEM_WAIT_MS = 600; // contract: wait ~600ms, then re-check state
  const TOKEN_REDEEM_TIMEOUT_MS = 8000; // give up on the hidden iframe login
  const FRAME_LOAD_TIMEOUT_MS = 15000; // show the actionable frame-error overlay
  const DEFAULT_LOCKOUT_SECONDS = 30;

  const STYLE_ID = 'dsh-mobile-adaptive-style';
  const SCALE_STORAGE_KEY = 'dsh-mobile.interface-scale';
  const THEME_STORAGE_KEY = 'dsh-mobile.theme';
  const ACCENT_STORAGE_KEY = 'dsh-mobile.accent';
  const INSTALL_HINT_KEY = 'dsh-mobile.install-hint-dismissed';
  const SCALE_VALUES = [90, 100, 110, 125];

  const APK_DOWNLOAD_URL = './download/DSH-Mobile.apk';
  const APP_MODE_UA_TOKEN = 'DSHMobileApp/'; // Android WebView UA suffix
  const APK_BAR_AUTO_HIDE_MS = 8000;
  const KEYBOARD_SHRINK_PX = 120;

  const THEMES = { space: '深空', midnight: '极夜', nebula: '幽蓝' };

  const ACCENTS = {
    blue: { name: '电光蓝', a: '#2f7bff', b: '#29d3ff', soft: 'rgba(47,123,255,.16)', glow: 'rgba(47,123,255,.4)' },
    teal: { name: '青碧', a: '#14b8a6', b: '#22d3ee', soft: 'rgba(20,184,166,.15)', glow: 'rgba(20,184,166,.38)' },
    violet: { name: '紫电', a: '#7c5cff', b: '#c084fc', soft: 'rgba(124,92,255,.17)', glow: 'rgba(124,92,255,.4)' },
    green: { name: '森绿', a: '#10b981', b: '#6ee7b7', soft: 'rgba(16,185,129,.15)', glow: 'rgba(16,185,129,.38)' },
  };

  /**
   * Stable quick-action selectors for the real DSH GUI (verified against the
   * DSH 0.2.1-rc.2 client bundles + ui-smoke runs):
   *   sidebar toggle: aria-label "打开侧边栏"/"收起侧边栏" (en Open/Collapse sidebar)
   *   new session:    aria-label "新建会话" (en New session)
   * Fallback matches aria-label/title patterns; when nothing resolves the
   * corresponding Dock button is hidden silently.
   */
  const GUI_ACTION_SELECTORS = {
    sidebar: [
      'button[aria-label="打开侧边栏"]',
      'button[aria-label="收起侧边栏"]',
      'button[aria-label="Open sidebar"]',
      'button[aria-label="Collapse sidebar"]',
    ],
    newSession: ['button[aria-label="新建会话"]', 'button[aria-label="New session"]'],
  };
  const GUI_ACTION_PATTERNS = {
    sidebar: /(打开侧边栏|收起侧边栏|侧边栏|侧栏|open sidebar|collapse sidebar|sidebar)/i,
    newSession: /(新建会话|新会话|new session|new chat)/i,
  };

  /**
   * v0.3.6 — mobile-inappropriate actions that would open a DESKTOP native file
   * / directory picker (or another desktop-only dialog). The WebView cannot show
   * those dialogs, so known entries are hidden and a generic matcher + capture
   * click guard blocks any dynamically rendered variant.
   *
   * Explicitly NOT matched: 选择工作区 (the workspace switcher trigger), existing
   * workspace rows (默认工作区…), session lists, search/view options and file
   * upload (WebView file chooser is supported).
   */
  const DESKTOP_DIALOG_PATTERN =
    /(打开工作区|新建工作区|添加工作区|打开文件夹|打开目录|选择文件夹|选择目录|打开方式|Open (workspace|folder|directory)|New workspace|Add workspace|Open in)/i;
  /** Known static entries: hidden by injected CSS before the guard even runs. */
  const DESKTOP_DIALOG_HIDE_SELECTORS = [
    'button[aria-label="添加工作区"]',
    '[aria-label*="添加工作区"]',
    '[aria-label*="打开工作区"]',
    '[aria-label*="新建工作区"]',
    '[aria-label*="打开文件夹"]',
    '[aria-label*="打开目录"]',
    '[aria-label*="选择文件夹"]',
    '[aria-label*="选择目录"]',
    '[aria-label*="打开方式"]',
    '[aria-label*="Open in"]',
    '[aria-label*="open in"]',
  ];
  const GUARDED_ACTION_ATTR = 'data-dsh-mobile-blocked';
  const MOBILE_BLOCKED_TOAST_TEXT = '手机端暂不支持该操作（需在电脑端选择）';
  const EMPTY_WORKSPACE_BLOCKED_TOAST_TEXT = '手机端暂不支持，请在电脑端打开/新建工作区';
  const MOBILE_TOAST_MESSAGE_TYPE = 'dsh-mobile-toast';
  /**
   * Empty-state protection (v0.3.6): a DSH instance without any workspace shows
   * a 「选择工作区」 command trigger. On desktop it opens the native directory
   * picker (create/open a workspace) — impossible in the WebView. Detect the
   * empty state and treat that chooser as a desktop-dialog action. When a real
   * workspace exists, the trigger displays its name (e.g. 默认工作区) and opens
   * the normal workspace dropdown — that must stay usable.
   */
  const EMPTY_WORKSPACE_STATE_PATTERN =
    /(无法创建默认工作区|暂无工作区|选择一个工作区|选择工作区开始|请选择工作区|没有工作区|No work ?space|Choose a workspace|Select a workspace|Create a workspace)/i;
  const WORKSPACE_CHOOSER_TEXT_PATTERN = /^\s*(选择工作区|选择文件夹|选择目录|打开工作区|新建工作区)\s*$/;

  /* ------------------------------------------------------------------ */
  /* tiny helpers                                                        */
  /* ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      /* private mode / disabled storage: ignore */
    }
  }

  function readScale() {
    const num = Number(storageGet(SCALE_STORAGE_KEY));
    return SCALE_VALUES.indexOf(num) >= 0 ? num : 100;
  }

  function readTheme() {
    const value = storageGet(THEME_STORAGE_KEY);
    return Object.prototype.hasOwnProperty.call(THEMES, value) ? value : 'space';
  }

  function readAccent() {
    const value = storageGet(ACCENT_STORAGE_KEY);
    return Object.prototype.hasOwnProperty.call(ACCENTS, value) ? value : 'blue';
  }

  function detectStandalone() {
    try {
      return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        window.navigator.standalone === true
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * APK full-screen mode: Android wrapper appends " DSHMobileApp/0.1" to the
   * WebView UA and loads `/m/?app=1`; it may also inject a `DshApp` interface.
   */
  function detectAppMode() {
    try {
      const ua = String(navigator.userAgent || '');
      if (ua.indexOf(APP_MODE_UA_TOKEN) >= 0) return true;
      const params = new URLSearchParams(window.location.search || '');
      if (params.get('app') === '1') return true;
      if (window.DshApp && typeof window.DshApp === 'object') return true;
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  /** Read an `env(safe-area-inset-*)` value through a hidden probe element. */
  function readEnvInset(side) {
    try {
      if (typeof window.getComputedStyle !== 'function') return 0;
      const probe = document.createElement('div');
      probe.style.cssText =
        'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-' +
        side +
        ',0px)';
      (document.body || document.documentElement).appendChild(probe);
      const value = parseFloat(window.getComputedStyle(probe).height) || 0;
      probe.remove();
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  /** Optional Android wrapper JS interface; every access is guarded. */
  function nativeBridge() {
    try {
      const bridge = window.DshApp;
      return bridge && typeof bridge === 'object' ? bridge : null;
    } catch (_) {
      return null;
    }
  }

  function hasNativeMethod(method) {
    try {
      const bridge = nativeBridge();
      return !!bridge && typeof bridge[method] === 'function';
    } catch (_) {
      return false;
    }
  }

  function callNative(method, ...args) {
    try {
      const bridge = nativeBridge();
      if (!bridge || typeof bridge[method] !== 'function') return null;
      return bridge[method](...args);
    } catch (_) {
      return null; // never let a missing/broken JS interface break the shell
    }
  }

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  const state = {
    // server-derived
    paired: false,
    host: '',
    pinRequired: true,
    online: null, // null = unknown yet
    latencyMs: null,
    // shell
    currentScreen: 'boot',
    booted: false,
    digits: '',
    busy: false,
    checking: false,
    frameLoaded: false,
    forcePairing: false,
    lastCheckAt: 0,
    lastError: '',
    lastErrorAt: 0,
    loginUrl: null,
    scale: readScale(),
    theme: readTheme(),
    accent: readAccent(),
    standalone: detectStandalone(),
    installPromptEvent: null,
    // native-app mode
    appMode: detectAppMode(),
    android: /Android/i.test(String(navigator.userAgent || '')),
    ios: /iPhone|iPad|iPod/i.test(String(navigator.userAgent || '')),
    nativeAvailable: false,
    nativeTopInset: 0,
    nativeBottomInset: 0,
    barsHidden: false,
    barsAutohideTimer: null,
    capsuleHidden: false,
    keyboardOpen: false,
    layoutBaseline: 0,
    // pairing
    lockedUntil: 0,
    lockTimer: null,
    successBusy: false,
    // quick actions / drawer / sheet
    apkChecked: false,
    apkAvailable: null,
    quickAvailable: { sidebar: null, newSession: null },
    quickProbeTimers: [],
    drawerOpen: false,
    sheetOpen: false,
    guiSessions: [],
    guiSidebarOpened: false,
    guiSidebarExpanded: false,
    sessionScraped: false,
    iframeScrollBound: false,
    capsuleHoldUntil: 0,
    // desktop-dialog guard (v0.3.6)
    lastBlockedAction: '',
    lastBlockedToastAt: 0,
    lastUnblockedCount: 0,
    guiDialogGuardDoc: null,
    guiDialogObserver: null,
    guiDialogScanTimer: null,
    // timers
    watchdogTimer: null,
    frameLoadingTimer: null,
    toastTimer: null,
    capsuleHoldTimer: null,
    themeObserver: null,
  };

  /** Per-scroll-container last scrollTop, used for the auto-hiding capsule. */
  let scrollTopByTarget = new WeakMap();

  let els = {};

  /* ------------------------------------------------------------------ */
  /* DOM cache                                                           */
  /* ------------------------------------------------------------------ */

  function cacheEls() {
    els = {
      app: $('app'),
      capsule: $('capsule'),
      capsuleSub: $('capsuleSub'),
      reloadBtn: $('reloadBtn'),
      capsuleMore: $('capsuleMore'),
      statusPeek: $('statusPeek'),
      appHandle: $('appHandle'),
      offlineBanner: $('offlineBanner'),
      offlineText: $('offlineText'),
      offlineRetry: $('offlineRetry'),

      bootView: $('bootView'),
      bootText: $('bootText'),

      pairingView: $('pairingView'),
      pairForm: $('pairForm'),
      pairCard: document.querySelector('.pair-card'),
      pinRow: $('pinRow'),
      pinCells: $$('.pin-cell'),
      pairHint: $('pairHint'),
      pairStatusText: $('pairStatusText'),
      keypad: $('keypad'),
      keypadKeys: $$('#keypad [data-key]'),
      pairFallback: $('pairFallback'),
      pairFallbackText: $('pairFallbackText'),
      manualLoginBtn: $('manualLoginBtn'),
      retryAutoBtn: $('retryAutoBtn'),
      pairApk: $('pairApk'),
      scanPair: $('scanPair'),
      appSettingsBtn: $('appSettingsBtn'),

      chatView: $('chatView'),
      frameHost: $('frameHost'),
      guiFrame: $('guiFrame'),
      frameLoading: $('frameLoading'),
      frameLoadingText: document.querySelector('.frame-loading-text'),
  frameError: $('frameError'),
  frameErrorText: $('frameErrorText'),
  frameErrorRetry: $('frameErrorRetry'),
  frameErrorSettings: $('frameErrorSettings'),

      settingsView: $('settingsView'),
      settingsBack: $('settingsBack'),
      settingsConnText: $('settingsConnText'),
      settingsOrigin: $('settingsOrigin'),
  settingsServerInput: $('settingsServerInput'),
  settingsServerApply: $('settingsServerApply'),
  settingsServerReset: $('settingsServerReset'),
  pairChangeServer: $('pairChangeServer'),
      settingsHost: $('settingsHost'),
      settingsState: $('settingsState'),
      settingsStateText: $('settingsStateText'),
      settingsMode: $('settingsMode'),
      settingsThemeLabel: $('settingsThemeLabel'),
      settingsAccentLabel: $('settingsAccentLabel'),
      settingsApkVersion: $('settingsApkVersion'),
      settingsNative: $('settingsNative'),
      settingsQuick: $('settingsQuick'),
      settingsLastError: $('settingsLastError'),
      settingsPaired: $('settingsPaired'),
      settingsDownloadApk: $('settingsDownloadApk'),
      settingsNativeSettings: $('settingsNativeSettings'),
      settingsReconnect: $('settingsReconnect'),
      settingsAddressHelp: $('settingsAddressHelp'),
      settingsRecheck: $('settingsRecheck'),
      settingsReload: $('settingsReload'),
      copyDiagBtn: $('copyDiagBtn'),
      disconnectBtn: $('disconnectBtn'),
      themeRow: $('themeRow'),
      accentRow: $('accentRow'),
      fontScaleInput: $('fontScaleInput'),
      fontScaleOut: $('fontScaleOut'),
      diagCard: document.querySelector('[data-settings-target="diagnostics"]'),

      scrim: $('scrim'),
      drawer: $('drawer'),
      drawerSubtitle: $('drawerSubtitle'),
      sessionList: $('sessionList'),
      sessionSearch: $('sessionSearch'),
      drawerFallback: $('drawerFallback'),
      openGuiSessionsBtn: $('openGuiSessionsBtn'),
      quickSheet: $('quickSheet'),
      diagBtn: $('diagBtn'),
      sheetStatusTitle: $('sheetStatusTitle'),
      sheetStatusSub: $('sheetStatusSub'),
      dock: $('dock'),

      pairSuccess: $('pairSuccess'),
      pairSuccessText: $('pairSuccessText'),
      toast: $('appToast'),
    };
  }

  /* ------------------------------------------------------------------ */
  /* toast / connection / errors                                         */
  /* ------------------------------------------------------------------ */

  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = String(message || '');
    els.toast.classList.add('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 2300);
  }

  function recordError(message) {
    state.lastError = String(message || '未知错误');
    state.lastErrorAt = Date.now();
    if (els.settingsLastError) els.settingsLastError.textContent = state.lastError;
  }

  function connectionText() {
    if (state.online === false) return '桌面端离线';
    if (state.paired) return '已连接';
    if (state.online === null) return '正在连接…';
    return '等待配对';
  }

  function updateConnectionUi() {
    if (!els.app) return;
    const conn = state.online === false ? 'offline' : state.paired ? 'online' : 'connecting';
    els.app.dataset.conn = conn;
    const text = connectionText();
    if (els.capsuleSub) els.capsuleSub.textContent = text;
    if (els.settingsConnText) els.settingsConnText.textContent = text;
    if (els.settingsStateText) {
      els.settingsStateText.textContent =
        state.online === false ? '离线' : state.paired ? '已连接' + (state.latencyMs != null ? ' · ' + state.latencyMs + ' ms' : '') : '未配对';
    }
    if (els.sheetStatusTitle) els.sheetStatusTitle.textContent = state.online === false ? '桌面端离线' : '已连接 · 桌面端';
    if (els.sheetStatusSub) {
      els.sheetStatusSub.textContent = (state.host || location.host || '—') + (state.latencyMs != null ? ' · 延迟 ' + state.latencyMs + ' ms' : '');
    }
    if (els.pairStatusText) {
      els.pairStatusText.textContent = state.online === false ? '桌面端离线' : '等待配对';
    }
  }

  function showOffline(message) {
    if (!els.offlineBanner) return;
    if (message && els.offlineText) els.offlineText.textContent = message;
    els.offlineBanner.classList.add('is-visible');
  }

  function hideOffline() {
    if (!els.offlineBanner) return;
    els.offlineBanner.classList.remove('is-visible');
  }

  /* ------------------------------------------------------------------ */
  /* screens                                                             */
  /* ------------------------------------------------------------------ */

  const SCREEN_IDS = ['boot', 'pair', 'chat', 'settings'];

  function showScreen(name) {
    const target = SCREEN_IDS.indexOf(name) >= 0 ? name : 'boot';
    state.currentScreen = target;
    if (els.app) els.app.dataset.screen = target;
    const nodes = {
      boot: els.bootView,
      pair: els.pairingView,
      chat: els.chatView,
      settings: els.settingsView,
    };
    SCREEN_IDS.forEach((key) => {
      const node = nodes[key];
      if (!node) return;
      const active = key === target;
      node.hidden = !active;
      node.classList.toggle('is-active', active);
    });
    updateChromeVisibility();
    if (target === 'settings') populateSettings();
    if (target !== 'chat') {
      closeDrawer();
      closeSheet();
    }
  }

  function updateChromeVisibility() {
    // CSS decides visibility from data-screen; keep the peek / capsule classes in sync.
    if (els.app) {
      if (state.currentScreen !== 'chat') {
        els.app.dataset.capsule = 'shown';
        state.capsuleHidden = false;
      }
    }
  }

  function hideBootText(text) {
    if (els.bootText && text) els.bootText.textContent = text;
  }

  /* ------------------------------------------------------------------ */
  /* pairing: PIN + keypad                                               */
  /* ------------------------------------------------------------------ */

  function getPin() {
    return state.digits;
  }

  function isLocked() {
    return Date.now() < state.lockedUntil;
  }

  function renderPin(popIndex) {
    els.pinCells.forEach((cell, index) => {
      const filled = index < state.digits.length;
      cell.value = filled ? state.digits[index] : '';
      cell.classList.toggle('is-filled', filled);
      cell.classList.toggle('is-active', index === state.digits.length);
      if (filled && popIndex === index) {
        cell.classList.remove('is-filled');
        void cell.offsetWidth;
        cell.classList.add('is-filled');
      }
    });
  }

  function setHint(text, tone, withSpinner) {
    const hint = els.pairHint;
    if (!hint) return;
    hint.textContent = '';
    if (withSpinner) {
      const spinner = document.createElement('span');
      spinner.className = 'mini-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      hint.appendChild(spinner);
    }
    hint.appendChild(document.createTextNode(String(text || '')));
    if (tone) hint.dataset.tone = tone;
    else hint.removeAttribute('data-tone');
  }

  function setKeypadDisabled(disabled) {
    (els.keypadKeys || []).forEach((key) => {
      key.disabled = !!disabled;
      key.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
  }

  function setPairCardShaking() {
    if (!els.pairCard) return;
    els.pairCard.classList.add('is-shaking');
    if (els.pinRow) els.pinRow.classList.add('is-error');
    setTimeout(() => {
      els.pairCard.classList.remove('is-shaking');
      if (els.pinRow) els.pinRow.classList.remove('is-error');
    }, 1700);
  }

  function clearPin(focusFirst) {
    state.digits = '';
    renderPin();
    if (focusFirst) {
      els.pinCells.forEach((cell) => cell.classList.remove('is-active'));
      els.pinCells[0] && els.pinCells[0].classList.add('is-active');
    }
  }

  function showPairError(message) {
    setHint(message, 'error');
    setPairCardShaking();
    clearPin(true);
    setTimeout(() => {
      if (state.online !== false) setHint('输入桌面配对页显示的 6 位数字', 'info');
    }, 2000);
  }

  function showPairSuccess(visible, text) {
    if (!els.pairSuccess) return;
    if (text) els.pairSuccessText.textContent = text;
    if (visible) {
      els.pairSuccess.hidden = false;
      requestAnimationFrame(() => els.pairSuccess.classList.add('is-visible'));
    } else {
      els.pairSuccess.classList.remove('is-visible');
      setTimeout(() => {
        els.pairSuccess.hidden = true;
      }, 280);
    }
  }

  function showPairFallback(message) {
    if (!els.pairFallback) return;
    if (message) {
      els.pairFallback.hidden = false;
      if (els.pairFallbackText) els.pairFallbackText.textContent = message;
    } else {
      els.pairFallback.hidden = true;
    }
  }

  function startLockout(seconds) {
    const duration = clamp(Math.round(seconds) || DEFAULT_LOCKOUT_SECONDS, 1, 3600);
    state.lockedUntil = Date.now() + duration * 1000;
    clearPin(false);
    setKeypadDisabled(true);
    updateLockoutUi();
    if (state.lockTimer) clearInterval(state.lockTimer);
    state.lockTimer = setInterval(updateLockoutUi, 500);
  }

  function updateLockoutUi() {
    if (!state.lockedUntil) return;
    const left = Math.max(0, Math.ceil((state.lockedUntil - Date.now()) / 1000));
    if (left <= 0) {
      state.lockedUntil = 0;
      if (state.lockTimer) {
        clearInterval(state.lockTimer);
        state.lockTimer = null;
      }
      setKeypadDisabled(false);
      setHint('可以重新输入 PIN 了', 'info');
      clearPin(true);
      return;
    }
    setHint('尝试次数过多，请 ' + left + ' 秒后再试', 'warn');
    setKeypadDisabled(true);
  }

  function parseRetryAfter(headerValue, data) {
    const headerNumber = Number(headerValue);
    if (Number.isFinite(headerNumber) && headerNumber > 0) return Math.ceil(headerNumber);
    if (data && Number.isFinite(Number(data.retryAfterMs)) && Number(data.retryAfterMs) > 0) {
      return Math.ceil(Number(data.retryAfterMs) / 1000);
    }
    if (data && Number.isFinite(Number(data.retryAfter)) && Number(data.retryAfter) > 0) {
      return Math.ceil(Number(data.retryAfter));
    }
    return DEFAULT_LOCKOUT_SECONDS;
  }

  function pressDigit(digit) {
    if (state.busy || isLocked() || state.successBusy) return;
    if (state.digits.length >= 6) return;
    state.digits += digit;
    renderPin(state.digits.length - 1);
    if (state.digits.length === 6) {
      setHint('正在验证 PIN…', 'info', true);
      setTimeout(() => void submitPair(), 160);
    } else {
      setHint('继续输入…（6 位数字）', 'info');
    }
  }

  function pressBackspace() {
    if (state.busy || isLocked() || state.successBusy) return;
    if (!state.digits) return;
    state.digits = state.digits.slice(0, -1);
    renderPin();
    if (state.digits.length === 0) setHint('输入桌面配对页显示的 6 位数字', 'info');
    else setHint('继续输入…（6 位数字）', 'info');
  }

  /* ------------------------------------------------------------------ */
  /* pairing: token redemption + manual fallback                         */
  /* ------------------------------------------------------------------ */

  function redeemToken(url) {
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer = null;
      let hardTimer = null;
      const frame = document.createElement('iframe');

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (hardTimer) clearTimeout(hardTimer);
        try {
          frame.remove();
        } catch (_) {
          /* ignore */
        }
        resolve(ok);
      };

      const probe = async () => {
        if (settled) return false;
        try {
          const next = await fetchState();
          if (next.paired) {
            finish(true);
            return true;
          }
        } catch (_) {
          /* desktop unreachable: wait for the hard timeout */
        }
        return false;
      };

      try {
        frame.className = 'login-frame';
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.title = '登录中';
        document.body.appendChild(frame);
        frame.addEventListener('load', () => {
          void probe();
        });
        frame.src = url;
      } catch (_) {
        finish(false);
        return;
      }

      setTimeout(() => void probe(), TOKEN_REDEEM_WAIT_MS);
      pollTimer = setInterval(() => void probe(), 700);
      hardTimer = setTimeout(() => {
        void probe().finally(() => finish(false));
      }, TOKEN_REDEEM_TIMEOUT_MS);
    });
  }

  async function handlePairSuccess(url) {
    state.loginUrl = url;
    showPairSuccess(true, '正在进入桌面工作区…');
    setHint('配对成功，正在建立手机登录…', 'info', true);
    const redeemed = await redeemToken(url);
    if (redeemed) {
      state.forcePairing = false;
      state.successBusy = false;
      showPairSuccess(false);
      clearPin(false);
      enterChat('已连接到桌面 DSH');
      return;
    }
    state.successBusy = false;
    showPairSuccess(false);
    recordError('隐藏 iframe 登录超时');
    setHint('自动登录未完成，请使用手动登录', 'warn');
    showPairFallback('自动登录未完成（浏览器可能阻止了隐藏登录）。可点击「手动登录」在浏览器中完成登录，或重试自动登录。');
  }

  async function retryAutoLogin() {
    if (!state.loginUrl || state.busy) {
      setHint('登录地址缺失，请重新输入 PIN', 'error');
      return;
    }
    state.busy = true;
    setKeypadDisabled(true);
    showPairFallback(null);
    showPairSuccess(true, '正在重试自动登录…');
    setHint('正在重试自动登录…', 'info', true);
    try {
      const redeemed = await redeemToken(state.loginUrl);
      if (redeemed) {
        state.forcePairing = false;
        state.successBusy = false;
        showPairSuccess(false);
        enterChat('已连接到桌面 DSH');
      } else {
        setHint('自动登录仍未完成，请尝试手动登录', 'warn');
        showPairSuccess(false);
        showPairFallback('自动登录仍未完成，请点击「手动登录」在浏览器中完成登录。');
      }
    } finally {
      state.busy = false;
      setKeypadDisabled(isLocked());
    }
  }

  function manualLogin() {
    if (!state.loginUrl) {
      setHint('登录地址缺失，请重新输入 PIN', 'error');
      return;
    }
    try {
      window.location.href = state.loginUrl;
    } catch (_) {
      try {
        window.location.assign(state.loginUrl);
      } catch (__) {
        setHint('无法打开登录地址，请检查浏览器设置', 'error');
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* API: state probe / pairing / watchdog                               */
  /* ------------------------------------------------------------------ */

  async function fetchState() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STATE_TIMEOUT_MS);
    try {
      const started = nowMs();
      const response = await fetch(API.state, {
        method: 'GET',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('状态接口返回 HTTP ' + response.status);
      const data = await response.json();
      if (!data || data.ok !== true) throw new Error('状态接口返回无效数据');
      state.latencyMs = Math.round(nowMs() - started);
      return {
        paired: !!data.paired,
        host: typeof data.host === 'string' ? data.host : '',
        pinRequired: data.pinRequired !== false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function submitPair() {
    if (state.busy || isLocked() || state.digits.length !== 6) return;
    state.busy = true;
    setKeypadDisabled(true);
    showPairFallback(null);
    setHint('正在验证 PIN…', 'info', true);
    try {
      const response = await fetch(API.pair, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code: state.digits }),
      });
      let data = {};
      try {
        data = await response.json();
      } catch (_) {
        data = {};
      }

      if (response.status === 429 || data.error === 'locked') {
        recordError('配对尝试次数过多（429）');
        startLockout(parseRetryAfter(response.headers.get('retry-after'), data));
        return;
      }

      if (!response.ok || !data.ok) {
        if (response.status === 401 || data.error === 'bad-pin') {
          recordError('PIN 不正确');
          const attemptsLeft = Number(data.attemptsLeft);
          showPairError(
            Number.isFinite(attemptsLeft) && attemptsLeft > 0
              ? 'PIN 不正确，还可尝试 ' + attemptsLeft + ' 次'
              : 'PIN 不正确，请重新输入',
          );
          return;
        }
        if (response.status === 503 || data.error === 'pairing-unavailable') {
          recordError('桌面端配对功能不可用（503）');
          showPairError('桌面端配对功能不可用，请重启 DSH 后重试');
          return;
        }
        throw new Error('配对接口返回 HTTP ' + response.status);
      }

      if (typeof data.url !== 'string' || !data.url) throw new Error('配对接口未返回登录地址');

      state.successBusy = true;
      await handlePairSuccess(data.url);
    } catch (error) {
      // Network/timeout: keep the digits so the user can retry with one tap.
      const message = (error && error.message) || '网络错误';
      recordError('配对失败：' + message);
      setHint('无法连接桌面端，请检查网络后重试', 'error');
      setPairCardShaking();
      showOffline('无法完成配对：' + message);
    } finally {
      state.busy = false;
      setKeypadDisabled(isLocked());
    }
  }

  async function checkState(options) {
    const opts = options || {};
    if (state.checking) return;
    state.checking = true;
    state.lastCheckAt = Date.now();
    try {
      const next = await fetchState();
      state.online = true;
      state.host = next.host || state.host;
      state.pinRequired = next.pinRequired;
      hideOffline();
      const wasPaired = state.paired;
      state.paired = next.paired;
      updateConnectionUi();
      populateSettings();

      if (next.paired && !state.forcePairing) {
        state.booted = true;
        const target = state.currentScreen === 'settings' ? 'settings' : 'chat';
        if (state.currentScreen === 'boot' || state.currentScreen === 'pair') showScreen(target);
        if (target === 'chat') ensureFrame();
        return;
      }

      if (next.paired && state.forcePairing) {
        if (state.currentScreen === 'boot') showScreen('pair');
        return;
      }

      // not paired anymore
      const lostSession = wasPaired && !state.forcePairing;
      if (lostSession) {
        teardownFrame();
        state.booted = true;
        showScreen('pair');
        setHint('登录状态已失效，请输入桌面配对页面上的 PIN 重新连接', 'warn');
        if (!opts.silent) toast('登录状态已失效，需要重新配对');
        return;
      }

      state.booted = true;
      if (state.currentScreen === 'boot') {
        showScreen('pair');
        if (opts.initial) setHint('输入桌面配对页显示的 6 位数字', 'info');
      }
    } catch (error) {
      state.online = false;
      const message =
        error && error.name === 'AbortError' ? '连接桌面端超时' : (error && error.message) || '网络错误';
      recordError(message);
      updateConnectionUi();
      showOffline(
        opts.initial
          ? '无法连接桌面端 · 请确认 DSH 正在运行，且手机与电脑在同一 Wi-Fi'
          : null,
      );
      if (!state.booted) {
        state.booted = true;
        showScreen('pair');
      }
      if (!state.paired) {
        setHint('无法连接桌面端，请检查电脑上的 DSH 是否运行', 'error');
      }
    } finally {
      state.checking = false;
    }
  }

  function startWatchdog() {
    stopWatchdog();
    state.watchdogTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (state.busy || state.checking || state.successBusy) return;
      void checkState({ silent: true });
    }, WATCHDOG_INTERVAL_MS);
  }

  function stopWatchdog() {
    if (state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }
  }

  function onForeground() {
    if (document.hidden) return;
    if (Date.now() - state.lastCheckAt < 1200) return;
    if (state.busy) return;
    void checkState({ silent: true });
  }

  /* ------------------------------------------------------------------ */
  /* real DSH GUI iframe                                                 */
  /* ------------------------------------------------------------------ */

  function enterChat(message) {
    state.forcePairing = false;
    state.paired = true;
    state.booted = true;
    state.successBusy = false;
    updateConnectionUi();
    hideOffline();
    showScreen('chat');
    ensureFrame();
    if (message) toast(message);
  }

  function ensureFrame() {
    if (state.frameLoaded) return;
    loadFrame();
  }

  /** Actionable overlay when the GUI iframe never loads (bad address/network). */
  function showFrameError(message) {
    if (els.frameErrorText) els.frameErrorText.textContent = message;
    if (els.frameError) els.frameError.hidden = false;
  }

  function hideFrameError() {
    if (els.frameError) els.frameError.hidden = true;
  }

  function loadFrame() {
    const frame = els.guiFrame;
    if (!frame) return;
    if (state.frameLoadingTimer) {
      clearTimeout(state.frameLoadingTimer);
      state.frameLoadingTimer = null;
    }
    const wasLoaded = state.frameLoaded;
    state.frameLoaded = false;
    state.guiSessions = [];
    state.sessionScraped = false;
    state.guiSidebarExpanded = false;
    updateDockActive();
    if (els.frameLoading) els.frameLoading.classList.remove('is-done');
    if (els.frameLoadingText) els.frameLoadingText.textContent = '正在加载桌面界面…';

    let reloadedInPlace = false;
    if (wasLoaded) {
      try {
        frame.contentWindow.location.reload();
        reloadedInPlace = true;
      } catch (_) {
        reloadedInPlace = false;
      }
    }
    if (!reloadedInPlace) {
      try {
        frame.src = '/';
      } catch (error) {
        recordError('加载界面失败：' + ((error && error.message) || error));
      }
    }
    state.frameLoadingTimer = setTimeout(() => {
      if (state.frameLoaded) return;
      if (els.frameLoadingText) els.frameLoadingText.textContent = '加载时间较长…可点击刷新重试';
      recordError('桌面界面加载超时');
      showFrameError('桌面界面加载失败：请检查手机与电脑是否在同一 Wi-Fi，或服务器地址是否正确（外网访问需隧道在线）。');
    }, FRAME_LOAD_TIMEOUT_MS);
  }

  function teardownFrame() {
    hideFrameError();
    if (state.frameLoadingTimer) {
      clearTimeout(state.frameLoadingTimer);
      state.frameLoadingTimer = null;
    }
    state.frameLoaded = false;
    resetGuiScrollState();
    uninstallGuiDialogGuard();
    state.guiSessions = [];
    state.sessionScraped = false;
    state.guiSidebarOpened = false;
    state.guiSidebarExpanded = false;
    state.quickAvailable = { sidebar: null, newSession: null };
    for (const timer of state.quickProbeTimers) clearTimeout(timer);
    state.quickProbeTimers = [];
    closeDrawer();
    closeSheet();
    if (els.frameLoading) els.frameLoading.classList.remove('is-done');
    try {
      els.guiFrame.src = 'about:blank';
    } catch (_) {
      /* ignore */
    }
    if (state.themeObserver) {
      try {
        state.themeObserver.disconnect();
      } catch (_) {
        /* ignore */
      }
      state.themeObserver = null;
    }
  }

  function accessFrameDocument(frame) {
    try {
      return frame.contentDocument || null;
    } catch (_) {
      return null;
    }
  }

  function guiDocument() {
    if (!state.frameLoaded || !els.guiFrame) return null;
    return accessFrameDocument(els.guiFrame);
  }

    /** The chat composer lives in the iframe; when it gains focus the IME may resize the WebView. */
  function installComposerRefit(doc) {
    if (!doc || doc.__dshMobileComposerRefit) return;
    doc.__dshMobileComposerRefit = true;
    doc.addEventListener(
      'focusin',
      (event) => {
        const target = event && event.target;
        if (!target) return;
        const tag = String(target.tagName || '').toUpperCase();
        if (!(target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA')) return;
        refitAfterKeyboard();
        setTimeout(() => {
          try {
            if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
          } catch (_) {
            /* ignore */
          }
        }, 380);
      },
      { capture: true, passive: true },
    );
  }

  /** Blur any text input/contenteditable in the GUI (prevents the mobile keyboard popping by itself). */
  function blurGuiTextInput(doc) {
    try {
      const targetDoc = doc || guiDocument();
      if (!targetDoc) return;
      const active = targetDoc.activeElement;
      if (!active) return;
      const tag = String(active.tagName || '').toUpperCase();
      if (active.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA') active.blur();
    } catch (_) {
      /* ignore */
    }
  }

/** DSH returns 401 with an "authentication required" plain document. */
  function detectAuthPage(doc) {
    try {
      const title = String(doc.title || '').toLowerCase();
      if (title.indexOf('authentication required') >= 0) return true;
      if (title.indexOf('unauthorized') >= 0) return true;
      const body = doc.body;
      if (!body) return false;
      const text = String(body.innerText || body.textContent || '').toLowerCase();
      if (!text) return false;
      if (text.indexOf('authentication required') >= 0) return true;
      if (text.indexOf('unauthorized') >= 0) return true;
      if (text.indexOf('需要认证') >= 0) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function onFrameLoad() {
    const src = els.guiFrame.getAttribute('src') || '';
    if (!src || src === 'about:blank') return;
    state.frameLoaded = true;
    hideFrameError();
    if (state.frameLoadingTimer) {
      clearTimeout(state.frameLoadingTimer);
      state.frameLoadingTimer = null;
    }
    const doc = accessFrameDocument(els.guiFrame);
    if (!doc) {
      // Not same-origin for some reason: keep the frame, no injection possible.
      if (els.frameLoading) els.frameLoading.classList.add('is-done');
      state.online = true;
      updateConnectionUi();
      return;
    }
    if (detectAuthPage(doc)) {
      handleFrameAuthLost();
      return;
    }
    if (els.frameLoading) els.frameLoading.classList.add('is-done');
    state.online = true;
    updateConnectionUi();
    injectAdaptiveCss(els.guiFrame, 8);
    bindFrameThemeObserver(doc);
    bindGuiScrollListeners();
    installGuiDialogGuard(doc);
    installSidebarAutoClose(doc);
    installComposerRefit(doc);
    setTimeout(() => blurGuiTextInput(doc), 500);
    scheduleQuickActionProbe();
    syncDockSidebarState();
    state.capsuleHoldUntil = Date.now() + 1000;
    showCapsule();
    populateSettings();
  }

  function handleFrameAuthLost() {
    state.paired = false;
    teardownFrame();
    state.booted = true;
    updateConnectionUi();
    showScreen('pair');
    setHint('登录状态已失效，请输入桌面配对页面上的 PIN 重新连接', 'warn');
    toast('登录状态已失效，需要重新配对');
  }

  /* ------------------------------------------------------------------ */
  /* mobile adaptation CSS injected into the real GUI iframe             */
  /* ------------------------------------------------------------------ */

  /**
   * Non-destructive mobile CSS for the real DSH GUI. Uses stable data hooks of
   * the GUI layout (verified against DSH 0.2.1-rc.2 client sources):
   *   [data-shell-overlay] / [data-rightbar-col] → clamp to 100vw
   *   [data-shell-bottom] → composer seat, never hidden
   *   html[data-windows-titlebar] → Electron-only caption strip, neutralised
   * plus 100dvh, safe-area variables, touch behaviour, >=16px inputs and the
   * optional interface scale (font-size slider) applied as CSS zoom.
   *
   * v0.3.6 sidebar simplification (Lead-verified against the real GUI with
   * headless Chrome): the collapsed 56px icon rail is hidden *visually* while
   * keeping the grid placeholder alive (visibility:hidden, NOT display:none —
   * display:none breaks grid auto-placement and blanks the centre column).
   * The expanded sidebar keeps only the workspace content: brand/new-session
   * row, plugin/automation/account panel rows are hidden.
   */
  function buildAdaptiveCss() {
    const scale = (Number(state.scale) || 100) / 100;
    const scaleRule = scale === 1 ? '' : 'html.dsh-mobile { zoom: ' + scale + '; }';
    const appVars =
      'html.dsh-mobile { --dsh-mobile-app-top: ' +
      (state.appMode ? state.nativeTopInset : 0) +
      'px; --dsh-mobile-app-bottom: ' +
      (state.appMode ? state.nativeBottomInset : 0) +
      'px; --dsh-mobile-app-mode: ' +
      (state.appMode ? '1' : '0') +
      '; }';
    const lines = [
      '/* injected by DSH Mobile shell — mobile adaptation (non-destructive) */',
      'html.dsh-mobile, html.dsh-mobile body, html.dsh-mobile #root { height: 100%; min-height: 100%; }',
      '@supports (height: 100dvh) { html.dsh-mobile, html.dsh-mobile body, html.dsh-mobile #root { height: 100dvh; } }',
      'html.dsh-mobile body { overflow-x: hidden; overscroll-behavior: none; -webkit-text-size-adjust: 100%; touch-action: manipulation; }',
      'html.dsh-mobile { touch-action: manipulation; }',
      'html.dsh-mobile { --dsh-mobile-safe-top: env(safe-area-inset-top, 0px); --dsh-mobile-safe-bottom: env(safe-area-inset-bottom, 0px); --dsh-mobile-safe-left: env(safe-area-inset-left, 0px); --dsh-mobile-safe-right: env(safe-area-inset-right, 0px); }',
      appVars,
      'html.dsh-mobile[data-windows-titlebar] { --dsh-windows-titlebar-height: 0px; --dsh-frame-top-clearance: 0px; --dsh-frame-chrome-top: 0px; }',
      'html.dsh-mobile [data-shell-overlay] { max-width: 100vw; }',
      'html.dsh-mobile [data-rightbar-col] { max-width: 100vw !important; }',
      'html.dsh-mobile [data-rightbar-col] > * { max-width: 100%; }',
      'html.dsh-mobile *, html.dsh-mobile button, html.dsh-mobile a { -webkit-tap-highlight-color: transparent; }',
      'html.dsh-mobile [data-shell-bottom] { visibility: visible; }',
      // v0.3.6 — hide collapsed rail and reclaim its width (keep grid placeholder)
      'html.dsh-mobile [data-sidebar-collapsed="true"] { grid-template-columns: 0px minmax(0px, 1fr) minmax(0px, 0px) !important; }',
      'html.dsh-mobile [data-sidebar-collapsed="true"] > :first-child { visibility: hidden !important; overflow: hidden !important; min-width: 0 !important; }',
      // v0.3.6 — expanded sidebar: workspace content only
      'html.dsh-mobile [class*="brand"] { display: none !important; }',
      'html.dsh-mobile [class*="newSession"] { display: none !important; }',
      'html.dsh-mobile [class*="panelRow"] { display: none !important; }',
      'html.dsh-mobile [aria-label="插件"], html.dsh-mobile [aria-label="自动化任务"], html.dsh-mobile [aria-label="账号菜单"] { display: none !important; }',
      // v0.3.7: hide the GUI's top-right right-sidebar toggles on phones (declutter the top edge).
      'html.dsh-mobile [aria-label="打开右侧边栏"], html.dsh-mobile [aria-label="收起右侧边栏"], html.dsh-mobile [aria-label="Open right sidebar"], html.dsh-mobile [aria-label="Close right sidebar"] { display: none !important; }',
      // v0.3.12: restore the session header chips but let them wrap onto multiple lines
      // on phones (智能体团队 / 标准模式 / 子智能体 / 后台任务) instead of clipping.
      'html.dsh-mobile header [class*="titleRow"] { flex-wrap: wrap !important; }',
      'html.dsh-mobile header [class*="titleCluster"] { flex-wrap: wrap !important; }',
      'html.dsh-mobile header [class*="titleCluster"] [class*="headerActions"] { display: flex !important; flex-wrap: wrap !important; align-items: center !important; gap: 2px 6px !important; flex: 0 0 100% !important; width: 100% !important; max-width: 100% !important; }',
      'html.dsh-mobile header [class*="headerActions"] button, html.dsh-mobile header [class*="headerActions"] span { flex: 0 0 auto !important; white-space: nowrap !important; }',
      'html.dsh-mobile [data-slot="conversation.session.header.actions"] { display: contents !important; }',
      // v0.3.9: remove the two header dropdowns — open-in-file-explorer split button and
      // the "更多操作" menu (下载 Session 日志 / 反馈).
      'html.dsh-mobile [data-slot="conversation.session.header.utilities"] { display: none !important; }',
      'html.dsh-mobile [class*="headerUtilities"] { display: none !important; }',
      // v0.3.6 — hide known desktop-native-dialog entries (static CSS layer)
      'html.dsh-mobile ' +
        DESKTOP_DIALOG_HIDE_SELECTORS.join(', html.dsh-mobile ') +
        ' { display: none !important; }',
      // v0.3.6 — elements flagged by the JS guard (dynamic menus etc.)
      'html.dsh-mobile [' + GUARDED_ACTION_ATTR + '="1"] { display: none !important; }',
      '@media (pointer: coarse) { html.dsh-mobile input, html.dsh-mobile textarea, html.dsh-mobile select, html.dsh-mobile [contenteditable="true"] { font-size: max(16px, 1em) !important; } }',
      '@media (pointer: coarse) { html.dsh-mobile body { --dsh-content-font-size: 15px !important; --dsh-code-font-size: 12px !important; } }',
      scaleRule,
      '',
    ];
    return lines.join('\n');
  }

  function injectAdaptiveCss(frame, retriesLeft) {
    const attempts = typeof retriesLeft === 'number' ? retriesLeft : 4;
    const doc = accessFrameDocument(frame);
    if (!doc || !doc.documentElement) {
      if (attempts > 0) setTimeout(() => injectAdaptiveCss(frame, attempts - 1), 300);
      return;
    }
    try {
      let style = doc.getElementById(STYLE_ID);
      if (!style) {
        style = doc.createElement('style');
        style.id = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
      }
      style.textContent = buildAdaptiveCss();
      doc.documentElement.classList.add('dsh-mobile');
      if (state.appMode) doc.documentElement.classList.add('dsh-app-embed');
      syncFrameTheme(doc);
    } catch (_) {
      /* ignore: cross-origin (should not happen) or head unavailable yet */
    }
    if (attempts > 0) {
      // SPA may still be booting: re-apply a few times (idempotent)
      setTimeout(() => injectAdaptiveCss(frame, attempts - 1), 350);
    }
  }

  function syncFrameTheme(doc) {
    try {
      const body = doc.body;
      const dark = body ? body.hasAttribute('data-ds-dark-theme') : true;
      if (els.frameHost) els.frameHost.style.setProperty('--frame-bg', dark ? '#151517' : '#ffffff');
      if (els.guiFrame) els.guiFrame.style.background = dark ? '#151517' : '#ffffff';
    } catch (_) {
      /* ignore */
    }
  }

  function bindFrameThemeObserver(doc) {
    if (state.themeObserver) {
      try {
        state.themeObserver.disconnect();
      } catch (_) {
        /* ignore */
      }
      state.themeObserver = null;
    }
    try {
      if (!doc.body || typeof MutationObserver !== 'function') return;
      state.themeObserver = new MutationObserver(() => syncFrameTheme(doc));
      state.themeObserver.observe(doc.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ */
  /* v0.3.6 desktop-dialog guard (runs against the real GUI iframe DOM)   */
  /* ------------------------------------------------------------------ */

  const GUARDED_ACTION_SELECTOR =
    'button, a, [role="menuitem"], [role="button"], [role="option"], [role="link"]';

  /** Never touch session rows or the composer (they may contain similar words). */
  function isGuiSessionOrComposer(element) {
    try {
      return !!element.closest(
        '[class*="session"], [class*="Session"], [data-shell-bottom], [class*="composer"], [class*="Composer"]',
      );
    } catch (_) {
      return false;
    }
  }

  function guardedActionLabel(element) {
    if (!element || !element.getAttribute) return '';
    const aria = element.getAttribute('aria-label') || '';
    const title = element.getAttribute('title') || '';
    const keys = element.getAttribute('aria-keyshortcuts') || '';
    const text = String(element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    return [aria, title, keys, text].filter(Boolean).join(' | ');
  }

  function guiBodyText(doc) {
    try {
      const body = doc && doc.body;
      if (!body) return '';
      return String(body.innerText || body.textContent || '').replace(/\s+/g, ' ');
    } catch (_) {
      return '';
    }
  }

  /** Is the DSH GUI currently showing the "no workspace yet" empty state? */
  function guiHasEmptyWorkspaceState(doc) {
    return EMPTY_WORKSPACE_STATE_PATTERN.test(guiBodyText(doc));
  }

  /**
   * Is this element the workspace chooser in the empty state? In that state a
   * click opens the desktop native directory picker, so it must be guarded
   * even though 「选择工作区」 is normally whitelisted.
   */
  function isWorkspaceChooserInEmptyState(element, emptyState) {
    if (!element || typeof element.getAttribute !== 'function') return false;
    const text = String(element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const aria = String(element.getAttribute('aria-label') || '').trim();
    const chooser =
      WORKSPACE_CHOOSER_TEXT_PATTERN.test(text) ||
      WORKSPACE_CHOOSER_TEXT_PATTERN.test(aria) ||
      /^选择工作区$/i.test(aria);
    if (!chooser) return false;
    // A real workspace name is displayed (live GUI: 默认工作区) -> keep usable.
    if (text && !WORKSPACE_CHOOSER_TEXT_PATTERN.test(text) && /工作区/.test(text)) return false;
    // Workspaces exist and this is a normal dropdown trigger -> keep usable.
    if (
      !emptyState &&
      (element.getAttribute('aria-haspopup') === 'menu' || element.getAttribute('aria-expanded') !== null)
    ) {
      return false;
    }
    return true;
  }

  /** Returns the closest actionable element when it is a desktop-dialog action. */
  function matchGuardedAction(rawTarget, options) {
    let element = rawTarget;
    try {
      if (!element || !element.closest) return null;
      element = element.closest(GUARDED_ACTION_SELECTOR);
    } catch (_) {
      return null;
    }
    if (!element) return null;
    const opts = options || {};
    const emptyState =
      typeof opts.emptyState === 'boolean'
        ? opts.emptyState
        : guiHasEmptyWorkspaceState(element.ownerDocument || state.guiDialogGuardDoc);
    // v0.3.6: the empty-state 「选择工作区」chooser lives INSIDE the composer
    // region (ancestor chain contains composerStack[data-conversation-region]).
    // Check it before the composer/session exclusion, otherwise it would be
    // filtered out before reaching the empty-state branch.
    if (isWorkspaceChooserInEmptyState(element, emptyState)) return element;
    if (isGuiSessionOrComposer(element)) return null;
    const label = guardedActionLabel(element);
    if (label && DESKTOP_DIALOG_PATTERN.test(label)) return element;
    return null;
  }

  /** Original inline state of guarded elements, so stale marks can be undone. */
  const guardedElementSnapshots = new WeakMap();

  function markGuardedAction(element) {
    if (!element || element.getAttribute(GUARDED_ACTION_ATTR) === '1') return false;
    try {
      if (!guardedElementSnapshots.has(element)) {
        guardedElementSnapshots.set(element, {
          ariaHidden: element.getAttribute('aria-hidden'),
          display: element.style ? element.style.display : '',
        });
      }
      element.setAttribute(GUARDED_ACTION_ATTR, '1');
      element.setAttribute('aria-hidden', 'true');
      element.style.display = 'none';
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  /**
   * v0.3.6: undo a stale guard mark. The workspace data can arrive after the
   * first empty-state render (chooser text 选择工作区 -> 默认工作区), so the
   * same element may no longer qualify as a desktop-dialog action. Restore the
   * original aria-hidden/inline display instead of permanently hiding it.
   */
  function unmarkGuardedAction(element) {
    if (!element || element.getAttribute(GUARDED_ACTION_ATTR) !== '1') return false;
    try {
      const snapshot = guardedElementSnapshots.get(element);
      element.removeAttribute(GUARDED_ACTION_ATTR);
      if (snapshot && snapshot.ariaHidden !== null && snapshot.ariaHidden !== undefined) {
        element.setAttribute('aria-hidden', snapshot.ariaHidden);
      } else {
        element.removeAttribute('aria-hidden');
      }
      if (element.style) {
        if (typeof element.style.removeProperty === 'function') element.style.removeProperty('display');
        element.style.display = snapshot && snapshot.display ? snapshot.display : '';
      }
      guardedElementSnapshots.delete(element);
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  /**
   * Mark every currently rendered desktop-dialog entry (static + menus), and
   * unmark stale entries that no longer match (early empty-state render that
   * became a real workspace trigger after the workspace data loaded).
   */
  function scanGuardedGuiActions(doc) {
    const target = doc || state.guiDialogGuardDoc || guiDocument();
    if (!target || !target.querySelectorAll) return 0;
    let marked = 0;
    let unmarked = 0;
    try {
      const emptyState = guiHasEmptyWorkspaceState(target);
      // 1) unmark stale guards first, using the CURRENT page state
      for (const element of target.querySelectorAll('[' + GUARDED_ACTION_ATTR + '="1"]')) {
        if (matchGuardedAction(element, { emptyState })) continue;
        if (unmarkGuardedAction(element)) unmarked += 1;
      }
      // 2) mark everything that currently qualifies
      const candidates = target.querySelectorAll(GUARDED_ACTION_SELECTOR);
      for (const candidate of candidates) {
        if (candidate.getAttribute(GUARDED_ACTION_ATTR) === '1') continue;
        if (!matchGuardedAction(candidate, { emptyState })) continue;
        if (markGuardedAction(candidate)) marked += 1;
      }
      if (unmarked > 0) state.lastUnblockedCount = unmarked;
    } catch (_) {
      /* ignore */
    }
    return marked;
  }

  function scheduleGuardedScan(doc) {
    if (state.guiDialogScanTimer) return;
    state.guiDialogScanTimer = setTimeout(() => {
      state.guiDialogScanTimer = null;
      scanGuardedGuiActions(doc || state.guiDialogGuardDoc);
    }, 120);
  }

  /** Dynamic dropdown / popover menus are injected after a click. */
  function setupGuardedActionObserver(doc) {
    if (!doc || typeof MutationObserver !== 'function') return;
    try {
      if (state.guiDialogObserver) state.guiDialogObserver.disconnect();
      state.guiDialogObserver = new MutationObserver(() => scheduleGuardedScan(doc));
      state.guiDialogObserver.observe(doc.body || doc.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (_) {
      state.guiDialogObserver = null;
    }
  }

  function notifyBlockedAction(label, toastText) {
    state.lastBlockedAction = String(label || '');
    const now = Date.now();
    if (now - state.lastBlockedToastAt < 700) return; // avoid repeat toasts
    state.lastBlockedToastAt = now;
    const text = toastText || MOBILE_BLOCKED_TOAST_TEXT;
    try {
      const shellWindow = typeof window.parent !== 'undefined' && window.parent ? window.parent : window;
      shellWindow.postMessage(
        {
          type: MOBILE_TOAST_MESSAGE_TYPE,
          text,
          action: state.lastBlockedAction,
        },
        '*',
      );
    } catch (_) {
      toast(text);
    }
  }

  function blockGuardedAction(event, element) {
    if (event) {
      try {
        event.preventDefault();
      } catch (_) {
        /* ignore */
      }
      try {
        event.stopPropagation();
      } catch (_) {
        /* ignore */
      }
      try {
        event.stopImmediatePropagation();
      } catch (_) {
        /* ignore */
      }
    }
    const doc = (element && element.ownerDocument) || state.guiDialogGuardDoc;
    const emptyWorkspace = isWorkspaceChooserInEmptyState(element, guiHasEmptyWorkspaceState(doc));
    notifyBlockedAction(
      guardedActionLabel(element) || element.textContent || '',
      emptyWorkspace ? EMPTY_WORKSPACE_BLOCKED_TOAST_TEXT : MOBILE_BLOCKED_TOAST_TEXT,
    );
  }

  function onGuardedClickCapture(event) {
    try {
      const matched = matchGuardedAction(event.target);
      if (matched) {
        blockGuardedAction(event, matched);
        return;
      }
      // A non-blocked click may have opened a dropdown: scan its items shortly.
      scheduleGuardedScan(state.guiDialogGuardDoc);
    } catch (_) {
      /* ignore */
    }
  }

  function onGuardedPointerCapture(event) {
    try {
      const matched = matchGuardedAction(event.target);
      if (matched) blockGuardedAction(event, matched);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Mobile UX: picking a session in the real GUI sidebar should switch to that
   * chat and then collapse the sidebar (desktop DSH keeps it open). Workspace
   * rows and other controls are left untouched.
   */
  function installSidebarAutoClose(doc) {
    if (!doc || doc.__dshMobileSidebarAutoClose) return;
    doc.__dshMobileSidebarAutoClose = true;
    doc.addEventListener(
      'click',
      (event) => {
        let row = null;
        try {
          row = event.target && event.target.closest ? event.target.closest('[data-row-key^="session:"]') : null;
        } catch (_) {
          row = null;
        }
        if (!row) return;
        setTimeout(() => {
          if (!state.frameLoaded || !guiSidebarExpanded()) return;
          const closeToggle =
            doc.querySelector('button[aria-label="收起侧边栏"]') ||
            doc.querySelector('button[aria-label="Collapse sidebar"]');
          if (!closeToggle) return;
          try {
            closeToggle.click();
          } catch (_) {
            return;
          }
          state.guiSidebarExpanded = false;
          updateDockActive();
          setTimeout(() => {
            syncDockSidebarState();
            populateSettings();
            blurGuiTextInput(doc);
          }, 450);
          setTimeout(() => blurGuiTextInput(doc), 280);
        }, 160);
      },
      { capture: true, passive: true },
    );
  }

  function installGuiDialogGuard(doc) {
    if (!doc || state.guiDialogGuardDoc === doc) return;
    state.guiDialogGuardDoc = doc;
    try {
      doc.addEventListener('click', onGuardedClickCapture, true);
      doc.addEventListener('pointerdown', onGuardedPointerCapture, true);
    } catch (_) {
      /* ignore */
    }
    setupGuardedActionObserver(doc);
    scanGuardedGuiActions(doc);
    // Workspace data often arrives after first paint: re-scan (mark + unmark)
    // a few times so an early empty-state mark is reverted once it is ready.
    for (const delay of [0, 400, 800, 1200, 1600, 2600, 3200]) {
      setTimeout(() => {
        if (state.guiDialogGuardDoc === doc) scanGuardedGuiActions(doc);
      }, delay);
    }
  }

  function uninstallGuiDialogGuard() {
    if (state.guiDialogScanTimer) {
      clearTimeout(state.guiDialogScanTimer);
      state.guiDialogScanTimer = null;
    }
    if (state.guiDialogObserver) {
      try {
        state.guiDialogObserver.disconnect();
      } catch (_) {
        /* ignore */
      }
      state.guiDialogObserver = null;
    }
    state.guiDialogGuardDoc = null;
  }

  /* ------------------------------------------------------------------ */
  /* capsule auto-hide on GUI scroll + reveal pill                       */
  /* ------------------------------------------------------------------ */

  function showCapsule() {
    state.capsuleHidden = false;
    if (els.app) els.app.dataset.capsule = 'shown';
  }

  function hideCapsule() {
    if (state.currentScreen !== 'chat') return;
    state.capsuleHidden = true;
    if (els.app) els.app.dataset.capsule = 'hidden';
  }

  function bindGuiScrollListeners() {
    const doc = accessFrameDocument(els.guiFrame);
    if (!doc || state.iframeScrollBound) return;
    try {
      doc.addEventListener('scroll', onGuiScrollEvent, { capture: true, passive: true });
      doc.addEventListener('click', onGuiClickCapture, { capture: true, passive: true });
      if (doc.defaultView) doc.defaultView.addEventListener('scroll', onGuiWindowScroll, { passive: true });
      state.iframeScrollBound = true;
    } catch (_) {
      state.iframeScrollBound = false;
    }
  }

  function resetGuiScrollState() {
    state.iframeScrollBound = false;
    scrollTopByTarget = new WeakMap();
  }

  function onGuiScrollEvent(event) {
    const target = event && event.target;
    if (!target || typeof target.scrollTop !== 'number') return;
    onGuiScrolled(target, target.scrollTop);
  }

  function onGuiWindowScroll() {
    const doc = accessFrameDocument(els.guiFrame);
    const win = doc && doc.defaultView;
    if (!win) return;
    onGuiScrolled(win, win.scrollY || 0);
  }

  /**
   * Any click inside the GUI is a candidate for a native sidebar toggle (e.g.
   * tapping the GUI's own scrim to close the sidebar): refresh the Dock 会话
   * selection state shortly after, once the SPA has re-rendered.
   */
  function onGuiClickCapture() {
    setTimeout(syncDockSidebarState, 350);
  }

  function onGuiScrolled(target, top) {
    if (state.appMode) return; // APK mode: capsule only on demand
    const previous = scrollTopByTarget.get(target);
    scrollTopByTarget.set(target, top);
    if (Date.now() < state.capsuleHoldUntil) return;
    if (top <= 8 && state.capsuleHidden) {
      showCapsule();
      return;
    }
    if (previous === undefined) return;
    const delta = top - previous;
    if (delta > 8) hideCapsule();
    else if (delta < -8) showCapsule();
  }

  /* ------------------------------------------------------------------ */
  /* APK full-screen mode                                                */
  /* ------------------------------------------------------------------ */

  function applyAppMode() {
    if (els.app) els.app.dataset.mode = state.appMode ? 'apk' : 'browser';
    state.nativeAvailable = !!nativeBridge();
    if (!state.appMode) return;
    try {
      document.documentElement.classList.add('dsh-app');
    } catch (_) {
      /* ignore */
    }
    applyNativeInsets();
    setupAppHandleGestures();
    if (hasNativeMethod('openSettings')) {
      if (els.appSettingsBtn) els.appSettingsBtn.hidden = false;
      if (els.settingsNativeSettings) els.settingsNativeSettings.hidden = false;
    }
    setBarsHidden(true);
  }

  /** Android WebView insets → CSS vars (DshApp first, env() probe fallback). */
  function applyNativeInsets() {
    const reportedTop = Number(callNative('getTopInsetPx'));
    let nativeTop = 0;
    if (Number.isFinite(reportedTop) && reportedTop > 0) nativeTop = reportedTop;
    const envTop = readEnvInset('top');
    const envBottom = readEnvInset('bottom');
    state.nativeTopInset = Math.round(clamp(Math.max(nativeTop, envTop), 0, 200));
    state.nativeBottomInset = Math.round(clamp(envBottom, 0, 160));
    try {
      document.documentElement.style.setProperty('--apk-top-inset', state.nativeTopInset + 'px');
      document.documentElement.style.setProperty('--apk-bottom-inset', state.nativeBottomInset + 'px');
    } catch (_) {
      /* ignore */
    }
    if (state.frameLoaded) injectAdaptiveCss(els.guiFrame, 0);
  }

  function setBarsHidden(hidden) {
    state.barsHidden = !!hidden;
    if (els.app) els.app.dataset.bars = hidden ? 'hidden' : 'shown';
    if (hidden) {
      cancelBarAutoHide();
      closeSheet();
    }
  }

  function revealBars() {
    cancelBarAutoHide();
    setBarsHidden(false);
    scheduleBarAutoHide();
  }

  function scheduleBarAutoHide() {
    cancelBarAutoHide();
    state.barsAutohideTimer = setTimeout(() => {
      state.barsAutohideTimer = null;
      if (state.appMode && state.currentScreen === 'chat' && !state.keyboardOpen) setBarsHidden(true);
    }, APK_BAR_AUTO_HIDE_MS);
  }

  function cancelBarAutoHide() {
    if (state.barsAutohideTimer) {
      clearTimeout(state.barsAutohideTimer);
      state.barsAutohideTimer = null;
    }
  }

  /**
   * APK recoverable entry: a non-occupying hotzone at the top edge.
   * tap = reveal capsule, double-tap/long-press = settings diagnostics,
   * swipe-down = reveal capsule.
   */
  function setupAppHandleGestures() {
    const handle = els.appHandle;
    if (!handle) return;
    let pressTimer = null;
    let longPressed = false;
    let startY = 0;
    const clearPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    handle.addEventListener('click', () => {
      if (longPressed) {
        longPressed = false;
        return;
      }
      revealBars();
    });
    handle.addEventListener('dblclick', () => {
      revealBars();
      openSettings({ focusDiagnostics: true });
    });
    handle.addEventListener('pointerdown', (event) => {
      longPressed = false;
      startY = Number(event.clientY) || 0;
      clearPress();
      pressTimer = setTimeout(() => {
        longPressed = true;
        revealBars();
        openSettings({ focusDiagnostics: true });
      }, 750);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!startY) return;
      if ((Number(event.clientY) || 0) - startY > 26) {
        clearPress();
        startY = 0;
        revealBars();
      }
    });
    handle.addEventListener('pointerup', () => {
      clearPress();
      startY = 0;
    });
    handle.addEventListener('pointercancel', () => {
      clearPress();
      startY = 0;
    });
  }

  /* ------------------------------------------------------------------ */
  /* quick actions mapped to the real GUI                                */
  /* ------------------------------------------------------------------ */

  function resolveGuiAction(kind) {
    const doc = guiDocument();
    if (!doc) return null;
    const selectors = GUI_ACTION_SELECTORS[kind] || [];
    for (const selector of selectors) {
      try {
        const found = doc.querySelector(selector);
        if (found && found.disabled !== true && found.getAttribute('aria-disabled') !== 'true') {
          return found;
        }
      } catch (_) {
        /* ignore */
      }
    }
    const pattern = GUI_ACTION_PATTERNS[kind];
    if (!pattern) return null;
    try {
      const candidates = doc.querySelectorAll('button, [role="button"]');
      for (const candidate of candidates) {
        if (!candidate || candidate.disabled === true) continue;
        if (candidate.getAttribute('aria-disabled') === 'true') continue;
        const label = String(
          (candidate.getAttribute('aria-label') || '') + ' ' + (candidate.getAttribute('title') || ''),
        ).trim();
        if (label && pattern.test(label)) return candidate;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function refreshQuickAvailable() {
    const sidebar = resolveGuiAction('sidebar');
    const newSession = resolveGuiAction('newSession');
    state.quickAvailable = { sidebar: !!sidebar, newSession: !!newSession };
    const dockNew = document.querySelector('.dock-btn[data-dock="new"]');
    if (dockNew) {
      dockNew.classList.toggle('is-unavailable', state.frameLoaded && !newSession);
    }
    if (els.settingsQuick) {
      els.settingsQuick.textContent = state.frameLoaded
        ? '侧栏 ' + (sidebar ? '✓' : '—') + ' · 新会话 ' + (newSession ? '✓' : '—')
        : '未加载';
    }
    state.guiSidebarExpanded = guiSidebarExpanded();
    updateDockActive();
    return state.quickAvailable;
  }

  function scheduleQuickActionProbe() {
    for (const timer of state.quickProbeTimers) clearTimeout(timer);
    state.quickProbeTimers = [];
    for (const delay of [0, 400, 1200, 2600]) {
      state.quickProbeTimers.push(
        setTimeout(() => {
          if (state.currentScreen === 'chat' && state.frameLoaded) refreshQuickAvailable();
        }, delay),
      );
    }
  }

  /** Click a real GUI control; returns false when it cannot be resolved. */
  function clickGuiAction(kind) {
    const target = resolveGuiAction(kind);
    if (!target) {
      refreshQuickAvailable();
      return false;
    }
    try {
      target.click();
    } catch (_) {
      return false;
    }
    setTimeout(refreshQuickAvailable, 600);
    return true;
  }

  /**
   * v0.3.6 sidebar UX helpers.
   *
   * DOM facts (real DSH GUI, verified): the layout frame carries
   * `data-sidebar-collapsed="true"` while collapsed (attribute disappears when
   * expanded); its first child is the 56px sidebar rail; the toggle button's
   * aria-label switches between 打开侧边栏 / 收起侧边栏.
   */
  function guiSidebarExpanded() {
    const doc = guiDocument();
    if (!doc) return false;
    try {
      if (
        doc.querySelector('button[aria-label="收起侧边栏"]') ||
        doc.querySelector('button[aria-label="Collapse sidebar"]')
      ) {
        return true;
      }
      const collapsedFrame =
        doc.querySelector('[data-sidebar-collapsed="true"]') || doc.querySelector('[data-sidebar-collapsed]');
      if (collapsedFrame) return false;
      // No markers at all: assume expanded so the next tap closes it.
      return !(
        doc.querySelector('button[aria-label="打开侧边栏"]') ||
        doc.querySelector('button[aria-label="Open sidebar"]')
      );
    } catch (_) {
      return false;
    }
  }

  /** Reflect the REAL sidebar state on the Dock 会话 selection indicator. */
  function syncDockSidebarState() {
    const expanded = guiSidebarExpanded();
    const changed = expanded !== state.guiSidebarExpanded;
    state.guiSidebarExpanded = expanded;
    if (changed) updateDockActive();
    return expanded;
  }

  /** Dock 会话: toggle the real GUI sidebar (open ↔ close). */
  function toggleGuiSidebar() {
    if (!state.frameLoaded || !guiDocument()) return false;
    const expandedBefore = guiSidebarExpanded();
    const clicked = clickGuiAction('sidebar');
    if (!clicked) {
      refreshQuickAvailable();
      return false;
    }
    state.guiSidebarExpanded = !expandedBefore;
    updateDockActive();
    setTimeout(() => {
      syncDockSidebarState();
      populateSettings();
    }, 550);
    return true;
  }

  /**
   * Sessions entry used by Dock 会话 and the quick-sheet 会话列表 action:
   * toggle the real GUI sidebar; only when that toggle cannot be resolved
   * (or the GUI is still loading) fall back to the shell session drawer.
   */
  function activateSessionsEntry() {
    if (state.frameLoaded && toggleGuiSidebar()) return;
    openDrawer();
    if (state.frameLoaded) toast('无法切换桌面侧边栏，已打开会话抽屉');
  }

  /* ------------------------------------------------------------------ */
  /* session drawer                                                      */
  /* ------------------------------------------------------------------ */

  const SIDEBAR_KNOWN_LABELS =
    /(打开侧边栏|收起侧边栏|新建会话|全局面板|插件|自动化任务|账号菜单|添加工作区|打开工作区|新建工作区|打开文件夹|打开目录|选择文件夹|选择目录|打开方式|open sidebar|collapse sidebar|new session|global panels|plugins?|automations?|account menu|add workspace|open workspace|new workspace|open folder|open directory)/i;
  /** sidebars also contain workspace/settings/help chrome: never show those as sessions */
  const SIDEBAR_GENERIC_LABELS =
    /^(?:新会话|新建会话|设置|偏好设置|帮助|关于|菜单|搜索|会话|工作区|切换工作区|账户|登录|退出登录|选择工作区|上传文件|添加文件|附件|settings?|help|about|menu|search|workspaces?|account|log ?out|sign out|choose workspace|upload(?: file)?|attach(?: file)?)$/i;

  function showScrim() {
    if (!els.scrim) return;
    els.scrim.hidden = false;
    requestAnimationFrame(() => els.scrim.classList.add('is-visible'));
  }

  function hideScrim() {
    if (!els.scrim) return;
    els.scrim.classList.remove('is-visible');
    setTimeout(() => {
      if (!state.drawerOpen && !state.sheetOpen) els.scrim.hidden = true;
    }, 260);
  }

  function updateDockActive() {
    $$('.dock-btn').forEach((button) => {
      const action = button.dataset.dock;
      button.classList.toggle(
        'is-active',
        (action === 'sessions' && (state.drawerOpen || state.guiSidebarExpanded)) ||
          (action === 'more' && state.sheetOpen),
      );
    });
  }

  function openDrawer() {
    if (state.currentScreen !== 'chat') return;
    if (state.sheetOpen) closeSheet();
    state.drawerOpen = true;
    if (els.drawer) {
      els.drawer.classList.add('is-open');
      els.drawer.setAttribute('aria-hidden', 'false');
    }
    showScrim();
    updateDockActive();
    renderDrawerSessions();
    if (state.frameLoaded) {
      setTimeout(() => void scrapeAndRenderSessions(), 120);
      setTimeout(() => void scrapeAndRenderSessions(), 900);
    }
  }

  function closeDrawer() {
    if (!state.drawerOpen) return;
    state.drawerOpen = false;
    if (els.drawer) {
      els.drawer.classList.remove('is-open');
      els.drawer.setAttribute('aria-hidden', 'true');
    }
    hideScrim();
    updateDockActive();
  }

  function renderDrawerSessions() {
    if (!els.sessionList) return;
    els.sessionList.textContent = '';
    const sessions = state.guiSessions || [];
    if (sessions.length === 0) {
      if (els.drawerSubtitle) els.drawerSubtitle.textContent = '最近会话';
      let noteText;
      if (!state.frameLoaded) {
        if (els.drawerFallback) els.drawerFallback.hidden = false;
        noteText = '桌面界面尚未加载，配对成功后即可查看会话。';
      } else if (state.sessionScraped) {
        if (els.drawerFallback) els.drawerFallback.hidden = false;
        noteText = '未能读取桌面会话标题，可通过下方入口打开桌面会话列表。';
      } else {
        if (els.drawerFallback) els.drawerFallback.hidden = true;
        noteText = '正在读取桌面会话…';
      }
      const note = document.createElement('p');
      note.className = 'drawer-note';
      note.textContent = noteText;
      els.sessionList.appendChild(note);
      return;
    }
    if (els.drawerFallback) els.drawerFallback.hidden = true;
    if (els.drawerSubtitle) els.drawerSubtitle.textContent = sessions.length + ' 个最近会话';
    sessions.forEach((session, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-item';
      button.dataset.sessionItem = 'true';

      const icon = document.createElement('span');
      icon.className = 'session-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = (session.title || 'D').trim().slice(0, 1) || 'D';

      const main = document.createElement('span');
      main.className = 'session-main';
      const title = document.createElement('b');
      title.textContent = session.title || '未命名会话';
      const sub = document.createElement('small');
      sub.textContent = '桌面会话 · 点击切换';
      main.append(title, sub);

      const meta = document.createElement('span');
      meta.className = 'session-meta';
      const time = document.createElement('time');
      time.textContent = String(index + 1).padStart(2, '0');
      meta.appendChild(time);

      button.append(icon, main, meta);
      button.addEventListener('click', () => void activateGuiSession(index, session.title));
      els.sessionList.appendChild(button);
    });
    filterSessionItems();
  }

  function filterSessionItems() {
    const keyword = els.sessionSearch ? els.sessionSearch.value.trim().toLowerCase() : '';
    $$('[data-session-item]', els.sessionList || document).forEach((item) => {
      item.hidden = keyword !== '' && !item.textContent.toLowerCase().includes(keyword);
    });
  }

  function getSidebarRoot(doc) {
    try {
      const anchor = doc.querySelector('[data-shell-bottom]') || doc.querySelector('[data-shell-overlay]');
      const frame = anchor && anchor.parentElement;
      if (frame && frame.children && frame.children.length > 0) return frame.children[0];
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  /**
   * Heuristic session scrape from the expanded real GUI sidebar: buttons inside
   * the sidebar column that are not known chrome controls (toggle / new session
   * / global panel rows) and carry user-visible text.
   */
  function collectGuiSessions(doc) {
    const root = getSidebarRoot(doc);
    if (!root) return [];
    const panelNav = root.querySelector('nav');
    const buttons = Array.from(root.querySelectorAll('button'));
    const items = [];
    for (const button of buttons) {
      if (panelNav && panelNav.contains(button)) continue;
      if (button.getAttribute(GUARDED_ACTION_ATTR) === '1') continue; // hidden desktop-dialog action
      if (button.hidden) continue;
      const aria = String(button.getAttribute('aria-label') || '').trim();
      if (aria && SIDEBAR_KNOWN_LABELS.test(aria)) continue;
      const text = String(button.innerText || button.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text.length < 2 || text.length > 120) continue;
      if (SIDEBAR_KNOWN_LABELS.test(text)) continue;
      if (SIDEBAR_GENERIC_LABELS.test(text)) continue;
      try {
        const rect = button.getBoundingClientRect();
        if (rect && (rect.width < 20 || rect.height < 12)) continue;
      } catch (_) {
        /* ignore */
      }
      const duplicate = items.some((item) => item.text === text);
      if (duplicate) continue;
      items.push({ text, el: button });
      if (items.length >= 8) break;
    }
    return items;
  }

  async function openGuiSidebar() {
    const doc = guiDocument();
    if (!doc) return false;
    try {
      if (
        doc.querySelector('button[aria-label="收起侧边栏"]') ||
        doc.querySelector('button[aria-label="Collapse sidebar"]')
      ) {
        state.guiSidebarOpened = true; // already expanded
        return true;
      }
    } catch (_) {
      /* ignore */
    }
    const clicked = clickGuiAction('sidebar');
    if (clicked) {
      state.guiSidebarOpened = true;
      await sleep(340);
    }
    return clicked;
  }

  async function closeGuiSidebar() {
    if (!state.guiSidebarOpened) return;
    const doc = guiDocument();
    try {
      if (
        doc &&
        (doc.querySelector('button[aria-label="收起侧边栏"]') ||
          doc.querySelector('button[aria-label="Collapse sidebar"]'))
      ) {
        clickGuiAction('sidebar');
        await sleep(200);
      }
    } catch (_) {
      /* ignore */
    }
    state.guiSidebarOpened = false;
  }

  async function scrapeGuiSessions() {
    const doc = guiDocument();
    if (!doc) return false;
    const opened = await openGuiSidebar();
    let items = [];
    try {
      items = collectGuiSessions(doc);
    } catch (_) {
      items = [];
    }
    await closeGuiSidebar();
    state.guiSessions = items.map((item) => ({ title: item.text }));
    return state.guiSessions.length > 0;
  }

  let sessionScrapeBusy = false;
  async function scrapeAndRenderSessions() {
    if (!state.drawerOpen || sessionScrapeBusy || !state.frameLoaded) return;
    sessionScrapeBusy = true;
    try {
      const ok = await scrapeGuiSessions();
      state.sessionScraped = true;
      if (state.drawerOpen) {
        renderDrawerSessions();
        if (!ok && els.drawerFallback) els.drawerFallback.hidden = false;
      }
    } finally {
      sessionScrapeBusy = false;
    }
  }

  async function activateGuiSession(index, title) {
    closeDrawer();
    const opened = await openGuiSidebar();
    if (!opened) {
      toast('无法打开桌面会话列表，请在桌面界面中操作');
      return;
    }
    let target = null;
    try {
      const doc = guiDocument();
      const items = doc ? collectGuiSessions(doc) : [];
      if (items[index]) target = items[index].el;
      if (!target && title) {
        const matched = items.find((item) => item.text === title);
        if (matched) target = matched.el;
      }
    } catch (_) {
      target = null;
    }
    if (target) {
      try {
        target.click();
        toast('已切换会话');
      } catch (_) {
        toast('切换会话失败，请手动选择');
      }
    } else {
      toast('未找到该会话，请在桌面会话列表中手动选择');
    }
    await closeGuiSidebar();
  }

  async function openGuiSessionList() {
    closeDrawer();
    const opened = await openGuiSidebar();
    toast(opened ? '已打开桌面会话列表，请手动选择' : '无法打开桌面会话列表，请在桌面端操作');
  }

  /* ------------------------------------------------------------------ */
  /* quick-actions sheet                                                 */
  /* ------------------------------------------------------------------ */

  function openSheet() {
    if (state.currentScreen !== 'chat') return;
    if (state.drawerOpen) closeDrawer();
    state.sheetOpen = true;
    if (els.quickSheet) {
      els.quickSheet.classList.add('is-open');
      els.quickSheet.setAttribute('aria-hidden', 'false');
    }
    showScrim();
    updateDockActive();
    updateConnectionUi();
    refreshQuickAvailable();
  }

  function closeSheet() {
    if (!state.sheetOpen) return;
    state.sheetOpen = false;
    if (els.quickSheet) {
      els.quickSheet.classList.remove('is-open');
      els.quickSheet.setAttribute('aria-hidden', 'true');
    }
    hideScrim();
    updateDockActive();
  }

  function closeOverlays() {
    closeDrawer();
    closeSheet();
  }

  function handleDockAction(action) {
    if (action === 'sessions') {
      activateSessionsEntry();
      return;
    }
    if (action === 'new') {
      const ok = clickGuiAction('newSession');
      if (ok) setTimeout(() => blurGuiTextInput(), 600);
      toast(ok ? '已新建会话' : '未找到桌面端新建按钮，请在桌面界面中操作');
      return;
    }
    if (action === 'refresh') {
      loadFrame();
      toast('界面已刷新');
      return;
    }
    if (action === 'more') openSheet();
  }

  function handleQuickAction(name) {
    if (name === 'sessions') {
      closeSheet();
      activateSessionsEntry();
      return;
    }
    if (name === 'new') {
      closeSheet();
      const ok = clickGuiAction('newSession');
      if (ok) setTimeout(() => blurGuiTextInput(), 600);
      toast(ok ? '已新建会话' : '未找到桌面端新建按钮，请在桌面界面中操作');
      return;
    }
    if (name === 'refresh') {
      closeSheet();
      loadFrame();
      toast('界面已刷新');
      return;
    }
    if (name === 'diagnostics') {
      closeSheet();
      openSettings({ focusDiagnostics: true });
      return;
    }
    if (name === 'settings') {
      closeSheet();
      openSettings();
      return;
    }
    if (name === 'disconnect') {
      closeSheet();
      disconnectToPairing();
    }
  }

  /* ------------------------------------------------------------------ */
  /* settings / diagnostics page                                         */
  /* ------------------------------------------------------------------ */

  /** Current page URL is the source of truth for the server-address field. */
  function currentServerUrl() {
    try {
      return window.location.href;
    } catch (_) {
      return location.origin + '/m/';
    }
  }

  /** Accepts host-only / /m / full tunnel URLs and normalizes them to an http(s) mobile URL. */
  function normalizeServerUrl(raw) {
    let text = String(raw || '').trim();
    if (!text) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      text = (/^[^\/\s]+\.[a-z]{2,}(?::\d+)?(?:[\/?#]|$)/i.test(text) ? 'https://' : 'http://') + text;
    }
    let url;
    try {
      url = new URL(text);
    } catch (_) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let path = url.pathname || '/';
    if (path === '' || path === '/' || path === '/m') path = '/m/';
    url.pathname = path;
    if (/\/m\/$/i.test(path) && !url.searchParams.has('app')) url.searchParams.set('app', '1');
    return url.toString();
  }

  function updateServerField() {
    if (!els.settingsServerInput) return;
    els.settingsServerInput.value = currentServerUrl();
  }

  function applyServerField() {
    const target = normalizeServerUrl(els.settingsServerInput ? els.settingsServerInput.value : '');
    if (!target) {
      toast('地址格式不正确，请输入 http:// 或 https:// 地址');
      return;
    }
    if (els.settingsServerInput) els.settingsServerInput.value = target;
    const bridge = nativeBridge();
    if (bridge && hasNativeMethod('loadUrl')) {
      callNative('loadUrl', target);
      return;
    }
    try {
      window.location.replace(target);
    } catch (_) {
      window.location.href = target;
    }
  }

  function openSettings(options) {
    const opts = options || {};
    showScreen('settings');
    populateSettings();
    if (opts.focusDiagnostics && els.diagCard) {
      setTimeout(() => {
        try {
          els.diagCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } catch (_) {
          /* ignore */
        }
      }, 120);
    }
  }

  function populateSettings() {
    if (!els.settingsView) return;
    updateServerField();
    if (els.settingsOrigin) {
      try {
        els.settingsOrigin.textContent = window.location.origin || location.host;
      } catch (_) {
        els.settingsOrigin.textContent = location.host;
      }
    }
    if (els.settingsHost) els.settingsHost.textContent = state.host || '—';
    if (els.settingsMode) {
      els.settingsMode.textContent = state.appMode
        ? 'APK App 全屏'
        : state.standalone
          ? '独立应用（standalone）'
          : '浏览器标签页';
    }
    if (els.settingsNative) {
      els.settingsNative.textContent = state.appMode
        ? state.nativeAvailable
          ? '可用（DshApp）'
          : '不可用（无 JS 接口）'
        : '—';
    }
    if (els.settingsLastError) els.settingsLastError.textContent = state.lastError || '无';
    if (els.settingsPaired) els.settingsPaired.textContent = state.paired ? '已配对' : '未配对';
    if (els.settingsApkVersion) {
      const nativeVersion = hasNativeMethod('getAppVersion') ? callNative('getAppVersion') : null;
      els.settingsApkVersion.textContent = nativeVersion ? 'v' + nativeVersion : '网页版 v' + APP_VERSION;
    }
    if (els.settingsNativeSettings) {
      els.settingsNativeSettings.hidden = !hasNativeMethod('openSettings');
    }
    if (els.settingsDownloadApk) {
      const unavailable = state.apkAvailable === false;
      els.settingsDownloadApk.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
      els.settingsDownloadApk.classList.toggle('is-unavailable', unavailable);
    }
    syncAppearanceUi();
    refreshQuickAvailable();
    updateConnectionUi();
  }

  function disconnectToPairing() {
    state.forcePairing = true;
    state.paired = false;
    teardownFrame();
    closeOverlays();
    clearPin(true);
    setHint('已断开连接，请输入 PIN 重新配对', 'info');
    showPairFallback(null);
    showScreen('pair');
    updateConnectionUi();
    toast('已断开连接，请重新配对');
  }

  function openNativeSettings() {
    if (!hasNativeMethod('openSettings')) {
      toast('当前环境没有 App 设置入口');
      return;
    }
    callNative('openSettings');
  }

  function diagnosticsText() {
    return [
      'DSH Mobile 诊断',
      '版本: v' + APP_VERSION,
      '时间: ' + new Date().toISOString(),
      '状态: ' + connectionText(),
      '服务器地址: ' + (window.location.origin || ''),
      '桌面端: ' + (state.host || '—'),
      '延迟: ' + (state.latencyMs != null ? state.latencyMs + ' ms' : '—'),
      '运行模式: ' + (state.appMode ? 'APK App 全屏' : state.standalone ? 'standalone' : 'browser'),
      '原生接口: ' + (state.appMode ? (state.nativeAvailable ? 'DshApp' : '无') : '—'),
      '快捷操作: ' + (state.frameLoaded
        ? '侧栏 ' + (state.quickAvailable.sidebar ? '✓' : '—') + ' · 新会话 ' + (state.quickAvailable.newSession ? '✓' : '—')
        : '未加载'),
      '最近错误: ' + (state.lastError || '无'),
      'User Agent: ' + (navigator.userAgent || '—'),
    ].join('\n');
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* android APK download                                                */
  /* ------------------------------------------------------------------ */

  async function probeApkAvailability() {
    if (state.apkChecked) return state.apkAvailable;
    state.apkChecked = true;
    try {
      const response = await fetch(APK_DOWNLOAD_URL, { method: 'HEAD', cache: 'no-store' });
      state.apkAvailable = !!response.ok;
    } catch (_) {
      state.apkAvailable = false; // 404 / offline: friendly UI, never an error
    }
    populateSettings();
    return state.apkAvailable;
  }

  async function downloadApk() {
    if (state.apkAvailable !== true) {
      const available = await probeApkAvailability();
      if (!available) {
        toast('安卓安装包稍后可用，敬请期待');
        return;
      }
    }
    try {
      window.location.href = APK_DOWNLOAD_URL;
    } catch (_) {
      toast('下载地址暂不可用，请稍后重试');
    }
  }

  /* ------------------------------------------------------------------ */
  /* appearance: theme / accent / font scale                             */
  /* ------------------------------------------------------------------ */

  function applyTheme(theme) {
    if (!THEMES[theme]) return;
    state.theme = theme;
    if (els.app) els.app.dataset.theme = theme;
    storageSet(THEME_STORAGE_KEY, theme);
    syncAppearanceUi();
  }

  function applyAccent(accent) {
    const preset = ACCENTS[accent];
    if (!preset) return;
    state.accent = accent;
    if (els.app) {
      els.app.style.setProperty('--accent-a', preset.a);
      els.app.style.setProperty('--accent-b', preset.b);
      els.app.style.setProperty('--accent-soft', preset.soft);
      els.app.style.setProperty('--accent-glow', preset.glow);
    }
    storageSet(ACCENT_STORAGE_KEY, accent);
    syncAppearanceUi();
  }

  function applyScale(scale, persist) {
    const value = SCALE_VALUES.indexOf(Number(scale)) >= 0 ? Number(scale) : 100;
    state.scale = value;
    if (persist) storageSet(SCALE_STORAGE_KEY, String(value));
    if (els.app) els.app.style.setProperty('--font-scale', String(value / 100));
    if (els.fontScaleInput) els.fontScaleInput.value = String(value);
    if (els.fontScaleOut) els.fontScaleOut.textContent = value + '%';
    if (state.frameLoaded) injectAdaptiveCss(els.guiFrame, 0);
  }

  function syncAppearanceUi() {
    if (els.themeRow) {
      $$('button', els.themeRow).forEach((button) => {
        button.classList.toggle('is-active', button.dataset.setTheme === state.theme);
      });
    }
    if (els.accentRow) {
      $$('button', els.accentRow).forEach((button) => {
        button.classList.toggle('is-active', button.dataset.setAccent === state.accent);
      });
    }
    if (els.settingsThemeLabel) els.settingsThemeLabel.textContent = THEMES[state.theme] || '深空';
    if (els.settingsAccentLabel) els.settingsAccentLabel.textContent = (ACCENTS[state.accent] || ACCENTS.blue).name;
    if (els.fontScaleInput) els.fontScaleInput.value = String(state.scale);
    if (els.fontScaleOut) els.fontScaleOut.textContent = state.scale + '%';
  }

  /* ------------------------------------------------------------------ */
  /* viewport / keyboard                                                 */
  /* ------------------------------------------------------------------ */

  function syncViewportHeight() {
    const viewport = window.visualViewport;
    const inner = Number(window.innerHeight) || 0;
    const visual = viewport ? Number(viewport.height) || 0 : 0;
    let height = visual > 0 ? visual : inner;
    if (inner > 0 && visual > 0) height = Math.min(inner, visual);
    if (height && height > 0) {
      document.documentElement.style.setProperty('--app-height', Math.round(height) + 'px');
    }
    updateKeyboardState(height);
  }

  /** Re-measure after the soft keyboard opens (the IME resize can arrive a few frames late). */
  function refitAfterKeyboard() {
    for (const delay of [0, 80, 200, 420, 720]) setTimeout(syncViewportHeight, delay);
  }

  function updateKeyboardState(height) {
    const current = Math.round(Number(height) || 0);
    const layout = Math.round(Number(window.innerHeight) || 0);
    if (current <= 0) return;
    state.layoutBaseline = Math.max(state.layoutBaseline || 0, current, layout);
    if (!state.layoutBaseline) return;
    const keyboardOpen = state.layoutBaseline - current > KEYBOARD_SHRINK_PX;
    if (keyboardOpen === state.keyboardOpen) return;
    state.keyboardOpen = keyboardOpen;
    if (els.app) els.app.dataset.keyboard = keyboardOpen ? 'open' : 'closed';
    if (keyboardOpen) {
      closeSheet();
      closeDrawer();
    }
  }

  function resetViewportBaseline() {
    state.layoutBaseline = 0;
    syncViewportHeight();
  }

  /* ------------------------------------------------------------------ */
  /* event wiring                                                        */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    if (els.pairForm) {
      els.pairForm.addEventListener('submit', (event) => {
        event.preventDefault();
        void submitPair();
      });
    }
    if (els.keypad) {
      els.keypad.addEventListener('click', (event) => {
        const key = event.target.closest('[data-key]');
        if (!key) return;
        const value = key.dataset.key;
        if (value === 'back') pressBackspace();
        else if (/^[0-9]$/.test(value)) pressDigit(value);
      });
    }
    if (els.scanPair) {
      els.scanPair.addEventListener('click', () => toast('扫码配对即将支持，当前请使用 6 位 PIN'));
    }
    if (els.pairApk) els.pairApk.addEventListener('click', () => void downloadApk());
    if (els.manualLoginBtn) els.manualLoginBtn.addEventListener('click', manualLogin);
    if (els.retryAutoBtn) els.retryAutoBtn.addEventListener('click', () => void retryAutoLogin());
    if (els.appSettingsBtn) els.appSettingsBtn.addEventListener('click', openNativeSettings);

    if (els.reloadBtn) {
      els.reloadBtn.addEventListener('click', () => {
        loadFrame();
        toast('界面已刷新');
      });
    }
    if (els.capsuleMore) els.capsuleMore.addEventListener('click', openSheet);
    if (els.statusPeek) els.statusPeek.addEventListener('click', showCapsule);

    if (els.dock) {
      els.dock.addEventListener('click', (event) => {
        const button = event.target.closest('[data-dock]');
        if (!button) return;
        handleDockAction(button.dataset.dock);
      });
    }

    if (els.scrim) els.scrim.addEventListener('click', closeOverlays);
    $$('[data-close-drawer]').forEach((button) => button.addEventListener('click', closeDrawer));
    $$('[data-close-sheet]').forEach((button) => button.addEventListener('click', closeSheet));
    $$('[data-new-session]').forEach((button) =>
      button.addEventListener('click', () => {
        closeDrawer();
        const ok = clickGuiAction('newSession');
        toast(ok ? '已新建会话' : '未找到桌面端新建按钮，请在桌面界面中操作');
      }),
    );
    if (els.openGuiSessionsBtn) {
      els.openGuiSessionsBtn.addEventListener('click', () => void openGuiSessionList());
    }
    if (els.sessionSearch) {
      els.sessionSearch.addEventListener('input', filterSessionItems);
    }
    $$('[data-open-settings]').forEach((button) =>
      button.addEventListener('click', () => {
        closeDrawer();
        openSettings();
      }),
    );

    if (els.quickSheet) {
      els.quickSheet.addEventListener('click', (event) => {
        const action = event.target.closest('[data-quick]');
        if (!action) return;
        handleQuickAction(action.dataset.quick);
      });
    }

    if (els.settingsBack) {
      els.settingsBack.addEventListener('click', () => {
        showScreen(state.paired ? 'chat' : 'pair');
      });
    }
    if (els.settingsView) {
      els.settingsView.addEventListener('click', (event) => {
        const themeButton = event.target.closest('[data-set-theme]');
        if (themeButton) {
          applyTheme(themeButton.dataset.setTheme);
          return;
        }
        const accentButton = event.target.closest('[data-set-accent]');
        if (accentButton) {
          applyAccent(accentButton.dataset.setAccent);
        }
      });
    }
    if (els.settingsReconnect) {
      els.settingsReconnect.addEventListener('click', () => {
        loadFrame();
        void checkState({ silent: false });
        toast('正在重新连接桌面端…');
      });
    }
    if (els.settingsAddressHelp) {
      els.settingsAddressHelp.addEventListener('click', () =>
        toast('服务器地址由桌面端配对页决定；如需更换请在桌面端重新打开配对页。'),
      );
    }
    if (els.settingsDownloadApk) els.settingsDownloadApk.addEventListener('click', () => void downloadApk());
    if (els.settingsNativeSettings) els.settingsNativeSettings.addEventListener('click', openNativeSettings);
  if (els.frameErrorRetry) els.frameErrorRetry.addEventListener('click', () => {
    hideFrameError();
    try {
      els.guiFrame.src = 'about:blank';
    } catch (_) {
      /* ignore */
    }
    loadFrame();
  });
  if (els.frameErrorSettings) els.frameErrorSettings.addEventListener('click', () => openSettings());
  if (els.settingsServerApply) els.settingsServerApply.addEventListener('click', applyServerField);
  if (els.settingsServerReset) els.settingsServerReset.addEventListener('click', updateServerField);
  if (els.pairChangeServer) els.pairChangeServer.addEventListener('click', () => openSettings());
    if (els.copyDiagBtn) {
      els.copyDiagBtn.addEventListener('click', () => {
        void copyText(diagnosticsText()).then((ok) => toast(ok ? '诊断信息已复制' : '复制失败，请手动选择'));
      });
    }
    if (els.settingsRecheck) {
      els.settingsRecheck.addEventListener('click', () => {
        void checkState({ silent: false });
        toast('已重新检测连接状态');
      });
    }
    if (els.settingsReload) {
      els.settingsReload.addEventListener('click', () => {
        loadFrame();
        toast('已请求重新加载桌面界面');
      });
    }
    if (els.disconnectBtn) els.disconnectBtn.addEventListener('click', disconnectToPairing);
    if (els.fontScaleInput) {
      els.fontScaleInput.addEventListener('input', () => applyScale(els.fontScaleInput.value, true));
    }
    if (els.offlineRetry) {
      els.offlineRetry.addEventListener('click', () => void checkState({ silent: false }));
    }

    if (els.guiFrame) els.guiFrame.addEventListener('load', onFrameLoad);

    // v0.3.6 — the in-iframe desktop-dialog guard posts here for shell toasts.
    window.addEventListener('message', (event) => {
      try {
        const data = event && event.data;
        if (!data || data.type !== MOBILE_TOAST_MESSAGE_TYPE) return;
        if (typeof data.action === 'string' && data.action) state.lastBlockedAction = data.action;
        if (typeof data.text === 'string' && data.text) toast(data.text);
        else toast(MOBILE_BLOCKED_TOAST_TEXT);
      } catch (_) {
        /* ignore */
      }
    });

    window.addEventListener('online', () => {
      hideOffline();
      void checkState({ silent: true });
    });
    window.addEventListener('offline', () => {
      state.online = false;
      updateConnectionUi();
      showOffline('手机网络已断开，请恢复网络后重试');
    });
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    window.addEventListener('orientationchange', () => {
      setTimeout(resetViewportBaseline, 120);
    });
    window.addEventListener('resize', () => syncViewportHeight());
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewportHeight);
      window.visualViewport.addEventListener('scroll', syncViewportHeight);
    }
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (state.drawerOpen || state.sheetOpen) {
          closeOverlays();
          return;
        }
        if (state.currentScreen === 'settings') {
          showScreen(state.paired ? 'chat' : 'pair');
          return;
        }
      }
      const tag = (event.target && event.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (event.target && event.target.isContentEditable);
      if (typing || state.currentScreen !== 'pair') return;
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        pressDigit(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        pressBackspace();
      } else if (event.key === 'Enter' && state.digits.length === 6) {
        event.preventDefault();
        void submitPair();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* init + debug surface                                                */
  /* ------------------------------------------------------------------ */

  function init() {
    cacheEls();
    applyAppMode();
    applyTheme(state.theme);
    applyAccent(state.accent);
    applyScale(state.scale, false);
    bindEvents();
    syncViewportHeight();
    showScreen('boot');
    updateConnectionUi();
    void probeApkAvailability();
    void checkState({ initial: true });
    startWatchdog();

    // Small debug surface for QA / browser automation without exposing secrets.
    try {
      window.__DSH_MOBILE__ = Object.freeze({
        version: APP_VERSION,
        getStatus() {
          return {
            paired: state.paired,
            online: state.online,
            host: state.host,
            screen: state.currentScreen,
            frameLoaded: state.frameLoaded,
            theme: state.theme,
            accent: state.accent,
            scale: state.scale,
            appMode: state.appMode,
            nativeAvailable: state.nativeAvailable,
            topInset: state.nativeTopInset,
            keyboard: state.keyboardOpen ? 'open' : 'closed',
            capsuleHidden: state.capsuleHidden,
            bars: state.barsHidden ? 'hidden' : 'shown',
            drawerOpen: state.drawerOpen,
            sheetOpen: state.sheetOpen,
            sidebarExpanded: state.guiSidebarExpanded,
            blockedAction: state.lastBlockedAction || null,
            unblockedCount: state.lastUnblockedCount || 0,
            quickActions: { sidebar: state.quickAvailable.sidebar, newSession: state.quickAvailable.newSession },
            sessions: state.guiSessions.length,
            apkAvailable: state.apkAvailable,
            latencyMs: state.latencyMs,
            locked: isLocked(),
            digits: state.digits.length,
            lastError: state.lastError || null,
          };
        },
        checkNow() {
          return checkState({ silent: false });
        },
        openSettings,
        openDrawer,
        openSheet,
        closeOverlays,
        showScreen,
        revealBars,
        hideBars: () => setBarsHidden(true),
        refreshQuickAvailable,
        toggleGuiSidebar,
        syncDockSidebarState,
        scanGuardedActions: () => scanGuardedGuiActions(),
        scrapeSessions: scrapeGuiSessions,
      });
    } catch (_) {
      /* ignore */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }


})();
