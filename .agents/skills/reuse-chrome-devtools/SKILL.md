---
name: reuse-chrome-devtools
description: Approval-gated workflow for diagnosing and testing the YouTube subtitle extension in the user's currently running real Chrome through this project's chrome-devtools MCP. After connection approval, perform only the minimum browser checks needed for the current issue. A full regression run is separate work and always requires explicit user approval.
compatibility: Requires this repository's .mcp.json and Chrome 144+ with remote debugging enabled.
---

# Reuse Real Chrome with DevTools MCP

Use the `chrome-devtools` server configured by this repository's `.mcp.json`. Attach to the Chrome instance the user is already running; do not launch another browser or profile.

## Approval gate

- Reading this Skill does not authorize access to the user's browser.
- Before the first Chrome MCP call in a conversation, explain briefly why real-browser verification is useful and ask for explicit approval.
- Approval must be given in the current conversation. Do not infer it from remote debugging being enabled, an installed extension, or prior sessions.
- Once approved, keep one MCP connection alive and reuse it for later Chrome verification in the same conversation and agreed scope. Do not ask again for each tool call, page reload, extension reload, or related regression check.
- Until approval is received, continue with local inspection, automated tests, type checks, and builds where appropriate. Report real-browser verification as not run unless the user approves it.
- Ask again only in a new conversation or before materially expanding access to unrelated pages, data, or actions.

## Scope discipline

- Browser access for a bug report authorizes only the minimum reproduction and verification needed for that bug.
- Stop collecting browser evidence once the cause is established. Continue implementation and automated checks locally.
- Do not turn a focused diagnosis into the full extension test workflow.
- For subtitle acquisition changes, cover the three user entry points—translation, copy, and download—with local automated tests. Their shared expected behavior is: try acquisition without opening the transcript panel first, and open the visible panel only as the final fallback.
- Leave the final real-browser regression to the user unless the user separately asks the agent to run it.
- Before running a full regression, explain its scope and expected cost, then obtain separate explicit approval even when the persistent Chrome connection is already authorized.
- A full regression includes broad checks unrelated to the immediate bug, such as exercising every popup tab, testing both themes, checking all providers, or inspecting the complete extension surface.

## Connection rules

- Chrome must have remote debugging enabled at `chrome://inspect/#remote-debugging`.
- Keep one MCP connection alive for the complete workflow.
- Start with `list_pages`. Continue only when it shows the user's existing tabs.
- A result containing only `about:blank`, an unexpected empty extension list, or an MCP cache profile means the wrong Chrome was opened. Stop and correct the connection.
- Treat delayed popup targets and temporarily missing UI as recoverable. Poll `list_pages` instead of reconnecting immediately.
- Never terminate the user's real Chrome.
- Do not read or output API keys, cookies, tokens, browsing history, or unrelated page content.

## Full regression workflow

Run this section only after the user separately approves a full regression.

1. Run the repository's automated checks relevant to the change.
2. Run `bun run build:prod`. Browser verification must use the latest production build.
3. If the user has explicitly approved Chrome DevTools MCP access in this conversation, use `list_pages` as the first MCP call, then use `list_extensions` to find an existing installation. Prefer `reload_extension`; install the unpacked absolute path `dist/extension/` only when the extension is not installed.
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

If approval is not given, finish all local checks and report browser verification as not run. If approval is given but the persistent MCP connection is unavailable, finish all local checks and report browser verification as blocked; reconnecting within the same conversation and scope does not require another approval. Do not replace real-browser verification with a fake DOM page or a script that depends on local secrets.
