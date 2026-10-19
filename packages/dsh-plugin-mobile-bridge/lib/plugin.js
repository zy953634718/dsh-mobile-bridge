// Cordis host plugin entry for the DSH mobile bridge bundle.
//
// Defensive by contract: profile boot must never fail because this listener
// could not start. Every step is guarded and a failure logs a single warning.
//
// Late bind: the `webServer` service becomes available at activation, but its
// async listen may still be in flight, and `webServer.getOrigin()` throws until
// the port is bound. Startup therefore retries on a short unref'd timer for a
// bounded window instead of giving up on the first throw.
import { startBridge } from './bridge.js';

/** Stable Cordis plugin name (matches the patch row id/name). */
export const name = 'mobile-bridge';

/** Services that must exist before the bridge can proxy anything. */
export const inject = ['webServer', 'connection'];

/** Startup retry cadence while the DSH web listener binds. */
const READY_RETRY_INTERVAL_MS = 200;
/** How long the plugin keeps waiting for the DSH web origin before warning. */
const READY_TIMEOUT_MS = 15_000;

export { startBridge };

/**
 * Read a Cordis service without letting a missing provider throw.
 * @param {object} ctx plugin context.
 * @param {string} key service name.
 * @returns {any} the service, or undefined.
 */
function readService(ctx, key) {
  try {
    const direct = ctx?.[key];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    /* a service getter can throw when the provider is absent */
  }
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lazy `connection.authenticatedUrl` accessor: the pairing endpoint re-reads
 * the live service at request time, so a late connection activation still
 * yields a working login URL and a missing service becomes HTTP 503 rather
 * than a boot failure.
 * @param {object} ctx plugin context.
 * @returns {(baseUrl: string) => string}
 */
function authenticatedUrlAccessor(ctx) {
  return (baseUrl) => {
    const connection = readService(ctx, 'connection');
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') {
      throw new Error('connection.authenticatedUrl is unavailable');
    }
    return connection.authenticatedUrl(baseUrl);
  };
}

/**
 * Build the desktop-GUI discovery button script injected into the index HTML.
 * It only acts on a loopback hostname (never inside the phone shell iframe),
 * needs no external asset, and opens the desktop pairing page in a new tab.
 * @param {number} port bridge listener port.
 * @returns {string} inline script text.
 */
function buildGuiButtonScript(port) {
  const pairUrl = `http://127.0.0.1:${port}/m/pair`;
  // Escaped Chinese/emoji keep this source file ASCII; the browser decodes them.
  const label = '\\u{1F4F1} \\u624B\\u673A\\u8FDE\\u63A5';
  const title = '\\u6253\\u5F00\\u624B\\u673A\\u914D\\u5BF9\\u9875\\u9762\\uFF08\\u4EC5\\u672C\\u673A\\uFF09';
  return `(() => {
  try {
    var host = String(location.hostname || "");
    var loopback = host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost" || /^127\\./.test(host);
    if (!loopback) return;
    var id = "dsh-mobile-bridge-pair";
    var openPairPage = function () {
      try { window.open(${JSON.stringify(pairUrl)}, "_blank", "noopener,noreferrer"); } catch (error) { /* ignore */ }
    };
    var reveal = function () {
      try {
        if (document.getElementById(id)) return;
        if (!document.body) { setTimeout(reveal, 150); return; }
        var button = document.createElement("button");
        button.id = id;
        button.type = "button";
        button.textContent = "${label}";
        button.title = "${title}";
        button.setAttribute("aria-label", "${title}");
        button.style.cssText = [
          "position:fixed",
          "right:18px",
          "bottom:18px",
          "z-index:2147483000",
          "padding:10px 16px",
          "border:1px solid rgba(120,190,255,0.45)",
          "border-radius:999px",
          "background:linear-gradient(135deg,#0b2a4a,#123f6b)",
          "color:#dbeaff",
          "font:600 14px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif",
          "letter-spacing:0.02em",
          "cursor:pointer",
          "box-shadow:0 8px 24px rgba(0,0,0,0.45)",
          "backdrop-filter:blur(6px)",
        ].join(";");
        button.addEventListener("mouseenter", function () { button.style.filter = "brightness(1.18)"; });
        button.addEventListener("mouseleave", function () { button.style.filter = ""; });
        button.addEventListener("click", openPairPage);
        document.body.appendChild(button);
      } catch (error) { /* never break the GUI */ }
    };
    reveal();
  } catch (error) { /* never break the GUI */ }
})();`;
}

/**
 * Register the index-injection row that renders the discovery button. Follows
 * the host-web plugins' pattern: read `webServer` through a scoped inject and
 * listen for the `webserver/index-inject` table.
 * @param {object} ctx plugin context.
 * @param {string} script inline script text.
 */
function registerGuiButtonInjection(ctx, script) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['webServer'], (webCtx) => {
    if (typeof webCtx?.on !== 'function') return;
    webCtx.on('webserver/index-inject', (table) => {
      try {
        if (Array.isArray(table)) table.push({ kind: 'script', placement: 'body', text: script });
      } catch {
        /* a read-only table must never break index rendering */
      }
    });
  });
}

/**
 * Register the bridge's disposer on the owning Cordis fiber (and as a last
 * resort on process exit). Idempotent.
 * @param {object} ctx plugin context.
 * @param {{close: () => Promise<void>}} handle bridge handle.
 */
function registerDisposer(ctx, handle) {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      const result = handle.close();
      if (result !== undefined && result !== null && typeof result.catch === 'function') result.catch(() => {});
    } catch (error) {
      console.warn(`mobile-bridge: error while closing the LAN listener: ${String(error?.message ?? error)}`);
    }
  };
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => dispose(), 'mobile-bridge: LAN listener');
    } catch (error) {
      console.warn(`mobile-bridge: could not register cleanup: ${String(error?.message ?? error)}`);
    }
  }
  try {
    process.once('exit', dispose);
  } catch {
    /* ignore */
  }
}

/**
 * Start the bridge once the DSH web origin is known and wire everything up.
 * @param {object} ctx plugin context.
 * @param {object} settings plugin config.
 * @param {string} targetOrigin resolved DSH web origin.
 * @param {() => boolean} isCancelled whether the owning fiber was disposed.
 */
async function launchBridge(ctx, settings, targetOrigin, isCancelled) {
  let handle;
  try {
    handle = await startBridge({
      ...settings,
      targetOrigin,
      authenticatedUrl: authenticatedUrlAccessor(ctx),
      logger: {
        info: (...args) => console.log(...args),
        warn: (...args) => console.warn(...args),
        error: (...args) => console.error(...args),
      },
    });
  } catch (error) {
    const bindHost = typeof settings.bindHost === 'string' ? settings.bindHost : '0.0.0.0';
    const port = settings.port ?? 7860;
    console.warn(
      `mobile-bridge: could not start the LAN listener on ${bindHost}:${String(port)} (${String(error?.message ?? error)}); DSH keeps running without the LAN bridge`,
    );
    return;
  }
  if (isCancelled()) {
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
    return;
  }
  registerDisposer(ctx, handle);
  if (settings.guiButton !== false) {
    try {
      registerGuiButtonInjection(ctx, buildGuiButtonScript(handle.port));
    } catch (error) {
      console.warn(`mobile-bridge: could not inject the desktop pairing button: ${String(error?.message ?? error)}`);
    }
  }
}

/**
 * Cordis apply: start the bridge on the current DSH web origin and wire cleanup.
 * @param {object} ctx plugin context.
 * @param {object} [config] plugin config from the patch row.
 */
export async function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  try {
    if (settings.enabled === false) {
      console.log('mobile-bridge: disabled by config (enabled: false)');
      return;
    }
    if (readService(ctx, 'webServer') === undefined || readService(ctx, 'connection') === undefined) {
      console.warn('mobile-bridge: requires the webServer and connection services; LAN bridge not started');
      return;
    }
    let cancelled = false;
    let started = false;
    let retryTimer = null;

    const cancelRetry = () => {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    if (typeof ctx?.effect === 'function') {
      try {
        ctx.effect(() => () => cancelRetry(), 'mobile-bridge: startup retry');
      } catch (error) {
        console.warn(`mobile-bridge: could not register startup cleanup: ${String(error?.message ?? error)}`);
      }
    }

    const deadline = Date.now() + READY_TIMEOUT_MS;
    const attemptStart = () => {
      retryTimer = null;
      if (cancelled || started) return;
      let targetOrigin = '';
      try {
        const webServer = readService(ctx, 'webServer');
        targetOrigin = typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : '';
      } catch {
        targetOrigin = '';
      }
      if (typeof targetOrigin !== 'string' || targetOrigin === '') {
        if (Date.now() >= deadline) {
          console.warn(
            `mobile-bridge: the DSH web origin was still unavailable after ${String(READY_TIMEOUT_MS / 1000)}s; LAN bridge not started`,
          );
          return;
        }
        retryTimer = setTimeout(attemptStart, READY_RETRY_INTERVAL_MS);
        if (typeof retryTimer.unref === 'function') retryTimer.unref();
        return;
      }
      started = true;
      void launchBridge(ctx, settings, targetOrigin, () => cancelled);
    };
    attemptStart();
  } catch (error) {
    // Absolute backstop: a profile boot must never fail because of this plugin.
    console.warn(`mobile-bridge: plugin setup failed: ${String(error?.stack ?? error)}`);
  }
}
