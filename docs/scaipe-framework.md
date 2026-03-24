# scAIpe Framework — Complete Architecture & Recreation Guide

A framework for building AI-powered game agents with event-driven control, compact state encoding, layered planning, and a desktop shell. This document is comprehensive enough to rebuild the entire system from scratch for any game.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Event Engine Deep Dive](#2-event-engine-deep-dive)
3. [TOON Integration](#3-toon-integration)
4. [Layered Architecture](#4-layered-architecture)
5. [Script Runner & Macro System](#5-script-runner--macro-system)
6. [Gateway — The WebSocket Router](#6-gateway--the-websocket-router)
7. [Knowledge Base](#7-knowledge-base)
8. [Desktop App — Electrobun Split-View](#8-desktop-app--electrobun-split-view)
9. [Recreation Guide — Building This for Any Game](#9-recreation-guide--building-this-for-any-game)
10. [Annotated Code Examples](#10-annotated-code-examples)

---

## 1. System Overview

### What This Is

scAIpe is a framework for building autonomous game agents that:

- **React** to game events in real-time (attacked, low HP, level-up, inventory full)
- **Log** everything in a compact, token-efficient format (TOON) so AI planners can consume game state cheaply
- **Layer** control into executor (event loop), planner (strategy), and orchestrator (goal-setting)
- **Persist** knowledge across sessions — every discovery, danger, shop, and combat encounter is logged
- **Wrap** the game in a desktop app with a live status panel and script runner

### Why Event-Driven

Polling-based bots waste cycles checking "did anything change?" every tick. The event engine **diffs** game state and only fires handlers when something meaningful happens. This means:

- Handlers are focused: `on('low_hp', eatFood)` instead of `if (hp < threshold && prevHp >= threshold)`
- Multiple concerns compose cleanly: combat handler, loot handler, progress logger all run independently
- The tick event exists as an escape hatch for continuous behavior (grinding loops)

### How TOON Helps

Game state is large. A full JSON state dump might be 2-4KB. TOON encoding compresses it to 30-60% of that size while remaining human-readable. This matters when:

- Feeding state to an LLM planner (token cost scales with input size)
- Logging thousands of state snapshots (disk/memory)
- Embedding state in chat messages or journal entries

### Data Flow

```
Game Client (Browser)
    │
    │ WebSocket: state updates, action results
    ▼
Gateway (server/gateway/)
    │
    │ WebSocket: relays state to SDK, routes actions to bot
    ▼
BotSDK (sdk/index.ts)               ◄── Low-level: actions resolve on server ACK
    │
    ▼
BotActions (sdk/actions.ts)          ◄── High-level: actions resolve on effect completion
    │
    ▼
EventEngine (sdk/event-engine.ts)    ◄── Diffs state, emits typed events
    │
    ▼
Script Handlers                      ◄── React to events, execute game logic
    │
    ▼
TOON Logger (sdk/state-logger.ts)    ◄── Encodes state, logs discoveries
    │
    ▼
Knowledge Base (learnings/)          ◄── Persistent memory across sessions
```

---

## 2. Event Engine Deep Dive

**Source**: `sdk/event-engine.ts`

### Architecture

The engine is a poll-diff-emit loop:

```
┌─────────────────────────────────────────┐
│              Event Loop                 │
│                                         │
│  1. sdk.getState()       ← poll         │
│  2. diff(state, prev)    ← compare      │
│  3. emit(events)         ← notify       │
│  4. prev = state         ← advance      │
│  5. sleep(600ms)         ← throttle     │
│                                         │
└─────────────────────────────────────────┘
```

The poll interval (600ms) matches approximately one game tick. This is configurable but should stay close to the game's native tick rate.

### Event Types

| Event | Trigger Condition | Payload |
|-------|-------------------|---------|
| `attacked` | `inCombat` flips true, nearby aggressive NPC found | `{ by: string, level: number }` |
| `combat_end` | `inCombat` flips false | `{ killed?: string, hpLost: number }` |
| `low_hp` | HP drops below 30% threshold | `{ hp, maxHp, pct }` |
| `died` | HP drops to 0 | `{}` |
| `level_up` | Game message matches "advanced a X level" | `{ skill, level, xp }` |
| `inventory_full` | Inventory count hits 28 (max) | `{}` |
| `inventory_change` | Item hash differs from previous tick | `{ added: string[], removed: string[] }` |
| `new_message` | Unrecognized game message with new tick | `{ text, msgType }` |
| `stunned` | Game message matches "stunned" | `{}` |
| `cant_reach` | Game message matches "can't reach" | `{}` |
| `position_change` | Player coordinates differ | `{ from: {x,z}, to: {x,z} }` |
| `idle` | No action detected | `{}` |
| `tick` | Every poll cycle (always emitted) | `{ state: BotWorldState }` |

### The Diff Algorithm

The `diff()` method compares the current `BotWorldState` against the previous one and returns an array of events. Key implementation details:

**Combat detection** — Uses the `inCombat` boolean flag flip. When entering combat, scans `nearbyNpcs` for the closest aggressive NPC to identify the attacker:

```typescript
if (p.combat.inCombat && !prev?.player?.combat.inCombat) {
    const nearbyAggro = state.nearbyNpcs.find(n => n.combatLevel > 0 && n.distance < 2);
    if (nearbyAggro) {
        events.push({ type: 'attacked', by: nearbyAggro.name, level: nearbyAggro.combatLevel });
    }
}
```

**Inventory hashing** — Instead of deep-comparing item arrays, builds a sorted hash string (`"bones:1|logs:3|..."`) and compares strings. When different, computes set differences for added/removed items:

```typescript
const invHash = state.inventory.map(i => `${i.name}:${i.count}`).sort().join('|');
if (invHash !== this.prevInvHash) {
    const prevItems = new Set(this.prevInvHash.split('|'));
    const currItems = new Set(invHash.split('|'));
    const added = [...currItems].filter(x => !prevItems.has(x)).map(x => x.split(':')[0]);
    const removed = [...prevItems].filter(x => !currItems.has(x)).map(x => x.split(':')[0]);
    if (added.length || removed.length) {
        events.push({ type: 'inventory_change', added, removed });
    }
}
```

**Message parsing** — Iterates through `gameMessages`, skipping already-seen ticks via `prevMsgTick`. Uses regex matching to classify messages into structured events (stunned, can't reach, level up) or passthrough as `new_message`.

**HP thresholds** — Low HP fires once when crossing the 30% boundary downward, not on every tick below threshold. Death fires when HP transitions from >0 to <=0.

**Tick always fires** — The `tick` event is appended to every diff result, providing a heartbeat for continuous behaviors like grinding loops.

### Handler Registration & Execution

```typescript
const engine = new EventEngine(sdk, bot);

// Specific event handler
engine.on('low_hp', async (event, ctx) => {
    const food = ctx.sdk.findInventoryItem(/bread|chicken/i);
    if (food) await ctx.bot.eatFood(food);
});

// Wildcard handler — receives ALL events
engine.on('*', async (event, ctx) => {
    console.log(`[${event.type}]`, JSON.stringify(event));
});

await engine.start(); // Blocks until engine.stop() is called
```

Handlers receive:
- `event` — the typed `GameEvent` discriminated union
- `ctx` — `{ bot: BotActions, sdk: BotSDK, engine: EventEngine }`

Handlers run **sequentially** within a type (specific handlers first, then wildcards). Errors are caught and logged without stopping the engine.

### Adding New Event Types

1. Add the type to the `GameEvent` union in `event-engine.ts`:
```typescript
type GameEvent =
    | { type: 'attacked'; by: string; level: number }
    // ...existing types...
    | { type: 'new_area'; area: string; x: number; z: number }  // NEW
```

2. Add detection logic in `diff()`:
```typescript
// In the diff method, after existing checks:
if (prev?.player && (
    Math.abs(p.worldX - prev.player.worldX) > 50 ||
    Math.abs(p.worldZ - prev.player.worldZ) > 50
)) {
    events.push({ type: 'new_area', area: 'unknown', x: p.worldX, z: p.worldZ });
}
```

3. Register handlers in your script:
```typescript
engine.on('new_area', async (e, { sdk }) => {
    if (e.type !== 'new_area') return;
    logLocation('discovered', e.x, e.z, sdk.getState()!);
});
```

---

## 3. TOON Integration

**Source**: `sdk/state-logger.ts`, `@toon-format/toon`

### What TOON Is

TOON (Token-Optimized Object Notation) is a compact data format designed to minimize token count when fed to LLMs. It looks like:

```
skills[3]{name,lvl,xp}:
  Attack,42,18400
  Strength,50,33000
  Defence,33,9900
```

Compared to JSON equivalent:
```json
{"skills":[{"name":"Attack","lvl":42,"xp":18400},{"name":"Strength","lvl":50,"xp":33000},{"name":"Defence","lvl":33,"xp":9900}]}
```

TOON is ~40% smaller in tokens. Over thousands of state dumps, this saves significant LLM context and cost.

### Encoding Game State

The `stateToToon()` function in `state-logger.ts` converts a full `BotWorldState` into compact TOON. It applies several optimizations:

**Selective inclusion** — Only skills with XP > 0 are included (plus Hitpoints which always matters). Only the first 8 nearby NPCs/locs, 5 ground items, and 3 messages:

```typescript
export function stateToToon(state: BotWorldState): string {
    const p = state.player;
    const data: any = {
        player: {
            name: p.name, combat: p.combatLevel,
            hp: p.hp, maxHp: p.maxHp,
            x: p.worldX, z: p.worldZ, level: p.level,
            inCombat: p.combat?.inCombat ?? false,
        },
        skills: state.skills
            .filter(s => s.experience > 0 || s.name === 'Hitpoints')
            .map(s => ({ name: s.name, lvl: s.level, xp: s.experience })),
        inventory: state.inventory.map(i => ({
            name: i.name, count: i.count, slot: i.slot
        })),
        nearbyNpcs: state.nearbyNpcs.slice(0, 8).map(n => ({
            name: n.name, lvl: n.combatLevel, dist: n.distance,
            opts: n.optionsWithIndex?.map(o => o.text).join('/') || ''
        })),
        // ...truncated for brevity
    };
    return encode(data);
}
```

**Short field names** — `lvl` not `level`, `dist` not `distance`, `opts` not `options`. Every character counts at scale.

**Options as delimited strings** — NPC/loc interaction options are joined with `/` instead of being separate array entries: `"Attack/Pickpocket/Talk-to"`.

### Logging Functions

The state logger provides specialized logging functions that all write to `learnings/exploration/`:

| Function | File | Purpose |
|----------|------|---------|
| `logDiscovery(category, entry)` | `{category}.toon` | Generic discovery log |
| `logLocation(name, x, z, state)` | `locations.toon` | Area survey with NPCs, objects, items |
| `logCombat(npc, result, hpBefore, hpAfter, xp?)` | `combat.toon` | Fight outcomes |
| `logShop(name, items)` | `shops.toon` | Shop inventories and prices |
| `logDanger(desc, x, z, threat)` | `dangers.toon` | Aggressive NPCs, unsafe zones |

Each entry is timestamped and TOON-encoded:

```typescript
export function logDiscovery(category: string, entry: string) {
    ensureLogDir();
    const file = join(LOG_DIR, `${category}.toon`);
    const timestamp = new Date().toISOString().slice(0, 19);
    appendFileSync(file, `# ${timestamp}\n${entry}\n\n`);
}
```

### Event Logging

The event engine itself logs all significant events (everything except `tick` and `idle`) to `events.log` as tab-separated lines:

```
2026-03-24T03:15:42 | attacked | {"type":"attacked","by":"Dark wizard","level":7}
2026-03-24T03:15:48 | low_hp | {"type":"low_hp","hp":12,"maxHp":41,"pct":29}
2026-03-24T03:16:01 | combat_end | {"type":"combat_end","hpLost":29}
```

This provides a time-series event stream that AI planners can analyze for patterns ("dark wizards always hit me for 5-8 damage" or "I level up every ~15 minutes at this spot").

---

## 4. Layered Architecture

### The Three Layers

```
┌──────────────────────────────────────────────┐
│  Layer 3: ORCHESTRATOR / PLANNER             │
│  ─────────────────────────────────────────── │
│  • Reads wiki/, learnings/, knowledge base   │
│  • Researches quests, maps optimal routes    │
│  • Sets high-level goals for the executor    │
│  • Runs as a separate AI agent in parallel   │
│  • Communicates via goal files or messages    │
└──────────────────┬───────────────────────────┘
                   │ goals, strategy
                   ▼
┌──────────────────────────────────────────────┐
│  Layer 2: EXECUTOR (Event Engine)            │
│  ─────────────────────────────────────────── │
│  • Runs current task (grind, bank, quest)    │
│  • Reacts to events: attacked → flee,        │
│    low_hp → eat, inventory_full → bank       │
│  • Logs discoveries in TOON                  │
│  • Self-contained: handles all contingencies │
└──────────────────┬───────────────────────────┘
                   │ game actions
                   ▼
┌──────────────────────────────────────────────┐
│  Layer 1: SDK                                │
│  ─────────────────────────────────────────── │
│  • BotSDK: low-level WebSocket protocol      │
│    sendInteractNpc, sendWalkTo, getState     │
│    Resolves on server ACKNOWLEDGMENT         │
│  • BotActions: high-level domain helpers     │
│    attackNpc, walkTo, chopTree, openBank     │
│    Resolves on EFFECT COMPLETION             │
└──────────────────────────────────────────────┘
```

### Layer 1: SDK — The Protocol Layer

**BotSDK** (`sdk/index.ts`) manages the WebSocket connection to the gateway. Key design decisions:

- **Connection modes**: `control` (can send actions) vs `observe` (read-only state stream). Only one controller per bot; unlimited observers.
- **Action ID tracking**: Every action gets a unique ID. The SDK holds a `pendingActions` map and resolves/rejects promises when the gateway relays results.
- **Auto-reconnect**: Exponential backoff with configurable max retries. Connection state changes fire listeners so scripts can react.
- **Gateway URL derivation**: `deriveGatewayUrl()` handles localhost, custom ports, and remote TLS endpoints:

```typescript
// "localhost" → ws://localhost:7780
// "myserver.com" → wss://myserver.com/gateway
// "ws://custom:9999" → ws://custom:9999
```

**BotActions** (`sdk/actions.ts`) wraps SDK calls with game knowledge. The critical distinction:

| BotSDK method | BotActions method | Difference |
|---------------|-------------------|------------|
| `sendInteractNpc(index, op)` | `attackNpc(target)` | Actions finds NPC, walks to it, starts combat, **waits for combat to end** |
| `sendWalkTo(x, z)` | `walkTo(x, z)` | Actions uses pathfinding, **opens doors along the path** |
| `sendUseItemOnLoc(slot, loc, op)` | `useItemOnLoc(item, loc)` | Actions finds both, walks close, uses, **waits for result** |

BotActions methods also auto-dismiss blocking UI (level-up dialogs) before executing. This is the "porcelain" layer — domain-aware, error-handling, complete.

### Layer 2: Executor — The Event Engine

Scripts at this layer register event handlers and start the engine. The engine runs until explicitly stopped or a goal condition is met. Example patterns:

- **Reactive safety**: `on('low_hp', eat)`, `on('attacked', flee if dangerous)`
- **Continuous work**: `on('tick', findAndAttackTarget)`
- **State transitions**: `on('inventory_full', cookAndBank)`, `on('level_up', checkGoal)`
- **Progress tracking**: `on('tick', logProgressEvery30s)`

### Layer 3: Planner — The AI Strategist

The planner is an AI agent (Claude, GPT, etc.) that:

1. Reads the knowledge base (`learnings/`, `wiki/`)
2. Analyzes current character state (skills, inventory, quest progress)
3. Sets goals and writes scripts or configures the executor
4. Runs in parallel — doesn't block the executor

Communication between planner and executor can happen via:
- Goal files that the executor reads on startup
- Event engine's `setTask()` method for context logging
- Shared state through the knowledge base

---

## 5. Script Runner & Macro System

**Source**: `sdk/runner.ts`

### The Runner

`runScript()` provides zero-boilerplate script execution:

```typescript
import { runScript } from '../../sdk/runner';

await runScript(async ({ bot, sdk }) => {
    await bot.chopTree();
    return sdk.getInventory();
});
```

It handles:

1. **Credential loading** — Auto-discovers `bot.env` from three sources:
   - `process.env` (via `bun --env-file`)
   - Sibling `bot.env` next to the script file
   - Command line arg (`bun script.ts mybot` → `bots/mybot/bot.env`)

2. **Connection management** — Maintains a connection pool (`Map<string, BotConnection>`). Reuses existing connections for the same bot.

3. **Timeout** — Optional overall script timeout that races against the script promise.

4. **Disconnect handling** — Three modes:
   - `'error'` (default): Throw `BotDisconnectedError` immediately
   - `'wait'`: Pause and wait for reconnection up to `reconnectTimeout`
   - `'ignore'`: Let actions fail naturally

5. **Signal handling** — Catches SIGTERM/SIGINT/SIGHUP for clean disconnection when the parent shell is killed.

6. **Post-run output** — Prints script return value, errors, and final world state.

### Script Patterns

**Simple one-shot** — Do something and exit:
```typescript
await runScript(async ({ bot, sdk }) => {
    await bot.walkTo(3200, 3200);
    await bot.openBank();
    await bot.depositItem(sdk.findInventoryItem(/^logs$/i)!);
});
```

**Event-driven grind** — Run indefinitely with reactive handlers:
```typescript
await runScript(async ({ bot, sdk }) => {
    const engine = new EventEngine(sdk, bot);
    engine.on('low_hp', async (e, ctx) => { /* eat food */ });
    engine.on('inventory_full', async (e, ctx) => { /* bank */ });
    engine.on('tick', async (e, ctx) => { /* attack target */ });
    await engine.start(); // blocks until engine.stop()
}, { timeout: 60 * 60_000 }); // 1 hour max
```

### Macro System Design

Macros chain scripts together as composable units. The pattern:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐     ┌───────────────┐
│ bank-and-sell│ ──► │ buy-gear     │ ──► │ walk-to-training│ ──► │ grind-defence │
└─────────────┘     └──────────────┘     └─────────────────┘     └───────────────┘
   precondition:       precondition:        precondition:           precondition:
   inventory has        gold >= 1040         has weapon              at location
   items to sell
```

**Preconditions** — Each macro checks requirements before executing. If unmet, it can either fail or chain to a sub-macro that satisfies the precondition.

**Event triggers** — Macros can be triggered by events:
- `inventory_full` → `cook-food` → `bank-items` → resume grinding
- `died` → `walk-back-to-training-spot` → resume
- `level_up(Defence >= 45)` → `switch-to-attack-training`

**Implementation** — Each macro is a script file in `bots/{name}/`. The runner's connection pooling means sequential scripts reuse the same WebSocket. The gateway's script runner API (`POST /run-script`) enables the desktop app to trigger macros.

---

## 6. Gateway — The WebSocket Router

**Source**: `server/gateway/gateway.ts`

### Role

The gateway sits between game clients (browsers) and SDK clients (scripts). It:

1. Accepts bot connections (game browser → gateway)
2. Accepts SDK connections (script → gateway)
3. Routes state updates from bots to SDKs
4. Routes actions from SDKs to bots
5. Manages session lifecycle (connect, disconnect, takeover)
6. Provides HTTP endpoints for the desktop app

### Session Model

```
Bot Sessions (one per username):
┌──────────────────────────────┐
│ BotSession                   │
│   ws: WebSocket              │
│   username: "dexrunner"      │
│   lastState: BotWorldState   │
│   lastStateReceivedAt: ts    │
│   currentActionId: string    │
│   connectedAt: ts            │
└──────────────────────────────┘

SDK Sessions (many per bot):
┌──────────────────────────────┐
│ SDKSession                   │
│   ws: WebSocket              │
│   sdkClientId: "cli-abc123"  │
│   targetUsername: "dexrunner" │
│   mode: "control" | "observe"│
└──────────────────────────────┘
```

**Last-controller-wins**: When a new `control` mode SDK connects for the same bot, existing controllers are disconnected. This prevents stale daemon connections from blocking new scripts. Multiple `observe` mode clients coexist freely.

**Bot takeover**: When a new bot client connects with an existing username, the gateway sends `save_and_disconnect` to the old session, waits for it to close, then promotes the new connection.

**Session status**: `active` (fresh state), `stale` (no state update for 8s+), `dead` (WebSocket closed).

### HTTP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | All connections status |
| `/status/:username` | GET | Per-bot status |
| `/scripts/:botName` | GET | List bot scripts |
| `/run-script` | POST | Run a script `{ botName, script }` |
| `/stop-script` | POST | Kill running script |
| `/script-output` | GET | Get stdout from running script |

### Script Runner

The gateway spawns scripts as child processes via `Bun.spawn()`:

```typescript
const proc = Bun.spawn(['bun', scriptPath], {
    cwd: botDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
});
```

It captures stdout into a ring buffer (max 200 lines) and exposes it via `/script-output`. The desktop app polls this endpoint to show live output in the Scripts panel.

### Authentication

When `LOGIN_SERVER_ENABLED=true`, SDK connections authenticate against a separate login server via WebSocket. In development mode (default), all connections are allowed.

---

## 7. Knowledge Base

### Structure

```
learnings/
├── exploration/
│   ├── events.log          ← Timestamped event stream from EventEngine
│   ├── journal.toon        ← Human/AI observations and decisions
│   ├── locations.toon      ← Surveyed areas with NPCs, objects, items
│   ├── combat.toon         ← Fight outcomes and XP rates
│   ├── shops.toon          ← Shop inventories and prices
│   └── dangers.toon        ← Aggressive NPCs, unsafe zones
├── banking.md              ← Banking strategies and locations
├── combat.md               ← Combat patterns
├── routes-and-dangers.md   ← Safe paths between locations
└── world-map.md            ← Explored locations overview

wiki/
├── npcs/                   ← NPC data (locations, drops, combat levels)
├── items/                  ← Item data (stats, sources, uses)
├── skills/                 ← Skill training guides
└── shops/                  ← Shop inventories
```

### TOON Journal Format

The journal (`learnings/exploration/journal.toon`) is a session-based log of decisions and observations. It uses a structured but human-readable format:

```
# SESSION: 2026-03-24 ~3AM

## Character Decision: Initiate Pure Build
reason: Defence already ruined past 1 by accident
plan: 45 def, 60 atk, 99 str/range/magic
current_style: Block (Defensive) — training Defence first since it's 1

## Observation: bot.attackNpc() is SLOW
what: High-level attackNpc walks to target, waits for full combat end
problem: At combat 43 vs chickens Lvl 1, I one-shot them. Walk/wait overhead wastes time.
insight: Should use low-level sdk.sendInteractNpc() for speed

## Observation: Dark Wizards nearly killed me
what: Walking from cow field to Draynor bank, arrived at 14/41 HP
why: Defence 1 means magic attacks hit full damage
lesson: ALWAYS check route dangers before walking. Carry food when traveling.
safe_route: Go north through Lumbridge to Varrock bank instead
```

Key patterns:
- **Session headers** with date for chronological context
- **Category prefixes** (Observation, Decision, Plan) for filtering
- **Structured fields** (what/why/lesson/insight) so AI can extract actionable knowledge
- **Concrete data** (coordinates, HP values, XP rates) not vague descriptions

### Auto-Discovery Logging

The state logger functions are designed to be called from event handlers, creating an automatic knowledge accumulation loop:

```
EventEngine tick
  → Script visits new area
    → logLocation('Lumbridge', 3222, 3218, state)
      → Writes NPCs, objects, items at that position
  → Script fights NPC
    → logCombat('Chicken', 'killed', 41, 38, 12)
      → Records XP rate and damage taken
  → Script finds shop
    → logShop('General Store', items)
      → Records prices and stock
```

Over time, the knowledge base fills up with real gameplay data that the planner can reference.

### Memory Persistence

Knowledge persists across sessions because:
1. All logging uses `appendFileSync` — data is written immediately, never buffered
2. Files are plain text — no database, no serialization
3. The journal is manually curated — the AI/user writes observations after runs
4. Wiki data is static reference — doesn't change per session

---

## 8. Desktop App — Electrobun Split-View

**Source**: `runelight/src/bun/index.ts` (main process), `runelight/src/mainview/App.tsx` (panel)

### Why Electrobun

Electrobun is a lightweight alternative to Electron for Bun-native desktop apps. Key advantages:
- Uses the system WebView instead of bundling Chromium (~100MB savings)
- BrowserView API for embedding multiple web views in one window
- Bun-native — no Node.js compatibility layer needed
- System tray support for background operation

### Window Layout

```
┌─────────────────────────────────────────────────────┐
│                    scAIpe Window (1400x900)          │
│                                                     │
│  ┌──────────────────────┐ ┌───────────────────────┐ │
│  │                      │ │     Side Panel        │ │
│  │    Game Viewport     │ │     (300px wide)      │ │
│  │    (BrowserView)     │ │     (BrowserView)     │ │
│  │                      │ │                       │ │
│  │  - Loads game client │ │  - SolidJS app        │ │
│  │  - Sandboxed         │ │  - Status/Inventory   │ │
│  │  - Full game view    │ │  - Nearby/Scripts     │ │
│  │                      │ │                       │ │
│  │    1100 x 900        │ │    300 x 900          │ │
│  │                      │ │                       │ │
│  └──────────────────────┘ └───────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Main Process (`runelight/src/bun/index.ts`)

**Server readiness** — Waits for both the game engine and gateway before creating windows:

```typescript
await Promise.all([
    waitForServer("Engine", "http://localhost:8888", 30, 1000),
    waitForServer("Gateway", "http://localhost:7780", 30, 1000),
]);
```

**Window creation** — One `BrowserWindow` as the container, two `BrowserView` instances:

```typescript
const mainWindow = new BrowserWindow({
    title: "scAIpe", url: PANEL_URL,
    frame: { width: 1400, height: 900, x: 150, y: 150 },
});

const gameView = new BrowserView({
    url: "http://localhost:8888/bot?bot=dexrunner&password=...&minimal",
    windowId: mainWindow.id,
    frame: { x: 0, y: 0, width: 1100, height: 900 },
    sandbox: true,
});

const panelView = new BrowserView({
    url: PANEL_URL,
    windowId: mainWindow.id,
    frame: { x: 1100, y: 0, width: 300, height: 900 },
});
```

**Application menu** — Keyboard shortcuts for common operations:
- `Cmd+\` — Toggle side panel (resizes window)
- `Cmd+Enter` — Run selected script (POST to gateway)
- `Cmd+.` — Stop running script
- `Cmd+Shift+R` — Reload panel

**System tray** — Background operation with Show/Run/Stop/Quit actions.

### SolidJS Panel (`runelight/src/mainview/App.tsx`)

The panel connects to the gateway as an **observer** (read-only) and displays live game state:

```typescript
ws.send(JSON.stringify({
    type: "sdk_connect",
    username: "dexrunner",
    password: "",
    clientId: `scaipe-${Date.now()}`,
    mode: "observe",  // Read-only, doesn't conflict with script controllers
}));
```

**Tabs**:

| Tab | Content |
|-----|---------|
| Status | Player name, combat level, HP, position, skills with XP |
| Inventory | 28-slot grid with item sprites rendered via game cache ItemViewer |
| Nearby | NPCs (with combat level + distance), objects, ground items |
| Scripts | Script selector dropdown, Run/Stop buttons, live stdout output |

**Reactive updates** — SolidJS signals update the UI whenever a new `sdk_state` message arrives from the gateway WebSocket. No polling — pure push.

**Item sprites** — The `ItemViewer` class loads the game's sprite cache and renders item icons to `<canvas>` elements. This gives authentic game item visuals in the panel. It initializes asynchronously and re-renders all existing canvases once ready.

**Script panel** — Lists scripts from `GET /scripts/:botName`, runs them via `POST /run-script`, polls output from `GET /script-output` every second.

---

## 9. Recreation Guide — Building This for Any Game

### Step 1: Game State Access

You need a way to read game state programmatically. Options:

- **Browser game**: Inject JavaScript to read DOM/canvas state, or intercept WebSocket/HTTP traffic
- **Native game**: Memory reading, packet sniffing, or official API
- **Emulated game**: Hook into emulator's state

Define your `GameState` type — the complete snapshot of what the player can see:

```typescript
interface GameState {
    player: { name: string; hp: number; maxHp: number; x: number; y: number; /* ... */ };
    inventory: { name: string; count: number; slot: number }[];
    nearbyEntities: { name: string; type: string; distance: number; options: string[] }[];
    messages: { text: string; timestamp: number }[];
    // ... everything visible to the player
}
```

### Step 2: Action Protocol

You need a way to send actions to the game:

```typescript
interface GameActions {
    moveTo(x: number, y: number): Promise<void>;
    interact(entityId: string, option: string): Promise<void>;
    useItem(slot: number): Promise<void>;
    // ... every action the player can take
}
```

Key distinction to maintain:
- **Low-level SDK**: Actions resolve when the game server acknowledges the input
- **High-level Actions**: Actions resolve when the visual/logical effect completes

### Step 3: WebSocket Gateway

Build a relay server between game client and scripts:

```
Game Client ──WebSocket──► Gateway ──WebSocket──► Script SDK
                              │
                              ├── Session management (one bot per username)
                              ├── Controller pre-emption (last writer wins)
                              ├── Observer mode (read-only state stream)
                              └── HTTP endpoints for tooling
```

The gateway:
1. Accepts connections from both game clients and script clients
2. Routes state updates from game → scripts
3. Routes actions from scripts → game
4. Tracks connection health (active/stale/dead)
5. Provides HTTP API for script management

### Step 4: Event Engine

Implement the poll-diff-emit pattern:

```typescript
class EventEngine {
    private prev: GameState | null = null;
    private handlers: Map<string, Handler[]> = new Map();

    on(eventType: string, handler: Handler) { /* register */ }

    async start() {
        while (this.running) {
            const state = this.sdk.getState();
            const events = this.diff(state, this.prev);
            for (const event of events) await this.emit(event);
            this.prev = state;
            await sleep(POLL_INTERVAL);
        }
    }

    private diff(curr: GameState, prev: GameState | null): GameEvent[] {
        // Compare every field, emit events for meaningful changes
        // Use hashing for arrays (inventory, nearby entities)
        // Use threshold detection for values (HP dropping below %)
        // Parse game messages for structured events
    }
}
```

**Design your events around what the player would react to**:
- Health danger → eat food, flee
- New enemy → fight or run
- Inventory full → bank, process items
- Skill milestone → change training method
- Movement blocked → find alternate path

### Step 5: TOON Logging

Install `@toon-format/toon` or write a compact encoder. The key principle: **every field name and value costs tokens when fed to an LLM**.

Optimizations:
- Short field names: `lvl` not `level`, `hp` not `hitpoints`
- Filter before encoding: only non-zero skills, closest N entities
- Truncate strings: message text to 100 chars max
- Skip unchanged fields between snapshots

### Step 6: Knowledge Base

Create a directory structure for persistent learnings:

```
learnings/
├── exploration/     ← Auto-generated by state logger
│   ├── events.log   ← Time-series event stream
│   ├── journal.toon ← Session observations
│   └── {category}.toon ← Category-specific logs
├── strategies/      ← Manually curated guides
└── reference/       ← Static game data (wiki, item databases)
```

Wire the event engine to auto-log:
- New areas visited → location survey
- Combat encounters → damage/XP data
- Shops found → prices and stock
- Dangers discovered → aggressive enemies, unsafe zones

### Step 7: Desktop Shell

Use Electrobun (Bun), Electron (Node), or Tauri (Rust) to wrap:

```
┌────────────────────────────────────────┐
│  Game Viewport (BrowserView)  │ Panel  │
│  - Loads game client          │ - Live │
│  - Sandboxed                  │ state  │
│  - Full interaction           │ - Tabs │
│                               │ - Run  │
│                               │ script │
└────────────────────────────────────────┘
```

The panel connects to the gateway as an observer, showing real-time state without interfering with script control.

### Step 8: Script Runner

Build a script harness that handles boilerplate:

```typescript
async function runScript(fn: (ctx: Context) => Promise<any>, options?: RunOptions) {
    // 1. Load credentials from env/config
    // 2. Connect to gateway (or reuse connection)
    // 3. Set up timeout, signal handlers
    // 4. Execute script function
    // 5. Print results and final state
    // 6. Clean up connection
}
```

### Step 9: Planner Layer

Add an AI planner that:
1. Reads the knowledge base and current state
2. Identifies the next best action/goal
3. Writes or configures executor scripts
4. Monitors progress via event logs

The planner runs as a separate process or agent, communicating through the filesystem (goal files, journal entries) or via the gateway.

### Architecture Checklist

```
[ ] Game state type defined
[ ] Action protocol implemented
[ ] WebSocket gateway routing bot ↔ SDK
[ ] Session management (control vs observe)
[ ] BotSDK — low-level action/state protocol
[ ] BotActions — high-level domain helpers
[ ] Event engine — poll, diff, emit
[ ] Event types for your game's key moments
[ ] TOON encoding for compact state representation
[ ] State logger with category-specific files
[ ] Script runner with credential loading & timeouts
[ ] Knowledge base directory structure
[ ] Desktop shell with game viewport + status panel
[ ] Planner integration (AI agent reads/writes knowledge)
```

---

## 10. Annotated Code Examples

### Example 1: Event-Driven Defence Grind

**Source**: `bots/dexrunner/grind-defence.ts`

This script demonstrates the full event-driven pattern: safety handlers + continuous work + progress logging.

```typescript
import { runScript } from '../../sdk/runner';
import { EventEngine } from '../../sdk/event-engine';
import { encode } from '@toon-format/toon';

const TARGET_DEF = 45;
const CHICKEN_AREA = { x: 3237, z: 3295 };
const COOKING_RANGE = { x: 3212, z: 3215 };

await runScript(async ({ bot, sdk }) => {
    const engine = new EventEngine(sdk, bot);

    // Set combat style to Block (trains Defence)
    await sdk.sendSetCombatStyle(3);

    // === SAFETY HANDLERS ===

    // Flee from dangerous enemies (level > 5 means not a chicken)
    engine.on('attacked', async (e, { bot }) => {
        if (e.type !== 'attacked') return;
        if (e.level > 5) {
            console.log(`DANGER — ${e.by} Lvl ${e.level}, running!`);
            await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
        }
    });

    // Eat food when HP drops below 30%
    engine.on('low_hp', async (e, { bot, sdk }) => {
        if (e.type !== 'low_hp') return;
        const food = sdk.findInventoryItem(/cooked chicken|bread|shrimp/i);
        if (food) await bot.eatFood(food);
    });

    // === STATE TRANSITIONS ===

    // When inventory fills up, cook raw chicken then return
    engine.on('inventory_full', async (e, { bot, sdk }) => {
        await bot.walkTo(COOKING_RANGE.x, COOKING_RANGE.z);
        for (let i = 0; i < 28; i++) {
            const raw = sdk.findInventoryItem(/^raw chicken$/i);
            if (!raw) break;
            const range = sdk.findNearbyLoc(/^cooking range$/i);
            if (!range) break;
            await bot.useItemOnLoc(raw, range);
        }
        await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
    });

    // Stop when goal is reached
    engine.on('level_up', async (e) => {
        if (e.type !== 'level_up') return;
        if (e.skill === 'Defence' && e.level >= TARGET_DEF) {
            console.log(`TARGET REACHED! Defence ${e.level}`);
            engine.stop();
        }
    });

    // === MAIN TICK: Grind Loop ===

    engine.on('tick', async (e, { bot, sdk }) => {
        if (e.type !== 'tick') return;
        const s = e.state;
        if (!s.player || s.player.combat.inCombat) return;

        // Priority 1: Loot raw chicken
        const rawGround = sdk.findGroundItem(/^raw chicken$/i);
        if (rawGround && rawGround.distance < 4 && s.inventory.length < 27) {
            await bot.pickupItem(rawGround);
            return;
        }

        // Priority 2: Loot and bury bones (Prayer XP)
        const bones = sdk.findGroundItem(/^bones$/i);
        if (bones && bones.distance < 3 && s.inventory.length < 28) {
            await bot.pickupItem(bones);
            const bone = sdk.findInventoryItem(/^bones$/i);
            if (bone) await sdk.sendUseItem(bone.slot);
            return;
        }

        // Priority 3: Attack nearest chicken (low-level for speed)
        const chicken = sdk.findNearbyNpc(/^chicken$/i);
        if (chicken) {
            const opt = chicken.optionsWithIndex?.find(o => /attack/i.test(o.text));
            if (opt) {
                await sdk.sendInteractNpc(chicken.index, opt.opIndex);
                await sdk.waitForTicks(2);
            }
        }
    });

    // === PROGRESS LOGGING (TOON-encoded) ===

    const startDef = sdk.getSkillXp('defence') ?? 0;
    const startTime = Date.now();
    let lastLog = 0;

    engine.on('tick', async () => {
        const now = Date.now();
        if (now - lastLog < 30_000) return;
        lastLog = now;

        const defXp = (sdk.getSkillXp('defence') ?? 0) - startDef;
        const elapsed = ((now - startTime) / 60_000).toFixed(1);
        const defLvl = sdk.getSkill('defence')?.level ?? 1;

        // TOON-encoded progress report
        console.log(encode({
            progress: { min: elapsed, def: `${defLvl}(+${defXp}xp)` }
        }));
    });

    // === START ===
    await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
    await engine.start();  // Blocks here until engine.stop()

}, { timeout: 60 * 60_000 });  // 1 hour safety timeout
```

**Key patterns to note**:
- Multiple handlers for the same event type (`tick` has both grind logic and progress logging)
- Low-level `sdk.sendInteractNpc` used instead of `bot.attackNpc` for speed on trivial targets
- TOON encoding used for progress output — keeps logs compact
- Safety handlers (flee, eat) registered first but fire based on events, not polling order

### Example 2: Minimal Event Engine for a New Game

```typescript
// Adapting the pattern for a hypothetical RPG

type RPGEvent =
    | { type: 'health_low'; hp: number; maxHp: number }
    | { type: 'enemy_nearby'; name: string; level: number; distance: number }
    | { type: 'loot_dropped'; items: string[] }
    | { type: 'quest_update'; quest: string; step: string }
    | { type: 'tick'; state: RPGState };

class RPGEventEngine {
    private prev: RPGState | null = null;
    private handlers = new Map<string, ((e: RPGEvent) => Promise<void>)[]>();

    on(type: string, handler: (e: RPGEvent) => Promise<void>) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type)!.push(handler);
    }

    async start() {
        while (true) {
            const state = await this.getGameState();
            const events = this.diff(state);
            for (const e of events) {
                for (const h of this.handlers.get(e.type) ?? []) await h(e);
                for (const h of this.handlers.get('*') ?? []) await h(e);
            }
            this.prev = state;
            await sleep(500);
        }
    }

    private diff(state: RPGState): RPGEvent[] {
        const events: RPGEvent[] = [];

        // Health threshold crossing
        if (this.prev && state.hp < state.maxHp * 0.25
            && this.prev.hp >= state.maxHp * 0.25) {
            events.push({ type: 'health_low', hp: state.hp, maxHp: state.maxHp });
        }

        // New enemy appeared nearby
        for (const enemy of state.nearbyEnemies) {
            const wasThere = this.prev?.nearbyEnemies.find(e => e.id === enemy.id);
            if (!wasThere && enemy.distance < 5) {
                events.push({
                    type: 'enemy_nearby',
                    name: enemy.name, level: enemy.level, distance: enemy.distance
                });
            }
        }

        events.push({ type: 'tick', state });
        return events;
    }
}
```

---

## Appendix: File Reference

| File | Layer | Purpose |
|------|-------|---------|
| `sdk/index.ts` | L1 SDK | WebSocket protocol, action dispatch, state management |
| `sdk/actions.ts` | L1 SDK | High-level game actions with pathfinding and wait-for-effect |
| `sdk/types.ts` | L1 SDK | TypeScript types for all game state and actions |
| `sdk/pathfinding.ts` | L1 SDK | Local collision-based pathfinding with door handling |
| `sdk/runner.ts` | L1 SDK | Zero-boilerplate script execution harness |
| `sdk/event-engine.ts` | L2 Executor | Poll-diff-emit event engine |
| `sdk/state-logger.ts` | L2 Executor | TOON encoding and category logging |
| `sdk/formatter.ts` | L2 Executor | Human-readable state formatting for CLI |
| `sdk/cli.ts` | Tool | CLI for checking bot world state |
| `server/gateway/gateway.ts` | Infra | WebSocket router, session management, script runner API |
| `runelight/src/bun/index.ts` | Desktop | Electrobun main process, window/view layout |
| `runelight/src/mainview/App.tsx` | Desktop | SolidJS reactive panel with tabs |
| `bots/{name}/script.ts` | Scripts | Bot task scripts |
| `bots/create-bot.ts` | Tool | Bot account creation |
| `learnings/exploration/` | Knowledge | Auto-generated TOON logs |
| `wiki/` | Knowledge | Static game reference data |
