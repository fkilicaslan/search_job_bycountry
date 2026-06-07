/**
 * safe-fs.mjs — UTF-8-safe file I/O wrappers.
 *
 * Every function here enforces explicit utf8 encoding.  Never call
 * fs.readFile / fs.writeFile directly in corpus scripts — the Node
 * default (Buffer return / system locale) is what introduced encoding
 * corruption on Windows.  Import from here instead.
 *
 * Parallel to lib/safe-json.mjs (Phase 1 encoding fix).
 */
import { promises as fsp, readFileSync, writeFileSync, appendFileSync } from 'fs';

// ── async ────────────────────────────────────────────────────────────

export async function readText(filePath) {
  return fsp.readFile(filePath, 'utf8');
}

export async function writeText(filePath, content) {
  if (typeof content !== 'string') {
    throw new TypeError(`writeText requires string content, got ${typeof content}`);
  }
  return fsp.writeFile(filePath, content, 'utf8');
}

export async function appendText(filePath, content) {
  if (typeof content !== 'string') {
    throw new TypeError(`appendText requires string content, got ${typeof content}`);
  }
  return fsp.appendFile(filePath, content, 'utf8');
}

// ── sync ─────────────────────────────────────────────────────────────

export function readTextSync(filePath) {
  return readFileSync(filePath, 'utf8');
}

export function writeTextSync(filePath, content) {
  if (typeof content !== 'string') {
    throw new TypeError(`writeTextSync requires string content, got ${typeof content}`);
  }
  writeFileSync(filePath, content, 'utf8');
}

export function appendTextSync(filePath, content) {
  if (typeof content !== 'string') {
    throw new TypeError(`appendTextSync requires string content, got ${typeof content}`);
  }
  appendFileSync(filePath, content, 'utf8');
}
