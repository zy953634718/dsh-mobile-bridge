#!/usr/bin/env node
/**
 * DSH Mobile · 设计评审预览运行时冒烟测试（dev-only，无依赖）
 * ==========================================================
 * 本沙箱无法启动浏览器，因此这里用一个极小的 DOM 树 shim 执行
 * design/preview/index.html 中的真实内联 JS，并驱动核心交互：
 *
 *   init → 数字键盘输入 6 位 → 配对成功动效 → 主界面
 *   主界面 Dock → 会话抽屉 / 快捷面板 / 刷新
 *   评审面板 → 屏幕切换 / 主题 / 强调色 / 字号 / 圆角 / 横屏
 *   设置页 → 快捷面板进入设置 → 返回
 *   评审清单 → 勾选进度与 localStorage 持久化
 *
 * 说明：这不是布局/视觉测试（真实截图由 Lead 用 headless Chrome 验收），
 * 而是抓取「空的元素引用 / 拼写错误 / undefined 函数 / 状态机回归」这类运行时问题。
 *
 * 用法：node design/preview-runtime-test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, 'preview', 'index.html'), 'utf8');

/* ------------------------------------------------------------------ */
/* tiny HTML → DOM tree                                                */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'use', 'stop', 'line', 'polyline', 'polygon', 'ellipse']);

function camelCase(name) {
  return String(name).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.id = '';
    this.attrs = {};
    this.dataset = {};
    this._classes = new Set();
    this._text = '';
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._listeners = new Map();
    this.style = {
      _props: new Map(),
      setProperty: (key, value) => this.style._props.set(String(key), String(value)),
      getPropertyValue: (key) => this.style._props.get(String(key)) || '',
      removeProperty: (key) => this.style._props.delete(String(key)),
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

  get clientWidth() {
    return 900;
  }

  get clientHeight() {
    return 900;
  }

  get offsetWidth() {
    return 0;
  }

  get offsetParent() {
    return this.parentNode;
  }

  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
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
    this.attrs[String(name)] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, String(name)) ? this.attrs[String(name)] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, String(name));
  }

  addEventListener(type, listener) {
    const key = String(type);
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    this._listeners.get(key).push(listener);
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(String(type));
    if (!list) return;
    const index = list.indexOf(listener);
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
    const invoke = (node) => {
      for (const listener of (node._listeners.get(payload.type) || []).slice()) listener(payload);
    };
    invoke(this);
    // model real DOM bubbling so delegated handlers on ancestors fire
    if (!payload._stopBubble) {
      let node = this.parentNode;
      while (node) {
        invoke(node);
        node = node.parentNode;
      }
    }
    return true;
  }

  click() {
    return this.dispatchEvent({ type: 'click', target: this });
  }

  focus() {}
  select() {}

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesParts(node, [selector.trim()], 0)) return node;
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

/* simple selector matching: supports "tag", ".class", "#id", "[attr]",
   "[attr=\"value\"], plus descendant combinators ("#root input[data-check]") */
function parseParts(selector) {
  return String(selector)
    .trim()
    .split(/\s+(?![^\[]*\])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesParts(element, parts, index) {
  if (!element) return false;
  const part = parts[index];
  let cursor = 0;
  const tagMatch = part.slice(cursor).match(/^[a-zA-Z][\w-]*/);
  let tag = '';
  if (tagMatch) {
    tag = tagMatch[0].toUpperCase();
    cursor += tagMatch[0].length;
  }
  if (part[cursor] === '#') {
    const idMatch = part.slice(cursor).match(/^#([\w-]+)/);
    if (!idMatch) return false;
    if (element.id !== idMatch[1]) return false;
    cursor += idMatch[0].length;
  }
  if (tag && element.tagName !== tag) return false;
  const rest = part.slice(cursor);
  for (const classMatch of rest.matchAll(/\.([\w-]+)/g)) {
    if (!element._classes.has(classMatch[1])) return false;
  }
  for (const attrMatch of rest.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const name = attrMatch[1];
    const value = attrMatch[2];
    let actual;
    if (name === 'id') actual = element.id;
    else if (name.startsWith('data-')) actual = element.dataset[camelCase(name.slice(5))];
    else actual = element.attrs[name];
    if (value !== undefined) {
      if (String(actual) !== value) return false;
    } else if (actual === undefined || actual === null) {
      return false;
    }
  }
  if (index === 0) return true;
  let parent = element.parentNode;
  while (parent) {
    if (matchesParts(parent, parts, index - 1)) return true;
    parent = parent.parentNode;
  }
  return false;
}

function collect(root, selector, results) {
  const parts = parseParts(selector);
  if (!parts.length) return;
  const walk = (node) => {
    for (const child of node.children) {
      if (child && matchesParts(child, parts, parts.length - 1)) results.push(child);
      walk(child);
    }
  };
  walk(root);
}

function buildTree(html) {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  documentElement.appendChild(body);
  const stack = [body];
  const tagPattern = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  let skipUntil = '';
  while ((match = tagPattern.exec(html))) {
    const closing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const attrText = match[3] || '';
    const selfClosing = match[4] === '/';
    const top = stack[stack.length - 1];

    if (skipUntil) {
      if (closing && tagName === skipUntil) skipUntil = '';
      continue;
    }
    if (!closing && (tagName === 'script' || tagName === 'style')) {
      skipUntil = tagName;
      continue;
    }
    if (closing) {
      // pop to the matching open tag (tolerate void tags not pushed)
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName === tagName.toUpperCase()) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    if (!stack.length) break;

    const element = new FakeElement(tagName);
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrText))) {
      const name = attrMatch[1];
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      element.attrs[name] = value;
      if (name === 'id') element.id = value;
      else if (name === 'class') value.split(/\s+/).filter(Boolean).forEach((item) => element._classes.add(item));
      else if (name === 'hidden') element.hidden = true;
      else if (name.startsWith('data-')) element.dataset[camelCase(name.slice(5))] = value;
      else if (name === 'value') element.value = value;
    }
    top.appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tagName)) stack.push(element);
  }
  return { body, documentElement };
}

const { body, documentElement } = buildTree(HTML);

/* ------------------------------------------------------------------ */
/* fake browser globals                                                */
/* ------------------------------------------------------------------ */

const idMap = new Map();
(function indexIds(node) {
  if (node.id) idMap.set(node.id, node);
  node.children.forEach(indexIds);
})(documentElement);

const localStorageMap = new Map();
const windowListeners = new Map();
const documentListeners = new Map();

const fakeDocument = {
  readyState: 'complete',
  documentElement,
  body,
  activeElement: null,
  createElement(tagName) {
    return new FakeElement(tagName);
  },
  getElementById(id) {
    return idMap.get(String(id)) || null;
  },
  querySelector(selector) {
    const results = [];
    collect(documentElement, selector, results);
    return results[0] || null;
  },
  querySelectorAll(selector) {
    const results = [];
    collect(documentElement, selector, results);
    return results;
  },
  addEventListener(type, listener) {
    const key = String(type);
    if (!documentListeners.has(key)) documentListeners.set(key, []);
    documentListeners.get(key).push(listener);
  },
  removeEventListener() {},
  execCommand() {
    return true;
  },
};

function fakeWindowListener(type, listener) {
  const key = String(type);
  if (!windowListeners.has(key)) windowListeners.set(key, []);
  windowListeners.get(key).push(listener);
}

const windowObject = {
  document: fakeDocument,
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 2,
  navigator: { clipboard: undefined, userAgent: 'node-dom-shim' },
  localStorage: {
    getItem: (key) => (localStorageMap.has(String(key)) ? localStorageMap.get(String(key)) : null),
    setItem: (key, value) => localStorageMap.set(String(key), String(value)),
    removeItem: (key) => localStorageMap.delete(String(key)),
  },
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  addEventListener: fakeWindowListener,
  removeEventListener() {},
};

const sandbox = {
  window: windowObject,
  document: fakeDocument,
  navigator: windowObject.navigator,
  localStorage: windowObject.localStorage,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: windowObject.requestAnimationFrame,
  cancelAnimationFrame: windowObject.cancelAnimationFrame,
  console,
  URLSearchParams,
};
vm.createContext(sandbox);

/* ------------------------------------------------------------------ */
/* inline JS extraction + boot                                         */
/* ------------------------------------------------------------------ */

const scriptMatch = HTML.match(/<script>([\s\S]*?)<\/script>/i);
if (!scriptMatch) {
  console.error('FAIL: cannot find inline script');
  process.exit(1);
}
const APP_JS = scriptMatch[1];

const results = [];
const unhandled = [];
process.on('uncaughtException', (error) => unhandled.push(error));
process.on('unhandledRejection', (error) => unhandled.push(error));

function record(name, ok, details) {
  results.push({ name, ok: !!ok, details: details || '' });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !details ? '' : '\n       ↳ ' + details}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message || 'expectation failed');
}

function frame() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

const $ = (id) => fakeDocument.getElementById(id);
const $$ = (selector) => fakeDocument.querySelectorAll(selector);
const app = $('app');

async function run() {
  try {
    vm.runInContext(APP_JS, sandbox, { filename: 'design-preview-inline.js' });
    record('inline JS executes on the DOM shim (no top-level exception)', true);
  } catch (error) {
    record('inline JS executes on the DOM shim (no top-level exception)', false, (error && error.stack) || String(error));
    return;
  }
  await frame();

  /* ---------------- boot state ---------------- */
  try {
    expect(app.dataset.screen === 'pair', 'expected pair screen, got ' + app.dataset.screen);
    expect($$('.pin-cell').length === 6, 'expected 6 pin cells');
    expect($('pinRow').querySelectorAll('.pin-cell').length === 6, 'pinRow should contain 6 cells');
    expect(app.style.getPropertyValue('--font-scale') === '1', 'default font scale should be 1');
    record('boot: pairing screen + 6 PIN cells + default design tokens', true);
  } catch (error) {
    record('boot: pairing screen + 6 PIN cells + default design tokens', false, error.message);
  }

  /* ---------------- keypad → success → chat ---------------- */
  try {
    for (const digit of ['1', '2', '3', '4', '5', '6']) {
      const key = $$('[data-key]').find((item) => item.dataset.key === digit);
      expect(key, 'missing keypad digit ' + digit);
      key.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect($('pairSuccess').hidden === false, 'success overlay should appear after 6 digits');
    expect(app.dataset.conn === 'connecting', 'connection should still be connecting during animation');
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(app.dataset.screen === 'chat', 'expected chat screen after success, got ' + app.dataset.screen);
    expect(app.dataset.conn === 'online', 'connection should be online after pairing');
    expect($('pairSuccess').hidden === true, 'success overlay should hide again');
    record('pairing: keypad 6 digits -> success animation -> chat screen', true);
  } catch (error) {
    record('pairing: keypad 6 digits -> success animation -> chat screen', false, error.message);
  }

  /* ---------------- dock: drawer / sheet / refresh ---------------- */
  try {
    const dock = (name) => $$('[data-dock]').find((item) => item.dataset.dock === name);
    dock('sessions').click();
    expect($('drawer').classList.contains('is-open'), 'drawer should open');
    expect($('scrim').hidden === false, 'scrim should be visible with drawer');
    $('scrim').click();
    expect(!$('drawer').classList.contains('is-open'), 'drawer should close on scrim click');

    dock('more').click();
    expect($('quickSheet').classList.contains('is-open'), 'quick sheet should open');
    const closeSheetBtn = $$('[data-close-sheet]')[0];
    closeSheetBtn.click();
    expect(!$('quickSheet').classList.contains('is-open'), 'quick sheet should close');

    dock('refresh').click();
    expect($('capsuleRefresh').classList.contains('is-spinning'), 'refresh should animate');
    record('dock: sessions drawer / more sheet / refresh work', true);
  } catch (error) {
    record('dock: sessions drawer / more sheet / refresh work', false, error.message);
  }

  /* ---------------- review panel: screen / theme / accent / vars ---------------- */
  try {
    $$('[data-goto="drawer"]')[0].click();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect($('drawer').classList.contains('is-open'), 'review chip drawer should open drawer');
    $('scrim').click();

    $$('[data-goto="settings"]')[0].click();
    expect(app.dataset.screen === 'settings', 'review chip settings should show settings');
    $('settingsBack').click();
    expect(app.dataset.screen === 'chat', 'settings back should return to chat');

    $$('[data-theme-opt="nebula"]')[0].click();
    expect(app.dataset.theme === 'nebula', 'theme should switch to nebula');
    $$('[data-accent-opt="violet"]')[0].click();
    expect(app.style.getPropertyValue('--accent-a') === '#7c5cff', 'accent should switch to violet');

    const fontSlider = $('fontScale');
    fontSlider.value = '110';
    fontSlider.dispatchEvent({ type: 'input', target: fontSlider });
    expect(app.style.getPropertyValue('--font-scale') === '1.1', 'font scale should become 1.1');
    expect($('fontScaleOut').textContent === '110%', 'font scale output');
    expect($('settingsFontScale').value === '110', 'settings slider should stay in sync');

    const radiusSlider = $('radiusScale');
    radiusSlider.value = '20';
    radiusSlider.dispatchEvent({ type: 'input', target: radiusSlider });
    expect(app.style.getPropertyValue('--radius-lg') === '20px', 'radius should become 20px');

    $$('[data-orient="landscape"]')[0].click();
    expect($('phoneFrame').classList.contains('is-landscape'), 'landscape class should apply');
    $$('[data-orient="portrait"]')[0].click();
    expect(!$('phoneFrame').classList.contains('is-landscape'), 'portrait class should restore');

    $('resetDesign').click();
    expect(app.style.getPropertyValue('--font-scale') === '1', 'reset should restore font scale');
    expect(app.style.getPropertyValue('--radius-lg') === '24px', 'reset should restore radius');
    record('review panel: screen switch / theme / accent / font / radius / landscape', true);
  } catch (error) {
    record('review panel: screen switch / theme / accent / font / radius / landscape', false, error.message);
  }

  /* ---------------- settings actions via quick sheet ---------------- */
  try {
    $$('[data-dock]').find((item) => item.dataset.dock === 'more').click();
    $$('[data-quick="settings"]')[0].click();
    expect(app.dataset.screen === 'settings', 'quick action settings should open settings');
    const disconnectBtn = $$('[data-action="disconnect"]')[0];
    disconnectBtn.click();
    expect(app.dataset.screen === 'pair', 'disconnect should return to pairing');
    expect(app.dataset.conn === 'connecting', 'disconnect should reset connection state');
    record('settings: quick action opens settings; disconnect returns to pairing', true);
  } catch (error) {
    record('settings: quick action opens settings; disconnect returns to pairing', false, error.message);
  }

  /* ---------------- checklist persistence ---------------- */
  try {
    const input = $$('#checkList input[data-check]')[0];
    expect(input, 'missing checklist input');
    input.checked = true;
    input.dispatchEvent({ type: 'change', target: input });
    expect($('checkProgress').textContent === '1 / 8', 'checklist progress should be 1 / 8, got ' + $('checkProgress').textContent);
    expect(localStorageMap.has('dsh-mobile-design-review-v2'), 'checklist should persist to localStorage');
    expect(JSON.parse(localStorageMap.get('dsh-mobile-design-review-v2'))[input.dataset.check] === true, 'persisted value');
    $('resetChecks').click();
    expect($('checkProgress').textContent === '0 / 8', 'reset should clear checklist progress');
    record('review checklist: toggle + progress + localStorage persistence + reset', true);
  } catch (error) {
    record('review checklist: toggle + progress + localStorage persistence + reset', false, error.message);
  }

  /* ---------------- no unhandled errors ---------------- */
  await frame();
  record(
    'no unhandled exceptions/rejections during interactions',
    unhandled.length === 0,
    unhandled.map((error) => (error && error.stack) || String(error)).join('\n'),
  );
}

await run();

const failed = results.filter((result) => !result.ok);
console.log('');
console.log(`RESULT: ${results.length - failed.length}/${results.length} runtime checks passed`);
if (failed.length > 0) {
  console.log('Failures:');
  failed.forEach((failure) => console.log('  - ' + failure.name + ' — ' + failure.details));
  process.exitCode = 1;
} else {
  console.log('All runtime preview checks passed.');
}
