# Officina local API

Officina has its own API. It's an **MCP server** (Model Context Protocol) built into the app, so any AI app that speaks MCP can work in the canvas: Claude Code, Cursor, Codex, or local models through a bridge.

**Where to find it in the app:** toolbar → **Local API**. The panel shows the address, the token, copy-ready setup lines, and a live list of every tool.

| | |
|---|---|
| Address | `http://127.0.0.1:4780/mcp` (the port can be changed in the Local API panel) |
| Auth | `Authorization: Bearer <token>`, with the token from the Local API panel. `?token=<token>` also works for clients that can't set headers. |
| Transport | MCP Streamable HTTP: JSON-RPC 2.0 over `POST`, JSON responses |
| Reach | Only this computer (bound to 127.0.0.1; requests with a browser `Origin` from other sites are refused) |
| Health | `GET /health`, no token needed |

## Connect

Claude Code:

```bash
claude mcp add --transport http officina http://127.0.0.1:4780/mcp --header "Authorization: Bearer <token>"
```

Other HTTP clients (JSON config):

```json
{ "mcpServers": { "officina": { "type": "http", "url": "http://127.0.0.1:4780/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

Clients that only support stdio:

```json
{ "mcpServers": { "officina": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:4780/mcp?token=<token>"] } } }
```

## Several agents

Every MCP connection is identified by the `clientInfo.name` it sends in `initialize`, and keeps its session through the `Mcp-Session-Id` header. Each name shows up in the **Agents** panel with its own colour. Its cursor, its window highlights and its log entries all use that colour. Per agent you can:

- **pause it**, so its tool calls are refused until you resume it,
- **block trading**, so `trading_place_order` and `trading_cancel_order` are refused,
- see what it's doing now and in which window, and its recent actions.

The global **Stop** button still pauses every agent. The built-in assistant (Assistant panel, local models) is listed as **Assistant**.

## Leading local agents

An outside AI (Claude Code, Codex, any MCP client) can put Officina's local agents to work. They run on the user's own computer with the built-in engine or another local model:

1. `team_spawn` creates a helper with a name, standing instructions and optionally a first task (it starts right away).
2. `team_assign` gives an idle agent a new task.
3. `team_wait` waits until your helpers are done and returns each answer; `team_result` reads one.
4. `team_remove` removes a helper you made. Agents the user made cannot be removed.

Helpers share the first agent's model, work in their own browser windows, cannot create agents themselves and cannot trade. One leader may have at most 6 helpers, and at most 6 agents share one built-in model. A built-in agent can lead too when the user switches on **Can lead other agents** in its settings.

## Tools

The Local API panel lists all tools with their parameters. In short:

| Area | Tools |
|---|---|
| Canvas | `workspace_overview`, `canvas_screenshot`, `item_arrange`, `item_focus`, `item_close`, `cursor_point` |
| Browsers | `browser_open`, `browser_navigate`, `browser_read`, `browser_find`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, `browser_hover`, `browser_drag`, `browser_links`, `browser_batch`, `browser_screenshot` (`marks:true` numbers the clickable elements), `browser_wait`, `browser_fill`, `browser_upload`, `browser_pdf`, `browser_dialog`, `browser_logs`, `browser_frames`, `browser_frame_read`, `browser_frame_action` |
| Notes and files | `note_create`, `note_read`, `note_update`, `file_write`, `file_read`, `file_list`, `library_search` |
| Memory and handoff | `memory_read`, `memory_append`, `ask_user` |
| Local agents | `team_list`, `team_spawn`, `team_assign`, `team_wait`, `team_result`, `team_remove` |
| Keys | `keys_list`, `key_get_value` (only for keys the user marked readable; exchange secrets are never returned) |
| Trading | `trading_status`, `trading_ticker`, `trading_balance`, `trading_place_order` (optional `stopLoss`, `takeProfit`, `trailPct`, `leverage`), `trading_open_orders`, `trading_cancel_order`, `trading_history` |

Agent orders are checked against the limits the user approved in the Trading panel: spend per order and per day, number of orders, symbols, accounts, daily loss, open positions, sell-only mode, futures and maximum leverage. An order outside those limits is rejected with the reason.

## Other local endpoints (off by default)

Turn these on under Features → **Signals & phone**. They run on their own port (default 4781) with their own token.

| Endpoint | What it does |
|---|---|
| `POST /signal` | Runs the chosen saved task (e.g. from a TradingView alert relay). Body `{"id": "<unique alert id>"}`; duplicate IDs are ignored. |
| `GET /` | Phone companion page: live canvas view and a STOP button (open it with the link from the app). |
| `GET /state`, `POST /stop` | What the companion page uses. |
