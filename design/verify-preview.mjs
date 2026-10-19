#!/usr/bin/env node
/**
 * DSH Mobile · 设计评审预览自检（dev-only，无依赖）
 * =================================================
 * 检查 design/preview/index.html 是否为可独立运行的单文件原型：
 *   - 结构完整（doctype / 中文 / 关键屏幕与面板节点 / 内联 SVG 数量）
 *   - 零外部请求（无外部 script/link/img/font、无 http(s) 资源引用、
 *     无 fetch/XHR/WebSocket/import() 等网络 API）
 *   - 内联 CSS / JS 语法可解析（JS 用 new Function 编译检查）
 *   - 关键交互挂载点（数字键盘 / Dock / 抽屉 / 快捷面板 / 评审控件）存在
 *   - 明确标注 mock 边界（聊天区与面板的「真实 DSH GUI」说明）
 *   - 动效降级（prefers-reduced-motion）与横屏样式存在
 *
 * 用法：
 *   node design/verify-preview.mjs
 *   node design/verify-preview.mjs --verbose
 *
 * 退出码 0 = 全部通过。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'preview', 'index.html');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

const results = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      if (value === false) results.push({ name, ok: false, details: 'returned false' });
      else if (typeof value === 'string') results.push({ name, ok: false, details: value });
      else results.push({ name, ok: true, details: '' });
    })
    .catch((error) => {
      results.push({ name, ok: false, details: (error && error.message) || String(error) });
    });
}

function expect(condition, message) {
  if (!condition) throw new Error(message || 'expectation failed');
}

function count(haystack, needle) {
  let total = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    total += 1;
    index += needle.length;
  }
  return total;
}

function extractBlocks(html, tag) {
  const blocks = [];
  const pattern = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi');
  let match;
  while ((match = pattern.exec(html))) blocks.push(match[1]);
  return blocks;
}

const html = await readFile(FILE, 'utf8');
const assets = {};

/* ---------------- 1. single-file / structure ---------------- */
await check('single HTML file: doctype, zh-CN, self-contained title', async () => {
  expect(/^<!doctype html>/i.test(html), 'missing doctype');
  expect(/<html lang="zh-CN">/.test(html), 'missing lang=zh-CN');
  expect(/<title>[^<]*设计评审预览/.test(html), 'title should mention 设计评审预览');
  expect(/<meta charset="utf-8">/i.test(html), 'missing charset');
  expect(/<meta name="viewport"/.test(html), 'missing viewport');
  expect(html.length > 60 * 1024, 'file seems too small to be a high-fidelity prototype');
  expect(html.length < 400 * 1024, 'file unexpectedly large');
  return true;
});

await check('no external requests (script/link/img/font/url/@import)', async () => {
  expect(!/<script[^>]+src=/i.test(html), 'external <script src> found');
  expect(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'external stylesheet link found');
  expect(!/<link[^>]+href=["']https?:/i.test(html), 'external <link href> found');
  expect(!/<img[^>]+src=["']https?:/i.test(html), 'external image found');
  expect(!/@import/i.test(html), '@import found');
  expect(!/url\(\s*["']?https?:/i.test(html), 'external url() found');
  expect(!/url\(\s*["']?\/\//i.test(html), 'protocol-relative url() found');
  expect(!/@font-face/i.test(html), 'external font face found');
  return true;
});

await check('no network APIs / modules in inline JS', async () => {
  expect(!/fetch\s*\(/.test(html), 'fetch() found');
  expect(!/XMLHttpRequest/.test(html), 'XMLHttpRequest found');
  expect(!/new\s+WebSocket/.test(html), 'WebSocket found');
  expect(!/EventSource/.test(html), 'EventSource found');
  expect(!/import\s*\(/.test(html), 'dynamic import() found');
  expect(!/<script[^>]+type=["']module["']/i.test(html), 'ES module script found');
  expect(!/navigator\.sendBeacon/.test(html), 'sendBeacon found');
  return true;
});

await check('only inline <style>/<script> (no src/href attributes)', async () => {
  const scriptTags = html.match(/<script[^>]*>/gi) || [];
  const styleTags = html.match(/<style[^>]*>/gi) || [];
  expect(scriptTags.length === 1, 'expected exactly one inline <script>');
  expect(styleTags.length === 1, 'expected exactly one inline <style>');
  expect(scriptTags.every((tag) => !/\ssrc=/i.test(tag)), 'script tag with src');
  const externalHref = [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => /^https?:|^\/\//i.test(href));
  expect(externalHref.length === 0, 'external href(s): ' + externalHref.join(', '));
  return true;
});

/* ---------------- 2. inline CSS / JS syntax ---------------- */
await check('inline CSS parses (braces balanced, key features present)', async () => {
  const cssBlocks = extractBlocks(html, 'style');
  expect(cssBlocks.length === 1, 'expected one style block');
  const css = cssBlocks[0];
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  expect(count(css, '{') === count(css, '}'), 'unbalanced CSS braces');
  expect(css.includes('prefers-reduced-motion'), 'missing reduced-motion');
  expect(css.includes('is-landscape'), 'missing landscape rules');
  expect(!/env\(/.test(cssNoComments), 'preview should simulate safe areas, not rely on env()');
  expect(css.includes('--safe-top'), 'missing simulated safe-area tokens');
  expect(css.includes('backdrop-filter'), 'missing glass blur');
  return true;
});

await check('inline JS compiles (new Function, classic script)', async () => {
  const scripts = extractBlocks(html, 'script');
  expect(scripts.length === 1, 'expected exactly one inline script');
  const js = scripts[0];
  expect(js.includes("'use strict'"), 'script missing use strict');
  expect(js.includes('function init'), 'script missing init');
  // throws SyntaxError on malformed JS
  // eslint-disable-next-line no-new-func
  new Function(js);
  return true;
});

/* ---------------- 3. screens & review-panel nodes ---------------- */
await check('five screens + dock + overlays + review panel present', async () => {
  for (const id of [
    'app',
    'phoneFrame',
    'capsule',
    'pinRow',
    'keypad',
    'chatScroll',
    'composer',
    'drawer',
    'quickSheet',
    'dock',
    'settingsBack',
    'pairSuccess',
    'screenGrid',
    'themeRow',
    'accentRow',
    'fontScale',
    'radiusScale',
    'orientationSeg',
    'checkList',
    'previewUrl',
    'copyUrl',
    'reviewToast',
  ]) {
    expect(html.includes('id="' + id + '"'), 'missing node #' + id);
  }
  const screens = [...html.matchAll(/data-screen-id="([^"]+)"/g)].map((match) => match[1]);
  for (const screen of ['pair', 'chat', 'settings']) {
    expect(screens.includes(screen), 'missing screen data-screen-id=' + screen);
  }
  const panelScreens = [...html.matchAll(/data-goto="([^"]+)"/g)].map((match) => match[1]);
  for (const screen of ['pair', 'chat', 'drawer', 'quick', 'settings']) {
    expect(panelScreens.includes(screen), 'missing review chip data-goto=' + screen);
  }
  expect(html.includes('data-dock="sessions"'), 'dock missing sessions');
  expect(html.includes('data-dock="new"'), 'dock missing new');
  expect(html.includes('data-dock="refresh"'), 'dock missing refresh');
  expect(html.includes('data-dock="more"'), 'dock missing more');
  const pinCells = count(html, 'data-pin-index=');
  expect(pinCells === 6, 'expected 6 PIN cells, got ' + pinCells);
  const keypadKeys = count(html, 'data-key=');
  expect(keypadKeys === 11, 'expected 11 keypad keys (0-9 + backspace), got ' + keypadKeys);
  return true;
});

await check('inline SVG sprite + icon usage (no image files)', async () => {
  const symbols = count(html, '<symbol');
  expect(symbols >= 18, 'expected >=18 inline icon symbols, got ' + symbols);
  const uses = count(html, '<use href="#i-');
  expect(uses >= 40, 'expected >=40 inline icon usages, got ' + uses);
  expect(!/<img\b/i.test(html), 'should not use <img>');
  return true;
});

await check('mock boundary is explicit (chat area + review panel)', async () => {
  expect(html.includes('示意：生产环境此处为实时 DSH GUI'), 'missing chat mock badge');
  expect(html.includes('本次改动范围'), 'missing 改动范围 section');
  expect(html.includes('聊天内容区 = 真实 DSH GUI iframe'), 'missing scope keep line');
  expect(html.includes('主界面聊天内容为 mock'), 'missing review-panel mock note');
  return true;
});

await check('review checklist + copy address + design variables present', async () => {
  const checks = count(html, 'data-check=');
  expect(checks >= 8, 'expected >=8 checklist items, got ' + checks);
  expect(html.includes('id="checkBar"'), 'missing checklist progress bar');
  expect(html.includes('<span class="ip">&lt;桌面 IP&gt;</span>'), 'missing LAN address placeholder');
  expect(html.includes('id="fontScale"') && html.includes('id="radiusScale"'), 'missing design variable sliders');
  expect(html.includes('data-theme-opt="space"'), 'missing theme options');
  expect(html.includes('data-accent-opt="blue"'), 'missing accent options');
  expect(html.includes('id="resetDesign"') && html.includes('id="resetChecks"'), 'missing reset controls');
  return true;
});

await check('landscape + reduced-motion support wired in CSS/JS', async () => {
  expect(html.includes('is-landscape'), 'missing landscape frame class');
  expect(html.includes('data-orient="landscape"'), 'missing landscape toggle');
  expect(html.includes('prefers-reduced-motion'), 'missing reduced-motion');
  expect(html.includes('844'), 'missing 844px landscape dimensions');
  return true;
});

/* ---------------- 4. report ---------------- */
let failed = 0;
console.log('');
console.log('DSH Mobile · 设计评审预览自检');
console.log('='.repeat(64));
console.log('file   :', FILE);
console.log('size   :', (html.length / 1024).toFixed(1) + ' KB');
console.log('style  :', ((extractBlocks(html, 'style')[0] || '').length / 1024).toFixed(1) + ' KB inline CSS');
console.log('script :', ((extractBlocks(html, 'script')[0] || '').length / 1024).toFixed(1) + ' KB inline JS');
console.log('');
for (const result of results) {
  const tag = result.ok ? 'PASS' : 'FAIL';
  console.log('  [' + tag + '] ' + result.name + (result.ok || !result.details ? '' : '\n         ↳ ' + result.details));
  if (!result.ok) failed += 1;
}
console.log('');
console.log('='.repeat(64));
console.log(`RESULT: ${results.length - failed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exitCode = 1;
else console.log('All preview checks passed — open design/preview/index.html directly (file://) or serve it over http.');
