// Run after npm run compile: node src/test/searchDropdown.browser.cjs
// Uses the real webview HTML, bundle and CSS with an isolated headless Chrome profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

class Browser {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => reject(new Error('No browser response: ' + method)), 5000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async click(id) {
    const point = await this.evaluate(`(() => {
      const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
  }
  async key(key, modifiers = 0) {
    const code = { Enter: 13, ArrowDown: 40, Escape: 27 }[key];
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, modifiers,
        ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
    }
  }
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const chromePath = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(candidate => fs.existsSync(candidate));
  assert.ok(chromePath, 'Set CHROME_PATH to a Chrome or Edge executable');
  const directory = fs.mkdtempSync(path.join(root, 'out/test/search-dropdown-'));
  const panel = fs.readFileSync(path.join(root, 'src/webview/PathFindPanel.ts'), 'utf8');
  let html = panel.match(/return `(<\!DOCTYPE html>[\s\S]*?)`;/)[1];
  const { markChokepoints } = require(path.join(root, 'out/chokepoints.js'));
  const { CASES } = require(path.join(root, 'out/test/cases.js'));
  const stages = CASES.test8.map(expected => markChokepoints({
    targetIds: ['chain.py::target'],
    nodes: expected.nodes.map(id => ({
      id, label: id.split('::')[1], file: '/test8/' + id.split('::')[0], line: 1, endLine: 2,
      noise: id.endsWith('::<module>'), hiddenCallers: expected.hiddenCallers?.[id],
    })),
    edges: expected.edges.map(([from, to, lines]) => ({ from, to, lines })),
  }));
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('${css}', pathToFileURL(path.join(root, 'media/graph.css')).href)
    .replace('${script}', pathToFileURL(path.join(root, 'out/webview/graph.js')).href)
    .replaceAll('${nonce}', 'test');
  html = html.replace('</head>', `<script>
    window.testErrors = [];
    window.addEventListener('error', event => testErrors.push(event.message));
    window.acquireVsCodeApi = () => ({ postMessage(message) {
      if (message.type === 'ready') setTimeout(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph: ${JSON.stringify(stages[0])} } }));
      }, 0);
    } });
  </script></head>`);
  const file = path.join(directory, 'index.html');
  fs.writeFileSync(file, html);
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + path.join(directory, 'profile'),
    pathToFileURL(file).href], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Browser startup timed out: ' + output)), 10000);
      chrome.on('error', error => { clearTimeout(timer); reject(error); });
      chrome.stderr.on('data', chunk => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const targets = await (await fetch(`http://127.0.0.1:${new URL(url).port}/json/list`)).json();
    const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    browser = new Browser(socket);
    await browser.send('Browser.getVersion');
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await browser.evaluate(`!!document.getElementById('graph')?._cyreg?.cy?.nodes().length`)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(await browser.evaluate('testErrors'), []);
    await browser.click('where-to-break');
    const state = () => browser.evaluate(`(() => {
      const list = document.getElementById('search-results');
      const box = list.getBoundingClientRect();
      return {
        hidden: list.hidden, count: document.getElementById('search-count').textContent,
        focused: document.activeElement.id, items: list.querySelectorAll('[data-node-id]').length,
        visible: !!document.elementFromPoint(box.x + 15, box.y + 15)?.closest('#search-results'),
      };
    })()`);
    const first = await state();
    assert.equal(first.hidden, false, 'suggestions must open');
    assert.equal(first.items, 7, 'backend chokepoints must reach the dropdown');
    assert.equal(first.visible, true, 'suggestions must be visible above graph controls');
    assert.equal(first.focused, 'search-input', 'keyboard navigation must be ready');
    assert.equal(first.count, '1 of 7');
    await browser.key('Enter');
    assert.equal((await state()).count, '2 of 7', 'Enter must advance with the dropdown open');
    await browser.click('search-next');
    assert.equal((await state()).count, '3 of 7');
    await browser.click('search-previous');
    assert.equal((await state()).count, '2 of 7');
    await browser.click('where-to-break');
    assert.equal((await state()).count, '3 of 7', 'repeated button clicks must advance');
    await browser.key('Enter', 8);
    assert.equal((await state()).count, '2 of 7', 'Shift+Enter must go backward');
    await browser.key('ArrowDown');
    assert.equal((await state()).count, '3 of 7');
    await browser.evaluate(`document.querySelector('#search-results [data-node-id="chain.py::level5"]').click()`);
    assert.equal((await state()).count, '5 of 7', 'a dropdown option must select its function');
    await browser.click('search-next');
    assert.equal((await state()).count, '6 of 7', 'cycling must continue after choosing an option');
    for (const [index, graph] of stages.slice(1).entries()) {
      await browser.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph: ${JSON.stringify(graph)} } }))`);
      await browser.click('where-to-break');
      const expanded = await state();
      assert.equal(expanded.items, [15, 20][index], 'expanded graph must refresh backend suggestions');
      assert.equal(expanded.count, `1 of ${expanded.items}`);
      assert.equal(expanded.visible, true);
    }
    await browser.key('Escape');
    assert.equal((await state()).hidden, true);
    await browser.evaluate(`(() => {
      const input = document.getElementById('search-input');
      input.focus(); input.value = 'level'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.equal((await state()).count, '1 of 20', 'typing must return to function search');
    await browser.key('Enter');
    assert.equal((await state()).hidden, true, 'normal search Enter must still accept the current option');
    assert.equal((await state()).count, '1 of 20');
    await browser.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph: { nodes: [{ id: 't', label: 'target', file: '/target.py', line: 1, endLine: 2 }], edges: [], targetIds: ['t'] } } }))`);
    await browser.click('where-to-break');
    assert.match(await browser.evaluate(`document.getElementById('search-results').innerText`), /No shared breakpoint location/);
    assert.equal((await state()).hidden, false);
    await browser.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph: { nodes: [], edges: [] } } }))`);
    await browser.click('where-to-break');
    assert.match(await browser.evaluate(`document.getElementById('search-results').innerText`), /Load a graph/);
    assert.equal((await state()).hidden, false, 'empty results must still give visible feedback');
    assert.deepEqual(await browser.evaluate('testErrors'), []);
    console.log('PASS browser: test8 backend suggestions at all 3 stages, visible dropdown, focus, arrows, Enter, repeated clicks, option selection, Escape and empty results');
  } finally {
    if (browser) {
      await browser.send('Browser.close').catch(() => {});
      browser.socket.close();
    }
    chrome.kill();
  }
}

const timeout = setTimeout(() => { console.error('Browser test timed out'); process.exit(1); }, 30000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
