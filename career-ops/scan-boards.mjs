#!/usr/bin/env node
/**
 * scan-boards.mjs — DEPRECATED
 *
 * LinkedIn, Indeed, and Stepstone are now scraped via the Chrome DevTools Protocol
 * MCP server (career-ops/mcp-cdp.mjs). Claude drives your real Chrome session directly.
 *
 * To scan job boards, just tell Claude:
 *   "scan LinkedIn"
 *   "scan Indeed"
 *   "scan Stepstone"
 *   "scan all boards"
 *
 * Prerequisites:
 *   Start Chrome with remote debugging enabled:
 *     & "C:\Program Files\Google\Chrome\Application\chrome.exe" \
 *         --remote-debugging-port=9222 \
 *         --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data"
 *   Then log into LinkedIn, Indeed, and Stepstone in that Chrome window.
 */

console.log('scan-boards.mjs is no longer used.');
console.log('');
console.log('All job board scanning (LinkedIn, Indeed, Stepstone) is now done');
console.log('by Claude via the CDP MCP server connected to your real Chrome session.');
console.log('');
console.log('Just tell Claude: "scan LinkedIn", "scan Indeed", "scan Stepstone",');
console.log('or "scan all boards" and it will drive Chrome directly.');
console.log('');
console.log('Make sure Chrome is running with:');
console.log('  --remote-debugging-port=9222');
