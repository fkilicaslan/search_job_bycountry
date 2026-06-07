/**
 * Serialize to JSON with all non-ASCII characters escaped as \uXXXX.
 * Produces pure ASCII output that renders correctly regardless of the
 * terminal/editor code page (CP437, CP1252, UTF-8, etc.).
 */
export function safeStringify(obj, indent = 0) {
  return JSON.stringify(obj, null, indent || undefined)
    .replace(/[-￿]/g, c =>
      `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`
    );
}
