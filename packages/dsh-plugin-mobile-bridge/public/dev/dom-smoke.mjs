#!/usr/bin/env node
/**
 * DSH Mobile — DOM-level shell smoke test (dev-only, no dependencies)
 * ====================================================================
 * This session's sandbox cannot launch Chromium, so this script parses the REAL
 * public/index.html into a minimal DOM tree, executes the REAL public/app.js in
 * a vm sandbox with mocked /m/api endpoints and a fake same-origin DSH GUI, and
 * drives the v0.3.6 「沉浸式原生」shell:
 *
 *   boot -> pairing (keypad) -> POST /m/api/pair -> hidden iframe token login ->
 *   real GUI iframe -> Dock quick-actions (real aria-label buttons) ->
 *   session drawer (GUI scrape + degraded fallback) -> quick sheet -> settings
 *   (appearance / APK download / disconnect) -> 401 auth-loss -> wrong PIN ->
 *   429 lockout -> offline banner -> keyboard flag.
 *
 * With --app-mode it boots as the Android WebView (UA ` DSHMobileApp/0.1`,
 * `?app=1`, window.DshApp) and verifies the full-screen mode + native insets.
 *
 * Usage:
 *   node packages/dsh-plugin-mobile-bridge/public/dev/dom-smoke.mjs
 *   node packages/dsh-plugin-mobile-bridge/public/dev/dom-smoke.mjs --app-mode
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, '..');
const INDEX_HTML = readFileSync(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
const APP_JS = readFileSync(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
const APP_MODE = process.argv.includes('--app-mode');

/* ================================================================== */
/* tiny HTML -> DOM tree                                               */
/* ================================================================== */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'use', 'stop',
  'line', 'polyline', 'polygon', 'ellipse',
]);

function camelCase(name) {
  return String(name).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

let uid = 0;

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument || null;
    this.uid = (uid += 1);
    this.id = '';
    this.attrs = {};
    this.dataset = {};
    this._classes = new Set();
    this._text = '';
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._listeners = new Map();
    this._src = '';
    this.style = {
      _props: new Map(),
      setProperty: (key, value) => this.style._props.set(String(key), String(value)),
      getPropertyValue: (key) => this.style._props.get(String(key)) || '',
      removeProperty: (key) => this.style._props.delete(String(key)),
      cssText: '',
    };
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      toggle: (name, force) => {
        const next = force === undefined ? !this._classes.has(name) : !!force;
        if (next) this._classes.add(name);
        else this._classes.delete(name);
        return next;
      },
      contains: (name) => this._classes.has(name),
    };
  }

  get className() {
    return Array.from(this._classes).join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._text + this.children.map((child) => (child ? child.textContent : '')).join('');
  }

  set textContent(value) {
    this._text = String(value == null ? '' : value);
    this.children = [];
  }

  get innerText() {
    return this.textContent;
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this.setAttribute('src', value);
  }

  get offsetWidth() {
    return 0;
  }

  get offsetHeight() {
    return 0;
  }

  get clientWidth() {
    return 390;
  }

  get clientHeight() {
    return 844;
  }

  get parentElement() {
    return this.parentNode;
  }

  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    if (this.ownerDocument && child.id) this.ownerDocument._byId.set(String(child.id), child);
    return child;
  }

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child) child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    const key = String(name);
    const str = String(value == null ? '' : value);
    this.attrs[key] = str;
    if (key === 'id') this.id = str;
    else if (key === 'class') str.split(/\s+/).filter(Boolean).forEach((cls) => this._classes.add(cls));
    else if (key === 'hidden') this.hidden = true;
    else if (key === 'disabled') this.disabled = true;
    else if (key === 'value') this.value = str;
    else if (key.startsWith('data-')) this.dataset[camelCase(key.slice(5))] = str;
    if (key === 'src') {
      this._src = str;
      if (this.tagName === 'IFRAME' && this.ownerDocument && typeof this.ownerDocument._iframeHook === 'function') {
        this.ownerDocument._iframeHook(this, str);
      }
    }
  }

  getAttribute(name) {
    const key = String(name);
    if (Object.prototype.hasOwnProperty.call(this.attrs, key)) return this.attrs[key];
    return null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, String(name));
  }

  removeAttribute(name) {
    const key = String(name);
    delete this.attrs[key];
    if (key === 'id') this.id = '';
    else if (key === 'class') this._classes = new Set();
    else if (key === 'hidden') this.hidden = false;
    else if (key === 'disabled') this.disabled = false;
    else if (key.startsWith('data-')) delete this.dataset[camelCase(key.slice(5))];
  }

  addEventListener(type, listener, options) {
    const key = String(type);
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    this._listeners.get(key).push({
      fn: listener,
      capture: options === true || !!(options && typeof options === 'object' && options.capture),
    });
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(String(type));
    if (!list) return;
    const index = list.findIndex((record) => (typeof record === 'function' ? record : record.fn) === listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatchEvent(event) {
    const payload = event || {};
    if (!payload.type) throw new Error('dispatchEvent without type');
    if (!payload.target) payload.target = this;
    if (!payload.preventDefault) payload.preventDefault = () => {};
    if (!payload.stopPropagation) {
      payload.stopPropagation = () => {
        payload._stopBubble = true;
      };
    }
    if (!payload.stopImmediatePropagation) {
      payload.stopImmediatePropagation = () => {
        payload._stopImmediate = true;
        payload._stopBubble = true;
      };
    }
    const doc = this.ownerDocument;
    const path = [];
    let node = this;
    while (node) {
      path.unshift(node);
      node = node.parentNode;
    }
    const invokeRecord = (record) => {
      if (typeof record === 'function') record(payload);
      else record.fn(payload);
    };
    const invokePhase = (element, capturePhase, includeAll) => {
      if (!element || !element._listeners) return false;
      for (const record of (element._listeners.get(payload.type) || []).slice()) {
        if (!includeAll) {
          const isCapture = typeof record === 'object' && record.capture === true;
          if (capturePhase !== isCapture) continue;
        }
        invokeRecord(record);
        if (payload._stopImmediate) return true;
        if (payload._stopBubble) return true;
      }
      return false;
    };
    // capture listeners on the document run first (the v0.3.6 click guard lives here)
    if (doc && doc._listeners) {
      for (const record of (doc._listeners.get(payload.type) || []).slice()) {
        if (!(typeof record === 'object' && record.capture === true)) continue;
        invokeRecord(record);
        if (payload._stopImmediate) return true;
        if (payload._stopBubble) return true;
      }
    }
    for (let index = 0; index < path.length - 1; index += 1) {
      if (invokePhase(path[index], true, false)) return true;
    }
    // target phase: all listeners are invoked regardless of their capture flag
    if (invokePhase(this, false, true)) return true;
    for (let index = path.length - 2; index >= 0; index -= 1) {
      if (payload._stopBubble) break;
      if (invokePhase(path[index], false, false)) return true;
    }
    return true;
  }

  click() {
    return this.dispatchEvent({ type: 'click', target: this });
  }

  focus() {}
  blur() {}
  select() {}

  getBoundingClientRect() {
    return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24 };
  }

  closest(selector) {
    const chains = selectorChains(selector);
    let node = this;
    while (node) {
      for (const chain of chains) {
        if (matchesChain(node, chain, chain.length - 1)) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    collect(this, selector, results);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/* simple selector chains: tag / .class / #id / [attr] / [attr="v"], comma groups */
function selectorChains(selector) {
  return String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+(?![^\[]*\])/).map((item) => item.trim()).filter(Boolean));
}

function matchesSimple(element, part) {
  if (!element || !part) return false;
  let cursor = 0;
  const tagMatch = part.slice(cursor).match(/^[a-zA-Z][\w-]*/);
  let tag = '';
  if (tagMatch) {
    tag = tagMatch[0].toUpperCase();
    cursor += tagMatch[0].length;
  }
  if (tag && element.tagName !== tag) return false;
  const rest = part.slice(cursor);
  const idMatch = rest.match(/^#([\w-]+)/);
  if (idMatch) {
    if (element.id !== idMatch[1]) return false;
    cursor += idMatch[0].length;
  }
  const body = part.slice(cursor);
  for (const classMatch of body.matchAll(/\.([\w-]+)/g)) {
    if (!element._classes.has(classMatch[1])) return false;
  }
  for (const attrMatch of body.matchAll(/\[([\w-]+)(?:([*^$~|]?=)"([^"]*)")?\]/g)) {
    const name = attrMatch[1];
    const operator = attrMatch[2] || '';
    const expected = attrMatch[3];
    let actual;
    if (name === 'id') actual = element.id;
    else if (name === 'class') actual = element.className;
    else if (name.startsWith('data-')) actual = element.dataset[camelCase(name.slice(5))];
    else actual = element.attrs[name];
    if (!operator || expected === undefined) {
      if (actual === undefined || actual === null) return false;
      continue;
    }
    const actualString = actual === undefined || actual === null ? '' : String(actual);
    if (operator === '=' && actualString !== expected) return false;
    if (operator === '*=' && !actualString.includes(expected)) return false;
    if (operator === '^=' && !actualString.startsWith(expected)) return false;
    if (operator === '$=' && !actualString.endsWith(expected)) return false;
    if (operator === '~=' && !actualString.split(/\s+/).includes(expected)) return false;
  }
  return true;
}

function matchesChain(element, chain, index) {
  if (!element) return false;
  if (!matchesSimple(element, chain[index])) return false;
  if (index === 0) return true;
  let parent = element.parentNode;
  while (parent) {
    if (matchesChain(parent, chain, index - 1)) return true;
    parent = parent.parentNode;
  }
  return false;
}

function collect(root, selector, results) {
  const chains = selectorChains(selector);
  if (!chains.length) return;
  const walk = (node) => {
    for (const child of node.children) {
      if (chains.some((chain) => matchesChain(child, chain, chain.length - 1))) results.push(child);
      walk(child);
    }
  };
  walk(root);
}

function createDocumentShell(title) {
  const doc = {
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    title: title || '',
    _byId: new Map(),
    _listeners: new Map(),
    createElement(tagName) {
      return new FakeElement(tagName, doc);
    },
    createTextNode(text) {
      const node = new FakeElement('#text', doc);
      node._text = String(text == null ? '' : text);
      return node;
    },
    getElementById(id) {
      return doc._byId.get(String(id)) || null;
    },
    querySelector(selector) {
      const results = [];
      collect(doc.documentElement, selector, results);
      return results[0] || null;
    },
    querySelectorAll(selector) {
      const results = [];
      collect(doc.documentElement, selector, results);
      return results;
    },
    addEventListener(type, listener, options) {
      const key = String(type);
      if (!doc._listeners.has(key)) doc._listeners.set(key, []);
      doc._listeners.get(key).push({
        fn: listener,
        capture: options === true || !!(options && typeof options === 'object' && options.capture),
      });
    },
    removeEventListener() {},
    dispatchEvent(event) {
      for (const record of doc._listeners.get(String(event && event.type)) || []) {
        if (typeof record === 'function') record(event);
        else record.fn(event);
      }
      return true;
    },
    execCommand() {
      return true;
    },
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.head = new FakeElement('head', doc);
  doc.body = new FakeElement('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

function buildShellDocument(html) {
  const doc = createDocumentShell('');
  const stack = [doc.body];
  const tagPattern = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  let prevEnd = 0;
  let skipUntil = '';
  while ((match = tagPattern.exec(html))) {
    const closing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const attrText = match[3] || '';
    const selfClosing = match[4] === '/';

    // capture text between tags into the current element (needed for button copy)
    if (!skipUntil) {
      const chunk = html.slice(prevEnd, match.index);
      if (chunk.trim() && stack.length) {
        const top = stack[stack.length - 1];
        top._text += chunk.replace(/\s+/g, ' ');
      }
    }
    prevEnd = tagPattern.lastIndex;

    if (skipUntil) {
      if (closing && tagName === skipUntil) skipUntil = '';
      continue;
    }
    if (!closing && (tagName === 'script' || tagName === 'style')) {
      skipUntil = tagName;
      continue;
    }
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName === tagName.toUpperCase()) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    if (!stack.length) break;
    const element = doc.createElement(tagName);
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrText))) {
      const name = attrMatch[1];
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      element.setAttribute(name, value);
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tagName)) stack.push(element);
  }
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  if (titleMatch) doc.title = titleMatch[1];
  return doc;
}

const shellDoc = buildShellDocument(INDEX_HTML);

/* ================================================================== */
/* fake browser globals + mocked backend                               */
/* ================================================================== */

const ANDROID_APP_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 DSHMobileApp/0.1';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const server = {
  paired: false,
  offline: false,
  pin: '123456',
  pairCalls: 0,
  apkStatus: 404,
};

const counters = {
  newSession: 0,
  sessionClicks: [],
  nativeSettings: 0,
  toggles: 0,
  addWorkspaceSidebar: 0,
  addWorkspaceMenu: 0,
  workspaceSwitchClicks: 0,
  workspaceMenuOpens: 0,
  uploadClicks: 0,
  variantClicks: 0,
  emptyChooserClicks: 0,
};

function jsonResponse(status, payload, headers) {
  const map = new Map(Object.entries(headers || {}));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

async function mockFetch(url, options) {
  const opts = options || {};
  if (server.offline) throw new TypeError('mock: network offline');
  const path = String(url);
  if (path === '/m/api/state') {
    return jsonResponse(200, {
      ok: true,
      paired: server.paired,
      host: '192.168.17.174:7860',
      dshUrl: '/',
      pinRequired: true,
    });
  }
  if (path === '/m/api/pair') {
    server.pairCalls += 1;
    const body = JSON.parse(opts.body || '{}');
    const code = String(body.code || '');
    if (code === server.pin) {
      return jsonResponse(200, {
        ok: true,
        url: 'http://mock.local/?token=MOCK-LOGIN-TOKEN',
        expiresInMs: 600000,
      });
    }
    if (code === '999999') {
      return jsonResponse(429, { ok: false, error: 'locked', retryAfterMs: 30000 }, { 'retry-after': '30' });
    }
    return jsonResponse(401, { ok: false, error: 'bad-pin', attemptsLeft: 7 });
  }
  if (path === './download/DSH-Mobile.apk') {
    return jsonResponse(server.apkStatus, {});
  }
  throw new Error('mock fetch: unexpected url ' + path);
}

const localStorageMap = new Map();
const trackedIntervals = new Set();
const trackedSetInterval = (fn, ms) => {
  const id = setInterval(fn, ms);
  trackedIntervals.add(id);
  return id;
};
const trackedClearInterval = (id) => {
  trackedIntervals.delete(id);
  clearInterval(id);
};

const windowListeners = new Map();
const visualViewportListeners = new Map();
const visualViewport = {
  height: 844,
  width: 390,
  addEventListener(type, listener) {
    const key = String(type);
    if (!visualViewportListeners.has(key)) visualViewportListeners.set(key, []);
    visualViewportListeners.get(key).push(listener);
  },
  removeEventListener() {},
};

function fireVisualViewportResize(height) {
  visualViewport.height = height;
  for (const listener of visualViewportListeners.get('resize') || []) listener({ type: 'resize' });
}

const locationObject = {
  href: APP_MODE ? 'http://mock.local/m/?app=1' : 'http://mock.local/m/',
  origin: 'http://mock.local',
  host: 'mock.local',
  hostname: 'mock.local',
  pathname: '/m/',
  search: APP_MODE ? '?app=1' : '',
  assign: () => {},
};

const windowObject = {
  document: shellDoc,
  navigator: {
    userAgent: APP_MODE ? ANDROID_APP_UA : IPHONE_UA,
    standalone: false,
    clipboard: undefined,
  },
  location: locationObject,
  screen: { width: 390, height: 844 },
  innerWidth: 390,
  innerHeight: 844,
  devicePixelRatio: 3,
  visualViewport,
  localStorage: {
    getItem: (key) => (localStorageMap.has(String(key)) ? localStorageMap.get(String(key)) : null),
    setItem: (key, value) => localStorageMap.set(String(key), String(value)),
    removeItem: (key) => localStorageMap.delete(String(key)),
  },
  matchMedia: (query) => ({
    matches: false,
    media: String(query),
    addEventListener() {},
    removeEventListener() {},
  }),
  setTimeout,
  clearTimeout,
  setInterval: trackedSetInterval,
  clearInterval: trackedClearInterval,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  performance: { now: () => Date.now() },
  fetch: mockFetch,
  getComputedStyle: () => ({ height: '0px', getPropertyValue: () => '' }),
  postMessage(data) {
    const payload = { type: 'message', data, origin: locationObject.origin, target: windowObject };
    for (const listener of (windowListeners.get('message') || []).slice()) listener(payload);
  },
  addEventListener(type, listener) {
    const key = String(type);
    if (!windowListeners.has(key)) windowListeners.set(key, []);
    windowListeners.get(key).push(listener);
  },
  removeEventListener() {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  DshApp: APP_MODE
    ? {
        getTopInsetPx: () => 24,
        openSettings: () => {
          counters.nativeSettings += 1;
        },
        reload: () => {},
        exitApp: () => {},
      }
    : undefined,
};

let guiDocument = createGuiDocument(true);
let altGuiDocument = createGuiDocument(false, { withToggle: false, collapsed: false, minimal: true });
let authDocument = null;

/**
 * Fake real-DSH GUI with the v0.3.2 sidebar DOM facts:
 *   - frame carries data-sidebar-collapsed="true" while collapsed (attribute is
 *     removed when expanded), its first child is the sidebar column;
 *   - toggle button aria-label switches 打开侧边栏 ↔ 收起侧边栏;
 *   - sidebar contains brand / newSession / panelRow / workspace / account rows.
 */
function createGuiDocument(withSessions, options) {
  const opts = options || {};
  const withToggle = opts.withToggle !== false;
  const doc = createDocumentShell('DeepSeek Harness');
  const frame = doc.createElement('div');
  frame.className = 'app-shell-frame';
  if (opts.minimal) {
    const center = doc.createElement('div');
    center.className = 'center-col';
    center.textContent = '中心内容';
    const bottom = doc.createElement('div');
    bottom.setAttribute('data-shell-bottom', 'true');
    frame.appendChild(center);
    frame.appendChild(bottom);
    doc.body.appendChild(frame);
    return doc;
  }
  if (opts.collapsed !== false) frame.setAttribute('data-sidebar-collapsed', 'true');

  const sidebar = doc.createElement('div');
  sidebar.className = 'sidebar-root';

  const brand = doc.createElement('div');
  brand.className = 'sidebar-brand';
  brand.textContent = 'DSH Mobile';
  sidebar.appendChild(brand);

  if (withToggle) {
    const toggle = doc.createElement('button');
    toggle.setAttribute(
      'aria-label',
      frame.hasAttribute('data-sidebar-collapsed') ? '打开侧边栏' : '收起侧边栏',
    );
    toggle.textContent = '侧边栏';
    toggle.addEventListener('click', () => {
      counters.toggles += 1;
      if (frame.hasAttribute('data-sidebar-collapsed')) {
        frame.removeAttribute('data-sidebar-collapsed');
        toggle.setAttribute('aria-label', '收起侧边栏');
      } else {
        frame.setAttribute('data-sidebar-collapsed', 'true');
        toggle.setAttribute('aria-label', '打开侧边栏');
      }
    });
    sidebar.appendChild(toggle);
  }

  const newSession = doc.createElement('button');
  newSession.setAttribute('aria-label', '新建会话');
  newSession.textContent = '新建会话';
  newSession.addEventListener('click', () => {
    counters.newSession += 1;
  });
  sidebar.appendChild(newSession);

  const panelRow = doc.createElement('div');
  panelRow.className = 'sidebar-panelRow';
  panelRow.setAttribute('aria-label', '插件');
  panelRow.textContent = '插件';
  sidebar.appendChild(panelRow);

  // v0.3.6: desktop-native dialog entry (real GUI: button[aria-label="添加工作区"])
  const addWorkspace = doc.createElement('button');
  addWorkspace.setAttribute('aria-label', '添加工作区');
  addWorkspace.textContent = '添加工作区';
  addWorkspace.addEventListener('click', () => {
    counters.addWorkspaceSidebar += 1;
  });
  sidebar.appendChild(addWorkspace);

  const workspace = doc.createElement('div');
  workspace.className = 'workspace-list';

  const workspaceMenu = doc.createElement('div');
  workspaceMenu.setAttribute('role', 'menu');
  workspaceMenu.hidden = true;
  const switchItem = doc.createElement('button');
  switchItem.setAttribute('role', 'menuitem');
  switchItem.textContent = '默认工作区';
  switchItem.addEventListener('click', () => {
    counters.workspaceSwitchClicks += 1;
  });
  const addMenu = doc.createElement('button');
  addMenu.setAttribute('role', 'menuitem');
  addMenu.textContent = '添加工作区…';
  addMenu.addEventListener('click', () => {
    counters.addWorkspaceMenu += 1;
  });
  workspaceMenu.append(switchItem, addMenu);

  // live GUI: the workspace switcher lives inside the composer region and
  // displays the real workspace name -> must stay usable (not blocked).
  const composer = doc.createElement('div');
  composer.className = 'composerStack';
  composer.setAttribute('data-conversation-region', 'composer');
  composer.setAttribute('data-slot', 'conversation.composer');
  const workspaceTrigger = doc.createElement('button');
  workspaceTrigger.textContent = '默认工作区';
  workspaceTrigger.setAttribute('aria-label', '选择工作区');
  workspaceTrigger.setAttribute('aria-haspopup', 'menu');
  workspaceTrigger.addEventListener('click', () => {
    counters.workspaceMenuOpens += 1;
    if (workspaceMenu.parentNode) {
      workspaceMenu.remove();
      return;
    }
    workspaceMenu.hidden = false;
    doc.body.appendChild(workspaceMenu);
  });
  composer.appendChild(workspaceTrigger);
  workspace.appendChild(composer);

  if (withSessions) {
    const sessionList = doc.createElement('div');
    sessionList.className = 'session-list';
    for (const title of ['如何打开工作区', '移动端首页重设计', 'APK 全屏模式验收']) {
      const row = doc.createElement('button');
      row.textContent = title;
      row.addEventListener('click', () => counters.sessionClicks.push(title));
      sessionList.appendChild(row);
    }
    workspace.appendChild(sessionList);
  } else {
    const empty = doc.createElement('div');
    empty.className = 'workspace-empty';
    empty.textContent = '默认工作区';
    workspace.appendChild(empty);
  }
  sidebar.appendChild(workspace);

  const upload = doc.createElement('button');
  upload.setAttribute('aria-label', '上传文件');
  upload.textContent = '上传文件';
  upload.addEventListener('click', () => {
    counters.uploadClicks += 1;
  });
  sidebar.appendChild(upload);

  const account = doc.createElement('button');
  account.setAttribute('aria-label', '账号菜单');
  account.textContent = '账号';
  sidebar.appendChild(account);

  // matcher variants that must all be hidden by the guard (current build may
  // only render 添加工作区, other DSH versions use these labels)
  const variants = doc.createElement('div');
  variants.className = 'variant-probes';
  for (const label of ['打开工作区', '新建工作区', '打开文件夹', '打开目录', '选择文件夹', '选择目录', '打开方式']) {
    const probe = doc.createElement('button');
    probe.setAttribute('aria-label', label);
    probe.textContent = label;
    probe.addEventListener('click', () => {
      counters.variantClicks += 1;
    });
    variants.appendChild(probe);
  }
  const openIn = doc.createElement('button');
  openIn.textContent = 'Open in new window';
  openIn.addEventListener('click', () => {
    counters.variantClicks += 1;
  });
  variants.appendChild(openIn);
  const addText = doc.createElement('button');
  addText.textContent = '添加工作区';
  addText.addEventListener('click', () => {
    counters.variantClicks += 1;
  });
  variants.appendChild(addText);
  doc.body.appendChild(variants);

  const center = doc.createElement('div');
  center.className = 'center-col';
  center.textContent = '中心内容';
  const rightbar = doc.createElement('div');
  rightbar.setAttribute('data-rightbar-col', 'true');
  const bottom = doc.createElement('div');
  bottom.setAttribute('data-shell-bottom', 'true');
  frame.appendChild(sidebar);
  frame.appendChild(center);
  frame.appendChild(rightbar);
  frame.appendChild(bottom);
  doc.body.appendChild(frame);
  return doc;
}

function createAuthDocument() {
  const doc = createDocumentShell('');
  doc.body.textContent = 'dsh web authentication required; reopen the URL printed by dsh web.';
  return doc;
}

/**
 * Empty-workspace DSH instance (isolated test DSH): the 选择工作区 chooser opens
 * the desktop native directory picker instead of a workspace dropdown, so the
 * v0.3.6 empty-state guard must hide/block it while sessions stay usable.
 */
function createEmptyWorkspaceGuiDocument() {
  const doc = createDocumentShell('DeepSeek Harness');
  const banner = doc.createElement('div');
  banner.className = 'workspace-warning';
  banner.textContent = '无法创建默认工作区，请通过"选择工作区"选择文件夹';
  doc.body.appendChild(banner);

  const frame = doc.createElement('div');
  frame.className = 'app-shell-frame';
  frame.setAttribute('data-sidebar-collapsed', 'true');
  const sidebar = doc.createElement('div');
  sidebar.className = 'sidebar-root';

  // The empty-state chooser lives inside the composer region in the real GUI
  // (ancestor: composerStack[data-conversation-region="composer"]) — this is the
  // v0.3.6 regression: it must be checked BEFORE the composer exclusion.
  const emptyComposer = doc.createElement('div');
  emptyComposer.className = 'composerStack';
  emptyComposer.setAttribute('data-conversation-region', 'composer');
  const chooser = doc.createElement('button');
  chooser.setAttribute('aria-label', '选择工作区');
  chooser.setAttribute('aria-haspopup', 'menu');
  chooser.textContent = '选择工作区';
  chooser.addEventListener('click', () => {
    counters.emptyChooserClicks += 1;
  });
  emptyComposer.appendChild(chooser);
  sidebar.appendChild(emptyComposer);

  const add = doc.createElement('button');
  add.setAttribute('aria-label', '添加工作区');
  add.textContent = '添加工作区';
  add.addEventListener('click', () => {
    counters.addWorkspaceSidebar += 1;
  });
  sidebar.appendChild(add);

  const empty = doc.createElement('div');
  empty.className = 'workspace-empty';
  empty.textContent = '选择一个工作区开始';
  sidebar.appendChild(empty);

  const sessionList = doc.createElement('div');
  sessionList.className = 'session-list';
  const row = doc.createElement('button');
  row.textContent = '如何打开工作区';
  row.addEventListener('click', () => counters.sessionClicks.push('empty-state row'));
  sessionList.appendChild(row);
  sidebar.appendChild(sessionList);

  const center = doc.createElement('div');
  center.className = 'center-col';
  center.textContent = '中心内容';
  const bottom = doc.createElement('div');
  bottom.setAttribute('data-shell-bottom', 'true');
  frame.appendChild(sidebar);
  frame.appendChild(center);
  frame.appendChild(bottom);
  doc.body.appendChild(frame);
  return doc;
}

authDocument = createAuthDocument();

function installIframeHook(doc) {
  doc._iframeHook = (frame, src) => {
    if (!src || src === 'about:blank') {
      frame.contentDocument = null;
      setTimeout(() => frame.dispatchEvent({ type: 'load', target: frame }), 1);
      return;
    }
    if (src.includes('token=')) {
      server.paired = true;
      setTimeout(() => frame.dispatchEvent({ type: 'load', target: frame }), 5);
      return;
    }
    if (src.charAt(0) === '/') {
      frame.contentDocument = guiDocument;
      frame.contentWindow = {
        location: {
          reload: () => {
            frame.contentDocument = guiDocument;
            setTimeout(() => frame.dispatchEvent({ type: 'load', target: frame }), 5);
          },
        },
        scrollY: 0,
        addEventListener() {},
      };
      setTimeout(() => frame.dispatchEvent({ type: 'load', target: frame }), 5);
    }
  };
}

installIframeHook(shellDoc);

const sandbox = {
  window: windowObject,
  document: shellDoc,
  navigator: windowObject.navigator,
  location: locationObject,
  fetch: mockFetch,
  setTimeout,
  clearTimeout,
  setInterval: trackedSetInterval,
  clearInterval: trackedClearInterval,
  requestAnimationFrame: windowObject.requestAnimationFrame,
  cancelAnimationFrame: windowObject.cancelAnimationFrame,
  performance: windowObject.performance,
  localStorage: windowObject.localStorage,
  getComputedStyle: windowObject.getComputedStyle,
  MutationObserver: windowObject.MutationObserver,
  URL,
  URLSearchParams,
  AbortController,
  console,
  queueMicrotask,
};
vm.createContext(sandbox);

/* ================================================================== */
/* test harness                                                        */
/* ================================================================== */

const results = [];
const unhandled = [];
process.on('uncaughtException', (error) => unhandled.push(error));
process.on('unhandledRejection', (error) => unhandled.push(error));

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function record(name, ok, details) {
  results.push({ name, ok: !!ok, details: details || '' });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !details ? '' : '\n       ↳ ' + details}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message || 'expectation failed');
}

const $ = (id) => shellDoc.getElementById(id);
const $$ = (selector) => shellDoc.querySelectorAll(selector);
const app = () => $('app');

function find(selector) {
  return shellDoc.querySelector(selector);
}

function click(selector) {
  const element = find(selector);
  expect(element, 'missing clickable ' + selector);
  element.click();
  return element;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 3000);
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch (_) {
      /* keep waiting */
    }
    await sleep(25);
  }
  throw new Error('timeout waiting for ' + (label || 'condition'));
}

function status() {
  return windowObject.__DSH_MOBILE__ ? windowObject.__DSH_MOBILE__.getStatus() : null;
}

function pressPin(digits) {
  for (const digit of String(digits)) {
    click('[data-key="' + digit + '"]');
  }
}

function bootApp() {
  vm.runInContext(APP_JS, sandbox, { filename: 'app.js' });
}

/* ================================================================== */
/* browser-mode scenario                                               */
/* ================================================================== */

async function runBrowserScenario() {
  bootApp();
  await waitFor(() => $('pairingView') && $('pairingView').hidden === false, 3000, 'pairing view');
  record('boot: unpaired state shows the pairing screen', true);

  /* ---------------- pairing screen basics ---------------- */
  try {
    expect($$('.pin-cell').length === 6, 'expected 6 pin cells');
    expect($('bootView').hidden === true, 'boot view should be hidden');
    expect(status().screen === 'pair', 'expected pair screen, got ' + status().screen);
    record('pairing screen: 6 PIN cells + 11-key numeric keypad', true);
  } catch (error) {
    record('pairing screen: 6 PIN cells + 11-key numeric keypad', false, error.message);
  }
  try {
    expect($$('[data-key]').length === 11, 'expected 11 keypad keys');
    pressPin('123456');
    await waitFor(() => status().screen === 'chat' && status().frameLoaded, 8000, 'chat screen + GUI');
    expect(server.pairCalls >= 1, 'expected a /m/api/pair call');
    expect($('guiFrame').getAttribute('src') === '/', 'guiFrame src should be "/"');
    const guiFrame = $('guiFrame');
    const guiDoc = guiFrame.contentDocument;
    expect(guiDoc, 'GUI document should be attached');
    const style = guiDoc.getElementById('dsh-mobile-adaptive-style');
    expect(style, 'adaptive style should be injected');
    expect(style.textContent.includes('100dvh'), 'injected css 100dvh');
    expect(style.textContent.includes('env(safe-area-inset-bottom'), 'injected css safe-area');
    expect(style.textContent.includes('[data-shell-bottom]'), 'injected css shell hooks');
    expect(style.textContent.includes('font-size: max(16px, 1em)'), 'injected css iOS zoom guard');
    for (const token of [
      '[data-sidebar-collapsed="true"]',
      'grid-template-columns: 0px minmax(0px, 1fr) minmax(0px, 0px)',
      'visibility: hidden',
      '[class*="brand"]',
      '[class*="newSession"]',
      '[class*="panelRow"]',
      '[aria-label="插件"]',
      '[aria-label="自动化任务"]',
      '[aria-label="账号菜单"]',
      // v0.3.6 desktop-dialog guard CSS
      '[aria-label*="打开工作区"]',
      '[aria-label*="新建工作区"]',
      '[aria-label*="打开文件夹"]',
      '[aria-label*="选择目录"]',
      '[aria-label*="Open in"]',
      '[data-dsh-mobile-blocked="1"]',
    ]) {
      expect(style.textContent.includes(token), 'injected css missing rule ' + token);
    }
    expect(guiDoc.documentElement.classList.contains('dsh-mobile'), 'dsh-mobile class on GUI html');
    expect(status().paired === true, 'shell should be paired');
    record('pairing: keypad -> pair -> hidden iframe cookie -> real GUI iframe', true);
  } catch (error) {
    record('pairing: keypad -> pair -> hidden iframe cookie -> real GUI iframe', false, error.message);
  }

  /* ---------------- iframe 401 auth loss ---------------- */
  try {
    server.paired = false; // the cookie is gone when the GUI returns its 401 page
    const guiFrame = $('guiFrame');
    guiFrame.contentDocument = authDocument;
    guiFrame.dispatchEvent({ type: 'load', target: guiFrame });
    await waitFor(() => status().screen === 'pair', 3000, 'pair screen after auth loss');
    await sleep(60);
    expect($('pairHint').textContent.includes('登录状态已失效'), 'auth-loss hint shown: ' + $('pairHint').textContent);
    record('iframe 401/auth page -> back to pairing view', true);
  } catch (error) {
    record('iframe 401/auth page -> back to pairing view', false, error.message);
  }

  /* ---------------- Dock 会话 toggles the real GUI sidebar (v0.3.2) ---------------- */
  try {
    server.paired = false;
    pressPin('123456');
    await waitFor(() => status().screen === 'chat' && status().frameLoaded, 8000, 're-paired chat');
    await sleep(700); // availability probes

    windowObject.__DSH_MOBILE__.refreshQuickAvailable();
    const quick = windowObject.__DSH_MOBILE__.getStatus().quickActions;
    expect(quick.sidebar === true, 'sidebar toggle should resolve via aria-label');
    expect(quick.newSession === true, 'new-session action should resolve via aria-label');
    expect(find('.dock-btn[data-dock="new"]').classList.contains('is-unavailable') === false, 'dock new visible');

    const guiFrameElement = $('guiFrame');
    expect(
      guiFrameElement.contentDocument.querySelector('[data-sidebar-collapsed="true"]'),
      'main screen: GUI frame should carry data-sidebar-collapsed="true"',
    );
    expect(status().sidebarExpanded === false, 'collapsed sidebar state');
    expect(!find('.dock-btn[data-dock="sessions"]').classList.contains('is-active'), 'dock sessions not active');

    // 1) tap Dock 会话 -> real GUI sidebar expands, shell drawer stays unused
    click('.dock-btn[data-dock="sessions"]');
    await waitFor(
      () => !guiFrameElement.contentDocument.querySelector('[data-sidebar-collapsed]'),
      2500,
      'real GUI sidebar expanded',
    );
    await sleep(80);
    expect(
      guiFrameElement.contentDocument.querySelector('button[aria-label="收起侧边栏"]'),
      'toggle flips to 收起侧边栏',
    );
    expect(status().sidebarExpanded === true, 'status sidebarExpanded true after opening');
    expect(!$('drawer').classList.contains('is-open'), 'shell drawer must not open when the real toggle works');
    expect(find('.dock-btn[data-dock="sessions"]').classList.contains('is-active'), 'dock sessions selected');

    // 2) tap Dock 会话 again -> collapse, full-width main content restored
    click('.dock-btn[data-dock="sessions"]');
    await waitFor(
      () => guiFrameElement.contentDocument.querySelector('[data-sidebar-collapsed="true"]'),
      2500,
      'real GUI sidebar collapsed again',
    );
    await sleep(80);
    expect(status().sidebarExpanded === false, 'status sidebarExpanded false after closing');
    expect(!$('drawer').classList.contains('is-open'), 'shell drawer still unused');
    expect(!find('.dock-btn[data-dock="sessions"]').classList.contains('is-active'), 'dock sessions unselected');

    // 3) other Dock actions unchanged
    click('.dock-btn[data-dock="new"]');
    await sleep(50);
    expect(counters.newSession === 1, 'dock 新建 should click the real GUI button, got ' + counters.newSession);
    click('.dock-btn[data-dock="more"]');
    await waitFor(() => $('quickSheet').classList.contains('is-open'), 2000, 'quick sheet open');
    click('#diagBtn');
    await waitFor(() => status().screen === 'settings', 2000, 'settings screen from diagnostics');
    record('dock 会话 toggles real GUI sidebar (drawer unused) + new-session/quick sheet intact', true);
  } catch (error) {
    record('dock 会话 toggles real GUI sidebar (drawer unused) + new-session/quick sheet intact', false, error.message);
  }

  /* ---------------- Dock 会话 fallback: shell drawer only when toggle is unavailable ---------------- */
  try {
    windowObject.__DSH_MOBILE__.showScreen('chat');
    guiDocument = altGuiDocument; // no sidebar toggle at all
    $('guiFrame').contentDocument = altGuiDocument;
    $('guiFrame').dispatchEvent({ type: 'load', target: $('guiFrame') });
    await sleep(220);
    click('.dock-btn[data-dock="sessions"]');
    await waitFor(() => $('drawer').classList.contains('is-open'), 2500, 'fallback drawer open');
    await waitFor(() => $('drawerFallback').hidden === false, 4000, 'drawer fallback visible');
    expect($('drawerFallback').textContent.includes('打开桌面会话列表'), 'fallback copy');
    record('Dock 会话 fallback: shell drawer only when GUI toggle is unavailable', true);
  } catch (error) {
    record('Dock 会话 fallback: shell drawer only when GUI toggle is unavailable', false, error.message);
  }

  /* ---------------- v0.3.6 desktop-dialog guard ---------------- */
  try {
    // restore the rich GUI fixture (the fallback test replaced it)
    guiDocument = createGuiDocument(true);
    $('guiFrame').contentDocument = guiDocument;
    $('guiFrame').dispatchEvent({ type: 'load', target: $('guiFrame') });
    await sleep(280);
    const doc = $('guiFrame').contentDocument;
    const style = doc.getElementById('dsh-mobile-adaptive-style');
    for (const token of [
      '[aria-label*="打开工作区"]',
      '[aria-label*="新建工作区"]',
      '[aria-label*="打开文件夹"]',
      '[aria-label*="选择文件夹"]',
      '[aria-label*="选择目录"]',
      '[aria-label*="打开方式"]',
      '[aria-label*="Open in"]',
      '[data-dsh-mobile-blocked="1"]',
    ]) {
      expect(style.textContent.includes(token), 'guard css missing ' + token);
    }

    const variants = [...doc.querySelectorAll('.variant-probes button')];
    expect(variants.length >= 9, 'expected variant probes, got ' + variants.length);
    const marked = variants.filter(
      (button) => button.getAttribute('data-dsh-mobile-blocked') === '1' && button.style.display === 'none',
    );
    expect(marked.length === variants.length, `expected all ${variants.length} variants hidden, got ${marked.length}`);

    const addSidebar = doc.querySelector('button[aria-label="添加工作区"]');
    expect(addSidebar, 'sidebar add-workspace button (real GUI entry)');
    expect(addSidebar.getAttribute('data-dsh-mobile-blocked') === '1', 'sidebar 添加工作区 must be flagged hidden');
    expect(addSidebar.style.display === 'none', 'sidebar 添加工作区 style.display none');

    const workspaceTrigger = doc.querySelector('button[aria-label="选择工作区"]');
    expect(workspaceTrigger, '选择工作区 trigger (live GUI: displays workspace name)');
    expect(workspaceTrigger.textContent.includes('默认工作区'), 'live workspace trigger should display a real workspace name');
    expect(workspaceTrigger.getAttribute('data-dsh-mobile-blocked') === null, '选择工作区 must NOT be blocked');

    // dynamic dropdown: open 选择工作区 menu -> only the desktop-dialog item is hidden
    workspaceTrigger.click();
    await sleep(220);
    const menuItems = [...doc.querySelectorAll('[role="menuitem"]')];
    expect(menuItems.length >= 2, 'workspace menu should open with items, got ' + menuItems.length);
    const switchItem = menuItems.find((item) => /默认工作区/.test(item.textContent));
    const addItem = menuItems.find((item) => /添加工作区/.test(item.textContent));
    expect(switchItem, 'existing workspace item in menu');
    expect(switchItem.getAttribute('data-dsh-mobile-blocked') === null, 'existing workspace item must NOT be blocked');
    expect(addItem, '添加工作区… menu item');
    expect(addItem.getAttribute('data-dsh-mobile-blocked') === '1', 'menu 添加工作区… must be flagged hidden');
    expect(addItem.style.display === 'none', 'menu item style.display none');

    // capture click guard: hidden entry cannot reach the GUI handler, shell toast via postMessage
    const sidebarClicksBefore = counters.addWorkspaceSidebar;
    addSidebar.click();
    await waitFor(() => $('appToast').classList.contains('is-visible'), 2500, 'blocked-action shell toast');
    expect(counters.addWorkspaceSidebar === sidebarClicksBefore, 'blocked click must not reach the GUI handler');
    expect($('appToast').textContent.includes('手机端暂不支持该操作'), 'blocked toast text: ' + $('appToast').textContent);
    expect(String(status().blockedAction || '').includes('添加工作区'), 'blocked action recorded: ' + status().blockedAction);
    const variantsBefore = counters.variantClicks;
    variants[0].click();
    expect(counters.variantClicks === variantsBefore, 'variant dialog action must be blocked');
    const menuClicksBefore = counters.addWorkspaceMenu;
    addItem.click();
    expect(counters.addWorkspaceMenu === menuClicksBefore, 'menu dialog action must be blocked');

    // no false positives: switcher, existing workspace, session row, upload all work
    workspaceTrigger.click(); // close menu
    await sleep(30);
    workspaceTrigger.click(); // reopen
    await sleep(80);
    switchItem.click();
    expect(counters.workspaceSwitchClicks === 1, 'existing workspace switch must remain usable');
    const sessionRow = [...doc.querySelectorAll('.session-list button')].find((button) =>
      button.textContent.includes('如何打开工作区'),
    );
    expect(sessionRow, 'session row containing dialog-like words');
    sessionRow.click();
    expect(counters.sessionClicks.length >= 1, 'session row must remain clickable');
    const upload = doc.querySelector('button[aria-label="上传文件"]');
    expect(upload, 'upload button');
    upload.click();
    expect(counters.uploadClicks === 1, 'upload must remain usable');
    record('desktop-dialog guard: add/open workspace variants hidden+blocked, switcher/session/upload intact', true);
  } catch (error) {
    record('desktop-dialog guard: add/open workspace variants hidden+blocked, switcher/session/upload intact', false, error.message);
  }

  /* ---------------- v0.3.6 empty-workspace desktop-dialog guard ---------------- */
  try {
    guiDocument = createEmptyWorkspaceGuiDocument();
    $('guiFrame').contentDocument = guiDocument;
    $('guiFrame').dispatchEvent({ type: 'load', target: $('guiFrame') });
    await sleep(300);
    windowObject.__DSH_MOBILE__.scanGuardedActions();
    const emptyDoc = $('guiFrame').contentDocument;
    const chooser = [...emptyDoc.querySelectorAll('button')].find((button) => /选择工作区/.test(button.textContent));
    expect(chooser, 'empty-state 选择工作区 chooser');
    expect(
      chooser.getAttribute('data-dsh-mobile-blocked') === '1',
      'empty-state chooser must be flagged blocked',
    );
    expect(chooser.style.display === 'none', 'empty-state chooser must be hidden');
    const emptyAdd = emptyDoc.querySelector('[aria-label="添加工作区"]');
    expect(
      emptyAdd && emptyAdd.getAttribute('data-dsh-mobile-blocked') === '1',
      'empty-state 添加工作区 must be hidden',
    );

    await sleep(850); // allow the guard toast dedupe window to expire
    const chooserBefore = counters.emptyChooserClicks;
    const sessionsBefore = counters.sessionClicks.length;
    chooser.click();
    await waitFor(() => $('appToast').classList.contains('is-visible'), 2500, 'empty-state blocked toast');
    expect(counters.emptyChooserClicks === chooserBefore, 'empty-state chooser click must be blocked');
    expect($('appToast').textContent.includes('手机端暂不支持'), 'empty-state toast text: ' + $('appToast').textContent);
    expect($('appToast').textContent.includes('工作区'), 'empty-state toast should mention workspace');
    expect(
      String(status().blockedAction || '').includes('选择工作区'),
      'empty-state blockedAction: ' + status().blockedAction,
    );

    // no false positives: session rows remain clickable in the empty state
    const emptySessionRow = [...emptyDoc.querySelectorAll('.session-list button')].find((button) =>
      button.textContent.includes('如何打开工作区'),
    );
    expect(emptySessionRow, 'empty-state session row');
    emptySessionRow.click();
    expect(counters.sessionClicks.length > sessionsBefore, 'session row must stay clickable in the empty state');

    // v0.3.6 regression: workspace data arrives AFTER the first empty-state
    // render. The early mark must be undone (unmark) so the real workspace
    // trigger becomes visible/clickable again, while 添加工作区 stays hidden.
    const warning = emptyDoc.querySelector('.workspace-warning');
    const emptyHint = emptyDoc.querySelector('.workspace-empty');
    if (warning) warning.remove();
    if (emptyHint) emptyHint.remove();
    chooser.textContent = '默认工作区';
    windowObject.__DSH_MOBILE__.scanGuardedActions();
    await sleep(40);
    expect(
      chooser.getAttribute('data-dsh-mobile-blocked') === null,
      'chooser must be unmarked after workspace data arrives',
    );
    expect(chooser.getAttribute('aria-hidden') === null, 'chooser aria-hidden must be cleared');
    expect(!chooser.style.display, 'chooser display must be restored (got ' + chooser.style.display + ')');
    expect(
      emptyAdd.getAttribute('data-dsh-mobile-blocked') === '1',
      '添加工作区 must remain hidden after the unmark scan',
    );
    const readyClicksBefore = counters.emptyChooserClicks;
    chooser.click();
    expect(
      counters.emptyChooserClicks === readyClicksBefore + 1,
      'workspace-ready chooser must be clickable again',
    );
    record(
      'empty-workspace guard: chooser blocked+toast, sessions intact, unmarked when workspace loads',
      true,
    );
  } catch (error) {
    record(
      'empty-workspace guard: chooser blocked+toast, sessions intact, unmarked when workspace loads',
      false,
      error.message,
    );
  }

  /* ---------------- settings / appearance / APK / disconnect ---------------- */
  try {
    windowObject.__DSH_MOBILE__.openSettings();
    await waitFor(() => status().screen === 'settings', 2000, 'settings screen');
    expect($('settingsOrigin').textContent.includes('mock.local'), 'origin shown: ' + $('settingsOrigin').textContent);
    expect($('settingsHost').textContent.includes('192.168.17.174'), 'desktop host shown');

    click('[data-set-theme="midnight"]');
    expect(app().dataset.theme === 'midnight', 'theme switch applies');
    click('[data-set-accent="violet"]');
    expect(app().style.getPropertyValue('--accent-a') === '#7c5cff', 'accent switch applies');
    const slider = $('fontScaleInput');
    slider.value = '110';
    slider.dispatchEvent({ type: 'input', target: slider });
    expect(app().style.getPropertyValue('--font-scale') === '1.1', 'font scale applies');
    expect(localStorageMap.get('dsh-mobile.interface-scale') === '110', 'font scale persisted');

    await sleep(100);
    click('#settingsDownloadApk');
    await sleep(120);
    expect($('appToast').textContent.includes('稍后可用'), 'APK 404 -> friendly toast: ' + $('appToast').textContent);

    click('#disconnectBtn');
    await waitFor(() => status().screen === 'pair', 2000, 'pair screen after disconnect');
    expect($('pairHint').textContent.includes('断开连接'), 'disconnect hint');
    record('settings: appearance vars persist + APK 404 fallback + disconnect', true);
  } catch (error) {
    record('settings: appearance vars persist + APK 404 fallback + disconnect', false, error.message);
  }

  /* ---------------- wrong PIN + 429 lockout ---------------- */
  try {
    const keypadButtons = $$('#keypad button');
    expect(keypadButtons.length === 11, 'keypad buttons');
    pressPin('000000');
    await waitFor(() => $('pairHint').textContent.includes('PIN 不正确'), 3000, 'bad-pin hint');
    expect($$('.pin-cell').every((cell) => !cell.value), 'PIN cells cleared after error');
    expect($('pairForm').classList.contains('is-shaking'), 'error shake class');

    pressPin('999999');
    await waitFor(() => $('pairHint').textContent.includes('尝试次数过多'), 3000, 'lockout hint');
    expect($$('#keypad button').every((button) => button.disabled === true), 'keypad disabled during lockout');
    record('pairing errors: bad-pin shake/clear + 429 lockout countdown', true);
  } catch (error) {
    record('pairing errors: bad-pin shake/clear + 429 lockout countdown', false, error.message);
  }

  /* ---------------- offline banner + keyboard flag ---------------- */
  try {
    server.offline = true;
    await windowObject.__DSH_MOBILE__.checkNow();
    await sleep(60);
    expect($('offlineBanner').classList.contains('is-visible'), 'offline banner visible');
    expect(app().dataset.conn === 'offline', 'connection dot offline');
    server.offline = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await windowObject.__DSH_MOBILE__.checkNow();
      await sleep(80);
      if (!$('offlineBanner').classList.contains('is-visible')) break;
    }
    expect(!$('offlineBanner').classList.contains('is-visible'), 'offline banner hidden after recovery');

    fireVisualViewportResize(500);
    expect(app().dataset.keyboard === 'open', 'keyboard-open flag');
    fireVisualViewportResize(844);
    expect(app().dataset.keyboard === 'closed', 'keyboard-closed flag');
    record('watchdog: offline banner recovery + visualViewport keyboard flag', true);
  } catch (error) {
    record('watchdog: offline banner recovery + visualViewport keyboard flag', false, error.message);
  }
}

/* ================================================================== */
/* APK-mode scenario                                                   */
/* ================================================================== */

async function runAppScenario() {
  bootApp();
  await waitFor(() => $('pairingView') && $('pairingView').hidden === false, 3000, 'pairing view (APK)');

  try {
    expect(status().appMode === true, 'APK mode should be detected from UA/?app=1');
    expect(app().dataset.mode === 'apk', 'app data-mode apk');
    expect(app().dataset.bars === 'hidden', 'APK capsule starts hidden');
    expect($('appHandle') !== null, 'APK recoverable handle exists');
    expect(status().topInset === 24, 'DshApp top inset 24px, got ' + status().topInset);
    expect(shellDoc.documentElement.style.getPropertyValue('--apk-top-inset') === '24px', 'apk inset css var');
    record('apk mode: UA + ?app=1 + DshApp -> full-screen chrome', true);
  } catch (error) {
    record('apk mode: UA + ?app=1 + DshApp -> full-screen chrome', false, error.message);
  }

  try {
    pressPin('123456');
    await waitFor(() => status().screen === 'chat' && status().frameLoaded, 8000, 'APK chat + GUI');
    const guiDoc = $('guiFrame').contentDocument;
    const style = guiDoc.getElementById('dsh-mobile-adaptive-style');
    expect(style, 'adaptive style injected');
    expect(style.textContent.includes('--dsh-mobile-app-top: 24px'), 'DshApp top inset injected into GUI css');
    expect(
      style.textContent.includes('grid-template-columns: 0px minmax(0px, 1fr) minmax(0px, 0px)'),
      'APK injected css hides the collapsed sidebar rail',
    );
    expect(
      style.textContent.includes('[aria-label*="打开工作区"]') &&
        style.textContent.includes('[data-dsh-mobile-blocked="1"]'),
      'APK injected css contains the desktop-dialog guard rules',
    );
    const apkAddWorkspace = guiDoc.querySelector('button[aria-label="添加工作区"]');
    expect(
      apkAddWorkspace && apkAddWorkspace.getAttribute('data-dsh-mobile-blocked') === '1',
      'APK guard flags the add-workspace entry hidden',
    );
    expect(guiDoc.documentElement.classList.contains('dsh-app-embed'), 'dsh-app-embed class in GUI');
    expect($('appSettingsBtn').hidden === false, 'native App settings entry visible in APK mode');
    windowObject.__DSH_MOBILE__.revealBars();
    expect(app().dataset.bars === 'shown', 'handle/reveal shows mini capsule');
    windowObject.__DSH_MOBILE__.hideBars();
    expect(app().dataset.bars === 'hidden', 'hideBars collapses capsule again');
    record('apk mode: pairing -> GUI + injected insets + reveal/hide mini bar', true);
  } catch (error) {
    record('apk mode: pairing -> GUI + injected insets + reveal/hide mini bar', false, error.message);
  }

  try {
    // v0.3.2: Dock 会话 works identically in APK mode (real GUI sidebar toggle)
    const guiFrameElement = $('guiFrame');
    expect(
      guiFrameElement.contentDocument.querySelector('[data-sidebar-collapsed="true"]'),
      'APK main screen: column marker present',
    );
    click('.dock-btn[data-dock="sessions"]');
    await waitFor(
      () => !guiFrameElement.contentDocument.querySelector('[data-sidebar-collapsed]'),
      2500,
      'APK sidebar expanded',
    );
    await sleep(80);
    expect(status().sidebarExpanded === true, 'APK sidebarExpanded true');
    expect(!$('drawer').classList.contains('is-open'), 'APK shell drawer unused');
    click('.dock-btn[data-dock="sessions"]');
    await waitFor(
      () => guiFrameElement.contentDocument.querySelector('[data-sidebar-collapsed="true"]'),
      2500,
      'APK sidebar collapsed',
    );
    record('apk mode: Dock 会话 toggles real GUI sidebar (rail hidden by injected css)', true);
  } catch (error) {
    record('apk mode: Dock 会话 toggles real GUI sidebar (rail hidden by injected css)', false, error.message);
  }

  try {
    windowObject.__DSH_MOBILE__.openSettings();
    await waitFor(() => status().screen === 'settings', 2000, 'APK settings screen');
    expect($('settingsMode').textContent.includes('APK'), 'settings shows APK full-screen mode');
    expect($('settingsNative').textContent.includes('DshApp'), 'settings shows native bridge available');
    expect($('settingsNativeSettings').hidden === false, 'native settings button visible');
    $('settingsNativeSettings').click();
    expect(counters.nativeSettings === 1, 'DshApp.openSettings called, got ' + counters.nativeSettings);
    record('apk mode: settings diagnostics show native bridge + native settings action', true);
  } catch (error) {
    record('apk mode: settings diagnostics show native bridge + native settings action', false, error.message);
  }
}

/* ================================================================== */
/* run                                                                 */
/* ================================================================== */

try {
  if (APP_MODE) await runAppScenario();
  else await runBrowserScenario();
} catch (error) {
  record('scenario harness', false, (error && error.stack) || String(error));
}

await sleep(100);
record(
  'no unhandled exceptions/rejections during the scenario',
  unhandled.length === 0,
  unhandled.map((error) => (error && error.stack) || String(error)).join('\n'),
);

for (const id of trackedIntervals) clearInterval(id);
trackedIntervals.clear();

const failed = results.filter((result) => !result.ok);
console.log('');
console.log(`DSH Mobile DOM smoke v0.3.6 (${APP_MODE ? 'APK full-screen mode' : 'browser mode'})`);
console.log(`${results.length - failed.length}/${results.length} DOM-level checks passed`);
if (failed.length > 0) {
  console.log('Failures:');
  failed.forEach((failure) => console.log('  - ' + failure.name + ' — ' + failure.details));
  process.exitCode = 1;
} else {
  console.log('All DOM-level shell checks passed.');
}
