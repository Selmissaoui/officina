# Officina

<!-- DEMO VIDEO: after pushing, drag Officina-ad.mp4 (under 10 MB for free GitHub accounts) into this README in GitHub's editor and paste the generated link on its own line here, so it plays right on the repo page. -->

**Officina is an agent canvas: a place where you can physically see what your AI agents are doing.** Watch them browse, click, type and take notes on an infinite canvas, each with its own cursor. It's cool to watch, and it makes agents far easier to trust and to debug.

It started as a personal experiment and it is **not perfect**. It is released openly because I'd love for the community to build on it, fork it, break it and make it better. Pull requests, ideas and forks are very welcome.

## Open source, build on it

Officina is licensed under the [Apache License 2.0](LICENSE). You can use it for anything, including commercial projects, modify it and build your own products on top of it. You just have to keep the license and the [NOTICE](NOTICE) file, which credit the original author.

> **Disclaimer:** Officina can connect to exchanges and place real orders if you approve auto-trading. It is provided as is, with no warranty. It is not financial advice. Use the paper account first and keep the limits low. You are responsible for what your agents do.

## Optional software it can use

Officina works on its own. Some parts download or use extra software only if you choose to, and each keeps its own license:

- **Brave browser** is downloaded on demand (checksum-verified) as the optional browser engine for canvas windows. It is not bundled.
- **Ad and tracker filter lists** (EasyList, EasyPrivacy, uBlock and cookie-notice lists) are fetched for the built-in blocker, under their own licenses.
- **Local models** through llama.cpp, LM Studio, Ollama and other servers are optional, and so are the models you load into them.
- **Claude Code, Codex** or any other MCP client can connect to the local API if you want to.

Bundled libraries (Electron, ccxt, the Ghostery adblocker under MPL-2.0, marked, DOMPurify) are listed in `package.json`.
A contained workspace (not an OS) with an infinite canvas: live browsers side by side, notes, files and folders. AI agents drive it over MCP, and everything they do happens in view.

## Start

Run `dist/Officina.exe`. It is portable, so no install is needed. On first run it creates **`Officina-Data/`** next to the exe. That folder is the whole container: browser profiles, notes, files, encrypted keys, session cookies, the trade log and the activity log. Delete it to wipe everything.

## Features

| | |
|---|---|
| **Canvas** | Drag the background to pan and scroll to zoom (Ctrl+wheel always zooms). Drag a window by its header and resize it from the corner. **Fit** (Ctrl+0) shows everything. The layout is saved. |
| **Browsers** | Every browser has its own saved profile: log in once and you stay logged in, including after a restart (session cookies are restored). The browsers keep running when off-screen and identify as a normal Chrome browser. Links that open "in a new tab" become a new canvas window. Downloads land in `files/downloads/`. **Ads, trackers and cookie banners are blocked** in every browser (the EasyList, EasyPrivacy, uBlock and cookie-notice lists that uBlock Origin and Brave use, refreshed weekly), so pages load faster and agents read less clutter. The shield in each browser header shows how much was blocked on the page and switches blocking off for that browser; right-click a browser to keep ads on for one site; Settings has the main switch and the list of allowed sites. |
| **Notes / files / folders** | Markdown notes, drag-and-drop files (copied in, originals untouched), previews for images, PDFs and text, and folder import. |
| **Library** | One panel with everything saved (notes, files, screenshots, downloads, trades, browsers), with search and filters for type and who made it (you or the agent). Click an item to jump to it. Ctrl+K opens it. |
| **API keys** | An easy form for exchange keys (any of the 100+ ccxt exchanges, testnet toggle) and other keys. You can link keys to browsers, encrypted with Windows DPAPI. Agents never see exchange secrets. |
| **Trading** | Approve auto-trading **once**, with limits: max $ per order, max $ per day, max orders per day, allowed symbols, which accounts, and an optional expiry. Within those limits agents trade automatically. There's a paper account (real prices, fake money), a manual order form, and a trade log. |
| **Safety** | Disclaimer on first start, an activity log of every agent action, and **STOP AGENT**, which pauses all agent tools and auto-trading at once. |
| **Bot checks** | When a reCAPTCHA, Cloudflare or "unusual traffic" page appears, that browser comes to the front and the Requests panel opens. You complete the check and press **I'm done**; until then the agent can read the page or go elsewhere, but can't click or type in it. Agent searches go to DuckDuckGo, and the agent loads at most one page per second from the same site. |
| **Settings** (gear icon, Ctrl+,) | Themes: **Professional** (light, dark, or match Windows) and **Gamified** (tower-climbing status windows, with floors, attributes and daily quests earned from real work). Modes: **Simple** (plain language, technical parts tucked behind "More") and **Technical** (everything). **Reset space** deletes everything after you tick a box and type RESET. |
| **Right-click** | Window menu: duplicate, rename, size presets, fill screen, zoom to, front/back, lock position, note colour, log out of a browser, export, close. Canvas menu: new browser/note at that spot, paste, add files, tidy up, show everything. |
| **AI cursor** | The AI has its own cursor, separate from your mouse. You see it glide, click (ripple), type (live caption), press keys, scroll and drag, with a short trail. The cursor button in the toolbar (or Ctrl+Shift+C) turns it on or off. When it's off, the AI works without the animation delay. Options: follow the AI around the canvas, captions, speed (slow / normal / fast). |
| **Team** (in the Assistant dock) | Several built-in agents at once. Every agent has its own name, colour, model, instructions and conversation, and gets a tab. The **Team** tab shows all agents as cards with their own task box: type a task in each and press **Start all**. **+** adds an agent with the same model, **Duplicate** copies one including its instructions, right-click a tab to rename, change settings or remove. Agents on the same built-in model share one engine (one slot per agent), so extra agents use no extra graphics memory. Each agent works in its own browser windows and is told which windows another agent is using. **Leaders:** switch on *Can lead other agents* and an agent may split a big task over helper agents it creates itself (shown as ↳ tabs), wait for them and combine their answers. Claude Code or Codex can do the same over the local API (`team_*` tools). Helpers share the model, cannot make helpers themselves and cannot trade; at most 6 per leader and 6 per model. |
| **Assistant** (Ctrl+J) | Built-in chat with a local model. The **built-in engine** runs models inside Officina, with no other app open: install it once from the Assistant setup (llama.cpp, Vulkan 33 MB or CUDA about 580 MB, stored in `Officina-Data/engine`), then pick any GGUF model. Models already downloaded in LM Studio or Ollama are found automatically, and you can drop `.gguf` files into `Officina-Data/models`. The engine picks the dedicated graphics card, fits the model to its memory, and stops when the app closes. **Long conversations** are compressed automatically: near 80% of the room left for the conversation, older page reads are shortened first, and if that is not enough the model writes a summary of the older steps; the task and the latest steps stay word for word. A line in the chat ("Chat compressed: about 13K → 8K tokens") opens the summary. Besides that, it auto-detects Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan, KoboldCpp and text-generation-webui, and you can add any other OpenAI-compatible server (optional API key). It works through the same tools, AI cursor, STOP button and trading limits as external agents. Shows tool steps and model thinking. Settings: context size, temperature, essential or all tools, image support, max steps. |
| **Features button** (grid icon in the toolbar) | Lists every feature with a button that opens it: tasks and schedules, memory, notifications, AI handoff, browser rules, replay, spaces and frames, positions and protective orders, futures cap, backup, signals and phone STOP, widgets, voice, backtests and browser tools. |
| **Several agents** | Every connected MCP client and the built-in assistant gets its own coloured cursor with its name. |
| **Quality of life** | Close with Undo, Ctrl+V pastes a link (browser), text (note) or image (file), double-click the canvas for a new note, 8px snap (hold Alt to move freely), arrow keys to nudge, Del / Ctrl+D / F2 / Enter on the selected window. The full list is under Settings, then Keyboard shortcuts. |

## Local API (MCP)

Officina has its own API: an MCP server at `http://127.0.0.1:4780/mcp`, reachable only from this computer. In the app: toolbar → **Local API** (address, token, setup lines, every tool). Full reference: [docs/API.md](docs/API.md). Every connected app shows up under **Agents** with its own colour, and can be paused or kept away from trading on its own.

## Connect an agent

Agent panel → copy the command. For Claude Code:

```
claude mcp add --transport http officina http://127.0.0.1:4780/mcp --header "Authorization: Bearer <token>"
```

The tools cover: `workspace_overview`, `canvas_screenshot`, `browser_open/navigate/read/find/click/type/key/scroll/hover/drag/links/batch/screenshot/wait`, `cursor_point` (show the user something), click by ref, visible text or x/y, `browser_screenshot marks:true` (numbered elements for vision models), `note_create/read/update`, `file_write/read/list`, `library_search`, `keys_list`, `trading_status/ticker/balance/place_order/open_orders/cancel_order/history`, and `item_arrange/focus/close`.

## Develop

```
npm install
npm start          # dev run, data in workspace-dev/
npm test           # offline unit tests
npm run e2e -- <workspace>   # end-to-end check of every feature (app running with --remote-debugging-port=9333)
npm run dist       # build dist/Officina.exe
```

Built with Electron 44, ccxt and plain ES modules (no bundler).
