---
name: reuse-chrome-devtools
description: Reuse the user's currently running real Chrome through this project's chrome-devtools MCP to test the YouTube subtitle extension. Use whenever work changes the popup, manifest, content script, service worker, Chrome messaging, permissions, YouTube DOM integration, or the user asks for real Chrome or MCP verification.
compatibility: Requires this repository's .mcp.json and Chrome 144+ with remote debugging enabled.
---

# Reuse Real Chrome with DevTools MCP

Use the `chrome-devtools` server configured by this repository's `.mcp.json`. Attach to the Chrome instance the user is already running; do not launch another browser or profile.

## Connection rules

- Chrome must have remote debugging enabled at `chrome://inspect/#remote-debugging`.
- Keep one MCP connection alive for the complete workflow.
- Start with `list_pages`. Continue only when it shows the user's existing tabs.
- A result containing only `about:blank`, an unexpected empty extension list, or an MCP cache profile means the wrong Chrome was opened. Stop and correct the connection.
- Treat delayed popup targets and temporarily missing UI as recoverable. Poll `list_pages` instead of reconnecting immediately.
- Never terminate the user's real Chrome.
- Do not read or output API keys, cookies, tokens, browsing history, or unrelated page content.

## Extension test workflow

1. Run the repository's automated checks relevant to the change.
2. Run `bun run build:prod`. Browser verification must use the latest production build.
3. Use `list_extensions` to find an existing installation. Prefer `reload_extension`; install the unpacked absolute path `dist/extension/` only when the extension is not installed.
4. Select an existing YouTube watch tab or open one tab in the attached Chrome, then reload it so the latest content scripts run.
5. Verify observable extension behavior:
   - `#transcript-download-button` exists exactly once.
   - `#transcript-copy-button` exists exactly once.
   - `#youtube-local-subtitle-overlay` is present when cached bilingual subtitles are available.
   - Popup video recognition and cached translation status match the selected YouTube tab.
6. Trigger the extension action, poll `list_pages` for the popup target, select it, and take a fresh snapshot.
7. Exercise the popup tabs affected by the change:
   - Subtitle tab recognizes the current video and exposes the expected translation action.
   - API tab keeps built-in provider identity and URL fields locked while a custom-provider draft remains editable.
   - Style tab switches light and dark themes with readable computed colors.
8. Inspect the popup console and this extension's Service Worker console. Separate extension failures from YouTube's own warnings.

## MCP call discipline

- Use a single MCP call for one simple action.
- Use `mcpScript` when several calls need sequencing, filtering, polling, or shared state.
- Take a fresh accessibility snapshot after switching page or tab before using element IDs; hidden panels may not appear in earlier snapshots.
- Keep assertions tied to user-visible state, DOM counts, computed styles, and sanitized status fields.
- Report the tested build, page URL, terminal UI state, relevant counts, and extension-owned console errors.

If the MCP connection is unavailable, finish all local checks and report the browser verification as blocked. Do not replace real-browser verification with a fake DOM page or a script that depends on local secrets.
