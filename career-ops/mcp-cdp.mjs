#!/usr/bin/env node
/**
 * mcp-cdp.mjs — Chrome DevTools Protocol MCP server
 *
 * Connects to Chrome at localhost:9222 and exposes navigation/scraping tools.
 * Start Chrome first:
 *   & "C:\Program Files\Google\Chrome\Application\chrome.exe" \
 *       --remote-debugging-port=9222 \
 *       --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data"
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const CDP_HOST     = process.env.CDP_HOST     ?? 'localhost:9222';
const LOAD_TIMEOUT = Number(process.env.CDP_LOAD_TIMEOUT ?? 15_000);

// ── CDP session ────────────────────────────────────────────────────────

class CDPSession {
  #ws; #id = 1; #pending = new Map(); #handlers = new Map();

  async connect(wsUrl) {
    await new Promise((resolve, reject) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.addEventListener('open', resolve);
      this.#ws.addEventListener('error', e => reject(new Error(e.message ?? 'WebSocket error')));
      this.#ws.addEventListener('message', ({ data }) => {
        const msg = JSON.parse(data);
        if (msg.id !== undefined) {
          const p = this.#pending.get(msg.id);
          if (p) {
            this.#pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result ?? {});
          }
        } else if (msg.method) {
          (this.#handlers.get(msg.method) ?? []).forEach(h => h(msg.params));
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.#id++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(event) {
    return new Promise(resolve => {
      const arr = this.#handlers.get(event) ?? [];
      const h   = p => { arr.splice(arr.indexOf(h), 1); resolve(p); };
      arr.push(h);
      this.#handlers.set(event, arr);
    });
  }

  close() { try { this.#ws.close(); } catch {} }
}

async function getActiveTab() {
  let tabs;
  try {
    tabs = await fetch(`http://${CDP_HOST}/json`).then(r => r.json());
  } catch {
    throw new Error(
      `Cannot reach Chrome at ${CDP_HOST}. Start it with:\n` +
      `  & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ` +
      `--remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\\Google\\Chrome\\User Data"`
    );
  }
  const tab = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!tab) throw new Error('No usable Chrome tab found — open at least one tab in Chrome.');
  return tab;
}

async function withTab(fn) {
  const tab     = await getActiveTab();
  const session = new CDPSession();
  await session.connect(tab.webSocketDebuggerUrl);
  try   { return await fn(session); }
  finally { session.close(); }
}

// ── Tool definitions ───────────────────────────────────────────────────

const TOOLS = [
  {
    name:        'cdp_navigate',
    description: 'Navigate the active Chrome tab to a URL and wait for the page to load.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to navigate to' } },
      required: ['url'],
    },
  },
  {
    name:        'cdp_snapshot',
    description: 'Get the current page title, URL, and up to 8 000 characters of visible text content.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'cdp_evaluate',
    description: 'Run JavaScript in the current page and return the result as JSON. Use this to extract structured job data.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'JS expression or IIFE to evaluate' } },
      required: ['script'],
    },
  },
  {
    name:        'cdp_click',
    description: 'Click the first element matching a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector' } },
      required: ['selector'],
    },
  },
  {
    name:        'cdp_scroll',
    description: 'Scroll the page by a number of pixels (positive = down).',
    inputSchema: {
      type: 'object',
      properties: { pixels: { type: 'number', description: 'Pixels to scroll vertically' } },
      required: ['pixels'],
    },
  },
  {
    name:        'cdp_list_tabs',
    description: 'List all open Chrome tabs (title + URL + id).',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── MCP server ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'cdp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  const ok  = text => ({ content: [{ type: 'text', text }] });
  const err = text => ({ content: [{ type: 'text', text }], isError: true });

  try {
    // ── cdp_navigate ──────────────────────────────────────────────────
    if (name === 'cdp_navigate') {
      const info = await withTab(async s => {
        await s.send('Page.enable');
        const loaded = s.once('Page.loadEventFired');
        await s.send('Page.navigate', { url: args.url });
        await Promise.race([loaded, new Promise(r => setTimeout(r, LOAD_TIMEOUT))]);
        const { result: r } = await s.send('Runtime.evaluate', {
          expression:    'JSON.stringify({ title: document.title, url: location.href })',
          returnByValue: true,
        });
        return JSON.parse(r.value);
      });
      return ok(`Navigated to: ${info.url}\nTitle: ${info.title}`);
    }

    // ── cdp_snapshot ──────────────────────────────────────────────────
    if (name === 'cdp_snapshot') {
      const snap = await withTab(async s => {
        const { result: r } = await s.send('Runtime.evaluate', {
          expression: `JSON.stringify({
            title: document.title,
            url:   location.href,
            text:  (document.body?.innerText ?? '').slice(0, 8000),
          })`,
          returnByValue: true,
        });
        return JSON.parse(r.value);
      });
      return ok(`Title: ${snap.title}\nURL:   ${snap.url}\n\n${snap.text}`);
    }

    // ── cdp_evaluate ──────────────────────────────────────────────────
    if (name === 'cdp_evaluate') {
      const value = await withTab(async s => {
        const { result: r, exceptionDetails } = await s.send('Runtime.evaluate', {
          expression:    args.script,
          returnByValue: true,
          awaitPromise:  true,
        });
        if (exceptionDetails) {
          throw new Error(exceptionDetails.exception?.description ?? 'Script threw an exception');
        }
        return r?.value;
      });
      return ok(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }

    // ── cdp_click ─────────────────────────────────────────────────────
    if (name === 'cdp_click') {
      await withTab(async s => {
        const { result: r } = await s.send('Runtime.evaluate', {
          expression:    `(sel => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; })(${JSON.stringify(args.selector)})`,
          returnByValue: true,
        });
        if (!r.value) throw new Error(`No element matched selector: ${args.selector}`);
      });
      return ok(`Clicked: ${args.selector}`);
    }

    // ── cdp_scroll ────────────────────────────────────────────────────
    if (name === 'cdp_scroll') {
      await withTab(async s => {
        await s.send('Runtime.evaluate', {
          expression: `window.scrollBy(0, ${Number(args.pixels)})`,
        });
      });
      return ok(`Scrolled ${args.pixels}px`);
    }

    // ── cdp_list_tabs ─────────────────────────────────────────────────
    if (name === 'cdp_list_tabs') {
      const tabs = await fetch(`http://${CDP_HOST}/json`).then(r => r.json());
      const pages = tabs
        .filter(t => t.type === 'page')
        .map(t => `[${t.id}] ${t.title}\n       ${t.url}`)
        .join('\n');
      return ok(pages || 'No open tabs.');
    }

    return err(`Unknown tool: ${name}`);

  } catch (e) {
    return err(`Error: ${e.message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
