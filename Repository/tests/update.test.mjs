import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { compareVersions, UpdateChecker, GITHUB_VERSION_URL, GITHUB_REPOSITORY_URL } from '../src/update.js';
import { PLUGIN_VERSION } from '../src/version.js';
import { normalizeSettings, renderKey } from '../src/render.js';

const require = createRequire(import.meta.url);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const [major, minor, patch, revision] = PLUGIN_VERSION.split('.').map(Number);
const newerVersion = [major, minor, patch, revision + 1].join('.');
const manifestResponse = Version => ({ ok: true, json: async () => ({ UUID: 'de.ai-quota', Version }) });

test('update URL resolves to the actual manifest in the upload directory layout', async () => {
  const contentsPath = new URL(GITHUB_VERSION_URL).pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
  assert.ok(contentsPath, 'update URL must address a GitHub repository file');
  const uploadRoot = new URL('../../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL(contentsPath[1], uploadRoot), 'utf8'));
  assert.equal(manifest.UUID, 'de.ai-quota');
  assert.equal(manifest.Version, PLUGIN_VERSION);
});

test('four-component versions compare numerically and reject invalid GitHub data', () => {
  for (const [left, right, result] of [
    ['0.0.2.10', '0.0.2.9', 1], ['0.0.10.0', '0.0.2.99', 1],
    ['0.1.0.0', '0.0.99.99', 1], ['1.0.0.0', '0.99.99.99', 1],
    [PLUGIN_VERSION, PLUGIN_VERSION, 0], ['0.0.2.0', PLUGIN_VERSION, -1],
    ['v0.0.2.2', PLUGIN_VERSION, null], ['0.0.2', PLUGIN_VERSION, null],
    ['0.0.2.2-beta', PLUGIN_VERSION, null], ['65536.0.0.0', PLUGIN_VERSION, null],
    [null, PLUGIN_VERSION, null], ['0.0.2.2', 'garbage', null]
  ]) assert.equal(compareVersions(left, right), result, `${left} vs ${right}`);
});

test('startup check reads only the committed manifest and coalesces all callers', async () => {
  const calls = []; let changes = 0;
  const checker = new UpdateChecker({ onChange: () => changes++, fetchImpl: async (url, options) => {
    calls.push({ url, options }); await wait(5); return manifestResponse(newerVersion);
  } });
  assert.deepEqual(await Promise.all([checker.check(), checker.check(), checker.check()]), [true, true, true]);
  assert.equal(await checker.check(), true); assert.equal(calls.length, 1); assert.equal(changes, 1);
  assert.equal(calls[0].url, GITHUB_VERSION_URL);
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.cache, 'no-store');
  checker.dispose();
});

test('equal, older, malformed and unrelated manifests produce no update indication', async () => {
  for (const manifest of [
    { UUID: 'de.ai-quota', Version: PLUGIN_VERSION },
    { UUID: 'de.ai-quota', Version: '0.0.1.99' },
    { UUID: 'de.ai-quota', Version: '0.0.3' },
    { UUID: 'different-plugin', Version: '9.9.9.9' },
    { Version: '9.9.9.9' }, null
  ]) {
    const checker = new UpdateChecker({ fetchImpl: async () => ({ ok: true, json: async () => manifest }) });
    assert.equal(await checker.check(), false); assert.equal(checker.available, false); checker.dispose();
  }
});

test('HTTP errors, offline state, invalid JSON and timeouts do not disrupt the plugin', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 404 }), async () => ({ ok: false, status: 403 }),
    async () => { throw new Error('offline'); },
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
    (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
  ]) {
    const checker = new UpdateChecker({ fetchImpl, timeoutMs: 10 });
    assert.equal(await checker.check(), false); assert.equal(checker.checked, true); checker.dispose();
  }
  let complete, changes = 0;
  const checker = new UpdateChecker({ fetchImpl: () => new Promise(resolve => complete = resolve), onChange: () => changes++ });
  const pending = checker.check(); checker.dispose(); complete(manifestResponse('9.9.9.9'));
  assert.equal(await pending, false); assert.equal(changes, 0);
});

test('red update overlay works in every layout without changing existing graphics', () => {
  const data = { fiveHour: { usedPercent: 23 }, week: { usedPercent: 43 } };
  assert.equal(normalizeSettings({}).showUpdateInfo, true);
  assert.equal(normalizeSettings({ showUpdateInfo: false }).showUpdateInfo, false);
  for (const style of ['dual', 'number', 'ring', 'fill', 'frame']) {
    for (const transparentBackground of [true, false]) {
      const settings = { style, transparentBackground };
      const original = renderKey(settings, data, {});
      assert.equal(renderKey({ ...settings, showUpdateInfo: false }, data, { updateAvailable: true }), original);
      const withDot = renderKey(settings, data, { updateAvailable: true });
      const dom = new JSDOM(withDot, { contentType: 'image/svg+xml' });
      try {
        const dot = dom.window.document.querySelector('circle[fill="#ff493d"]');
        assert(dot); assert.equal(dot.getAttribute('cx'), '132'); assert.equal(dot.getAttribute('cy'), '12'); assert.equal(dot.getAttribute('r'), '6');
        assert.equal(withDot.replace(/<circle cx="132" cy="12" r="6" fill="#ff493d"\/>/, ''), original);
      } finally { dom.window.close(); }
    }
  }
});

test('bottom update checkbox persists for both actions without label or row toggling', async () => {
  const html = await readFile('de.ai-quota.sdPlugin/ui/settings.html', 'utf8');
  for (const action of ['de.ai-quota.quota', 'de.ai-quota.claude']) {
    const messages = []; let socket;
    function open(settings = {}) {
      class Socket { static OPEN = 1; readyState = 1; constructor() { socket = this; } send(message) { messages.push(JSON.parse(message)); } }
      const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(window) { window.WebSocket = Socket; } });
      dom.window.connectElgatoStreamDeckSocket('1', 'inspector', 'registerPropertyInspector', '{}', JSON.stringify({ context: 'key', action, payload: { settings } }));
      socket.onopen(); return dom;
    }
    let dom = open();
    try {
      const document = dom.window.document, checkbox = document.getElementById('showUpdateInfo');
      assert.equal([...document.querySelectorAll('input,select,button')].at(-1), checkbox);
      assert.equal(checkbox.checked, true);
      checkbox.parentElement.querySelector('span').click(); assert.equal(checkbox.checked, true);
      checkbox.parentElement.click(); assert.equal(checkbox.checked, true);
      checkbox.click(); await wait(150);
      const saved = messages.findLast(message => message.payload?.command === 'settings').payload.settings;
      assert.equal(saved.showUpdateInfo, false);
      const request = messages.findLast(message => message.payload?.command === 'settings');
      socket.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: { command: 'settingsApplied', requestId: request.payload.requestId, settings: saved } }) });
      assert.equal(checkbox.checked, false);
      const window = document.getElementById('window'); window.value = 'fiveHour'; window.dispatchEvent(new dom.window.Event('change')); await wait(150);
      assert.equal(checkbox.checked, false);
      const next = messages.findLast(message => message.payload?.command === 'settings').payload.settings;
      dom.window.close(); dom = open(next);
      assert.equal(dom.window.document.getElementById('showUpdateInfo').checked, false);
      dom.window.document.getElementById('showUpdateInfo').click(); await wait(150);
      assert.equal(messages.findLast(message => message.payload?.command === 'settings').payload.settings.showUpdateInfo, true);
    } finally { dom.window.close(); }
  }
});

const compiledPlugin = build({ entryPoints: ['src/plugin.js'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['ws'], write: false, plugins: [{
  name: 'mock-quota-clients', setup(builder) {
    builder.onResolve({ filter: /^\.\/(quota|claude)\.js$/ }, args => ({ path: args.path, namespace: 'mock-quota' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock-quota' }, () => ({ contents: `
      import {EventEmitter} from 'node:events';
      class Client extends EventEmitter { stop(){} async read(){globalThis.reads++;return {week:{usedPercent:17}};} }
      export {Client as ChatGptDesktopQuotaClient,Client as ClaudeQuotaClient};
      export const normalizeQuota=x=>x,normalizeClaudeQuota=x=>x,mergeQuotaUpdate=(_previous,x)=>x;
    ` }));
  }
}] });

async function pluginHarness({ enabled = true, version = newerVersion, offline = false } = {}) {
  const messages = [], requests = []; let socket, tick; let now = Date.now();
  class FakeSocket extends EventEmitter { static OPEN = 1; readyState = 1; constructor() { super(); socket = this; } send(value) { messages.push(JSON.parse(value)); } close() { this.emit('close'); } }
  class Clock extends Date { static now() { return now; } }
  const host = new EventEmitter(); host.argv = ['node', 'test/bin/plugin.js', '-port', '1', '-pluginUUID', 'plugin', '-registerEvent', 'registerPlugin'];
  const sandbox = { Buffer, URL, AbortController, Date: Clock, setTimeout, clearTimeout, setInterval: fn => { tick = fn; return 1; }, clearInterval: () => {}, process: host, console, reads: 0,
    fetch: async (url, options) => { requests.push({ url, options }); if (offline) throw new Error('offline'); return manifestResponse(version); },
    module: { exports: {} }, require: name => name === 'ws' ? FakeSocket : require(name)
  };
  vm.runInNewContext((await compiledPlugin).outputFiles[0].text, sandbox);
  const event = (context, event, payload = {}) => socket.emit('message', Buffer.from(JSON.stringify({ action: context === 'chat' ? 'de.ai-quota.quota' : 'de.ai-quota.claude', context, event, payload })));
  socket.emit('open');
  event('chat', 'willAppear', { settings: { showUpdateInfo: enabled } });
  event('claude', 'willAppear', { settings: { showUpdateInfo: enabled } }); await wait(5);
  return { event, messages, requests, reads: () => sandbox.reads, elapse: ms => { now += ms; }, advance: () => { now += 60000; tick(); }, close: () => socket.close() };
}

test('new committed version marks both buttons and key press sends the fixed GitHub URL', async () => {
  const app = await pluginHarness();
  try {
    assert.equal(app.requests.length, 1);
    for (const context of ['chat', 'claude']) {
      const image = app.messages.findLast(message => message.event === 'setImage' && message.context === context).payload.image;
      assert.match(Buffer.from(image.split(',')[1], 'base64').toString(), /cx="132" cy="12" r="6" fill="#ff493d"/);
      const before = app.reads(); app.event(context, 'keyDown');
      assert.equal(app.reads(), before);
      assert.deepEqual(app.messages.at(-1), { event: 'openUrl', payload: { url: GITHUB_REPOSITORY_URL } });
    }
    app.advance(); await wait(5); assert.equal(app.requests.length, 1, 'polling never repeats the startup update request');
    app.event('chat', 'sendToPlugin', { command: 'settings', requestId: 1, settings: { showUpdateInfo: false, settingsRevision: 100 } });
    const image = app.messages.findLast(message => message.event === 'setImage' && message.context === 'chat').payload.image;
    assert.doesNotMatch(Buffer.from(image.split(',')[1], 'base64').toString(), /cx="132" cy="12" r="6" fill="#ff493d"/);
    const urls = app.messages.filter(message => message.event === 'openUrl').length;
    app.event('chat', 'keyDown'); assert.equal(app.messages.filter(message => message.event === 'openUrl').length, urls);
    app.event('claude', 'keyDown'); assert.equal(app.messages.filter(message => message.event === 'openUrl').length, urls + 1);
  } finally { app.close(); }
});

test('disabled startup makes no GitHub request; enabling later checks once and survives old settings', async () => {
  const app = await pluginHarness({ enabled: false });
  try {
    assert.equal(app.requests.length, 0); app.advance(); await wait(5); assert.equal(app.requests.length, 0);
    app.event('chat', 'sendToPlugin', { command: 'settings', requestId: 1, settings: { showUpdateInfo: true, settingsRevision: 100 } }); await wait(5);
    assert.equal(app.requests.length, 1);
    app.event('chat', 'sendToPlugin', { command: 'settings', requestId: 2, settings: { showUpdateInfo: false, settingsRevision: 200 } });
    app.event('chat', 'didReceiveSettings', { settings: { showUpdateInfo: true, settingsRevision: 100 } });
    app.event('chat', 'sendToPlugin', { command: 'state' });
    assert.equal(app.messages.findLast(message => message.event === 'sendToPropertyInspector').payload.settings.showUpdateInfo, false);
    app.event('chat', 'sendToPlugin', { command: 'refresh', settings: { showUpdateInfo: true, settingsRevision: 100 } });
    app.event('chat', 'sendToPlugin', { command: 'state' });
    assert.equal(app.messages.findLast(message => message.event === 'sendToPropertyInspector').payload.settings.showUpdateInfo, false);
    app.event('chat', 'keyDown'); assert(!app.messages.some(message => message.event === 'openUrl'));
  } finally { app.close(); }
});

test('current version or offline GitHub retains ordinary quota refresh for both buttons', async () => {
  for (const options of [{ version: PLUGIN_VERSION }, { offline: true }]) {
    const app = await pluginHarness(options);
    try {
      app.advance(); await wait(5);
      app.elapse(3000);
      const before = app.reads();
      app.event('chat', 'keyDown'); app.event('claude', 'keyDown'); await wait(5);
      assert.equal(app.reads(), before + 2);
      assert(!app.messages.some(message => message.event === 'openUrl'));
      for (const message of app.messages.filter(message => message.event === 'setImage')) {
        assert.doesNotMatch(Buffer.from(message.payload.image.split(',')[1], 'base64').toString(), /cx="132" cy="12" r="6" fill="#ff493d"/);
      }
    } finally { app.close(); }
  }
});
