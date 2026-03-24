// Event-driven game engine — watches state changes, emits events, logs in TOON + SpacetimeDB
import { encode } from '@toon-format/toon';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import type { BotWorldState } from './types';
import type { BotSDK } from './index';
import type { BotActions } from './actions';
import type { SpacetimeConnector } from './spacetime-connector';

// ============ Types ============

type GameEvent =
    | { type: 'attacked'; by: string; level: number }
    | { type: 'combat_end'; killed?: string; hpLost: number }
    | { type: 'low_hp'; hp: number; maxHp: number; pct: number }
    | { type: 'level_up'; skill: string; level: number; xp: number }
    | { type: 'inventory_full' }
    | { type: 'inventory_change'; added: string[]; removed: string[] }
    | { type: 'new_message'; text: string; msgType: number }
    | { type: 'stunned' }
    | { type: 'cant_reach' }
    | { type: 'died' }
    | { type: 'position_change'; from: { x: number; z: number }; to: { x: number; z: number } }
    | { type: 'idle' }
    | { type: 'tick'; state: BotWorldState };

type EventHandler = (event: GameEvent, ctx: EventContext) => void | Promise<void>;

interface EventContext {
    bot: BotActions;
    sdk: BotSDK;
    engine: EventEngine;
}

// A hook captures full context and journals it with reasoning
interface ContextHook {
    /** Which events trigger this hook */
    triggers: string[];
    /** Capture context when triggered — returns a journal entry */
    capture: (event: GameEvent, state: BotWorldState, prev: BotWorldState | null) => string | null;
}

// ============ TOON Logger ============

const LOG_DIR = `${import.meta.dir}/../learnings/exploration`;

function ensureDir() {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function logEvent(event: GameEvent) {
    if (event.type === 'tick' || event.type === 'idle') return;
    ensureDir();
    const ts = new Date().toISOString().slice(0, 19);
    const line = `${ts} | ${event.type} | ${JSON.stringify(event).slice(0, 200)}\n`;
    appendFileSync(`${LOG_DIR}/events.log`, line);
}

function journalEntry(entry: string) {
    ensureDir();
    const ts = new Date().toISOString().slice(0, 19);
    appendFileSync(`${LOG_DIR}/journal.toon`, `\n# ${ts}\n${entry}\n`);
}

// ============ Built-in Context Hooks ============

const BUILT_IN_HOOKS: ContextHook[] = [
    {
        // When attacked — log who, where, what's around, was it expected?
        triggers: ['attacked'],
        capture: (event, state, prev) => {
            if (event.type !== 'attacked') return null;
            const p = state.player!;
            const nearbyThreats = state.nearbyNpcs
                .filter(n => n.combatLevel > 0 && n.distance < 10)
                .map(n => `${n.name} Lvl${n.combatLevel} ${n.distance}t`);
            return encode({
                interaction: {
                    type: 'attacked',
                    by: event.by,
                    byLevel: event.level,
                    myHp: `${p.hp}/${p.maxHp}`,
                    myPos: `${p.worldX},${p.worldZ}`,
                    myDefence: state.skills.find(s => s.name === 'Defence')?.level ?? 0,
                    nearbyThreats,
                    hadFood: state.inventory.some(i => /chicken|bread|shrimp|trout|meat/i.test(i.name)),
                    context: event.level > 5 ? 'UNEXPECTED DANGER — remember this location' : 'expected training mob'
                }
            });
        }
    },
    {
        // When can't reach — log what we were trying to do, what's blocking
        triggers: ['cant_reach'],
        capture: (event, state) => {
            const p = state.player!;
            const nearbyDoors = state.nearbyLocs
                .filter(l => /gate|door/i.test(l.name) && l.distance < 5)
                .map(l => `${l.name} at (${l.x},${l.z}) ${l.distance}t [${l.optionsWithIndex?.map(o => o.text).join('/')}]`);
            return encode({
                interaction: {
                    type: 'cant_reach',
                    myPos: `${p.worldX},${p.worldZ}`,
                    nearbyDoors,
                    possibleFix: nearbyDoors.length > 0 ? 'Try opening a gate/door first' : 'Reposition — obstacle or bad pathing',
                    nearbyNpcs: state.nearbyNpcs.slice(0, 3).map(n => `${n.name} ${n.distance}t`),
                }
            });
        }
    },
    {
        // When stunned — log what we were doing (pickpocketing?) and the consequences
        triggers: ['stunned'],
        capture: (event, state) => {
            const p = state.player!;
            return encode({
                interaction: {
                    type: 'stunned',
                    myPos: `${p.worldX},${p.worldZ}`,
                    hp: `${p.hp}/${p.maxHp}`,
                    inCombat: p.combat.inCombat,
                    lesson: 'Failed pickpocket or similar — got stunned and possibly attacked. Avoid at low Thieving.'
                }
            });
        }
    },
    {
        // When low HP — log full survival context
        triggers: ['low_hp'],
        capture: (event, state) => {
            if (event.type !== 'low_hp') return null;
            const food = state.inventory.filter(i =>
                /chicken|bread|shrimp|trout|meat|cake|pie|lobster/i.test(i.name)
            );
            const threats = state.nearbyNpcs.filter(n => n.combatLevel > 0 && n.distance < 8);
            return encode({
                interaction: {
                    type: 'low_hp',
                    hp: `${event.hp}/${event.maxHp} (${event.pct}%)`,
                    myPos: `${state.player!.worldX},${state.player!.worldZ}`,
                    foodAvailable: food.map(f => `${f.name} x${f.count}`),
                    threats: threats.map(n => `${n.name} Lvl${n.combatLevel} ${n.distance}t`),
                    action: food.length > 0 ? 'EAT FOOD NOW' : 'NO FOOD — FLEE TO SAFETY',
                }
            });
        }
    },
    {
        // Level up — log the achievement and check if a target was hit
        triggers: ['level_up'],
        capture: (event, state) => {
            if (event.type !== 'level_up') return null;
            const targets: Record<string, number> = {
                Defence: 45, Attack: 60, Strength: 99, Prayer: 55, Ranged: 99, Magic: 99
            };
            const target = targets[event.skill];
            const progress = target ? `${event.level}/${target} (${Math.round(event.level/target*100)}%)` : `${event.level}`;
            return encode({
                interaction: {
                    type: 'level_up',
                    skill: event.skill,
                    level: event.level,
                    xp: event.xp,
                    targetProgress: progress,
                    reachedTarget: target ? event.level >= target : false,
                }
            });
        }
    },
    {
        // Inventory full — what's in there, what should we do
        triggers: ['inventory_full'],
        capture: (event, state) => {
            const inv = state.inventory;
            const summary: Record<string, number> = {};
            for (const i of inv) {
                summary[i.name] = (summary[i.name] || 0) + i.count;
            }
            const hasRaw = inv.some(i => /^raw /i.test(i.name));
            const hasJunk = inv.some(i => /feather|bucket|pot/i.test(i.name));
            return encode({
                interaction: {
                    type: 'inventory_full',
                    items: summary,
                    action: hasRaw ? 'GO COOK raw food' : hasJunk ? 'DROP junk items' : 'BANK or DROP lowest value',
                    nearestBank: 'Varrock West (3185,3436) or Draynor (3092,3243 — danger!)',
                    nearestRange: 'Lumbridge (3212,3215)',
                }
            });
        }
    },
    {
        // Died — critical! Log everything
        triggers: ['died'],
        capture: (event, state, prev) => {
            const p = prev?.player;
            return encode({
                interaction: {
                    type: 'DIED',
                    lastKnownPos: p ? `${p.worldX},${p.worldZ}` : 'unknown',
                    lastHp: p ? `${p.hp}/${p.maxHp}` : 'unknown',
                    wasInCombat: p?.combat?.inCombat ?? false,
                    nearbyThreats: (prev?.nearbyNpcs ?? []).filter(n => n.combatLevel > 0 && n.distance < 5).map(n => `${n.name} Lvl${n.combatLevel}`),
                    lesson: 'REMEMBER THIS LOCATION AND THREAT — add to dangers.toon',
                }
            });
        }
    },
    {
        // Combat end — track efficiency
        triggers: ['combat_end'],
        capture: (event, state) => {
            if (event.type !== 'combat_end') return null;
            // Only journal if we took significant damage
            if (event.hpLost <= 0) return null;
            return encode({
                interaction: {
                    type: 'combat_end',
                    hpLost: event.hpLost,
                    currentHp: `${state.player!.hp}/${state.player!.maxHp}`,
                    note: event.hpLost > state.player!.maxHp * 0.3 ? 'HEAVY DAMAGE — consider safer target or bring food' : 'moderate damage',
                }
            });
        }
    },
];


// ============ Event Engine ============

export class EventEngine {
    private sdk: BotSDK;
    private bot: BotActions;
    private stdb: SpacetimeConnector | null = null;
    private handlers: Map<string, EventHandler[]> = new Map();
    private hooks: ContextHook[] = [...BUILT_IN_HOOKS];
    private prev: BotWorldState | null = null;
    private running = false;
    private pollInterval = 600; // ms between state checks
    private prevInvHash = '';
    private prevSkillHash = '';
    private prevMsgTick = 0;
    private currentTask: string = 'idle';
    private stateLogCounter = 0;

    constructor(sdk: BotSDK, bot: BotActions) {
        this.sdk = sdk;
        this.bot = bot;
    }

    /** Attach SpacetimeDB for persistent shared memory */
    attachSpacetime(connector: SpacetimeConnector) {
        this.stdb = connector;
        return this;
    }

    /** Add a custom context hook */
    addHook(hook: ContextHook) {
        this.hooks.push(hook);
        return this;
    }

    /** Register a handler for an event type. Use '*' for all events. */
    on(type: string, handler: EventHandler) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type)!.push(handler);
        return this;
    }

    /** Set what task we're currently doing (for logging context) */
    setTask(task: string) {
        this.currentTask = task;
    }

    /** Start the event loop */
    async start() {
        this.running = true;
        console.log('[EventEngine] Started');

        while (this.running) {
            const state = this.sdk.getState();
            if (!state?.player) {
                await Bun.sleep(this.pollInterval);
                continue;
            }

            const events = this.diff(state);

            for (const event of events) {
                logEvent(event);
                await this.emit(event);
            }

            // Log state to SpacetimeDB every 5 ticks (~3 seconds)
            this.stateLogCounter++;
            if (this.stdb && this.stateLogCounter % 5 === 0) {
                try { this.stdb.logState(state); } catch {}
            }

            this.prev = state;
            await Bun.sleep(this.pollInterval);
        }

        console.log('[EventEngine] Stopped');
    }

    stop() {
        this.running = false;
    }

    private async emit(event: GameEvent) {
        const ctx: EventContext = { bot: this.bot, sdk: this.sdk, engine: this };

        // Specific handlers
        const specific = this.handlers.get(event.type) ?? [];
        for (const h of specific) {
            try { await h(event, ctx); } catch (e) { console.error(`[EventEngine] Handler error:`, e); }
        }

        // Wildcard handlers
        const wild = this.handlers.get('*') ?? [];
        for (const h of wild) {
            try { await h(event, ctx); } catch (e) { console.error(`[EventEngine] Wildcard error:`, e); }
        }

        // Context hooks — capture and journal interactions
        const state = this.sdk.getState();
        if (state) {
            for (const hook of this.hooks) {
                if (hook.triggers.includes(event.type) || hook.triggers.includes('*')) {
                    try {
                        const entry = hook.capture(event, state, this.prev);
                        if (entry) journalEntry(entry);
                    } catch (e) {
                        console.error(`[EventEngine] Hook error:`, e);
                    }
                }
            }
        }

        // Write significant events to SpacetimeDB (skip ticks and idle)
        if (this.stdb && event.type !== 'tick' && event.type !== 'idle') {
            try {
                const tick = state?.tick ?? 0;
                const eventData: Record<string, any> = { ...event };
                delete (eventData as any).type;
                this.stdb.logEvent(tick, event.type, eventData);
            } catch {}
        }
    }

    /** Diff current state against previous, return events */
    private diff(state: BotWorldState): GameEvent[] {
        const events: GameEvent[] = [];
        const p = state.player!;
        const prev = this.prev;

        // --- COMBAT ---
        if (p.combat.inCombat && (!prev?.player?.combat.inCombat)) {
            // Just entered combat — who's attacking us?
            const nearbyAggro = state.nearbyNpcs.find(n => n.combatLevel > 0 && n.distance < 2);
            if (nearbyAggro) {
                events.push({ type: 'attacked', by: nearbyAggro.name, level: nearbyAggro.combatLevel });
            }
        }

        if (!p.combat.inCombat && prev?.player?.combat.inCombat) {
            const hpLost = (prev.player.hp) - p.hp;
            events.push({ type: 'combat_end', hpLost });
        }

        // --- HP ---
        if (prev?.player && p.hp < p.maxHp * 0.3 && prev.player.hp >= p.maxHp * 0.3) {
            events.push({ type: 'low_hp', hp: p.hp, maxHp: p.maxHp, pct: Math.round(p.hp / p.maxHp * 100) });
        }

        if (p.hp <= 0 && (prev?.player?.hp ?? 1) > 0) {
            events.push({ type: 'died' });
        }

        // --- MESSAGES ---
        for (const msg of state.gameMessages) {
            if (msg.tick <= this.prevMsgTick) continue;
            this.prevMsgTick = msg.tick;

            if (/stunned/i.test(msg.text)) {
                events.push({ type: 'stunned' });
            } else if (/can't reach/i.test(msg.text)) {
                events.push({ type: 'cant_reach' });
            } else if (/advanced a/i.test(msg.text)) {
                // Level up! Parse skill name
                const match = msg.text.match(/advanced (?:a |an )?(\w+) level/i);
                if (match) {
                    const skillName = match[1];
                    const skill = state.skills.find(s => s.name.toLowerCase() === skillName.toLowerCase());
                    if (skill) {
                        events.push({ type: 'level_up', skill: skill.name, level: skill.level, xp: skill.experience });
                    }
                }
            } else {
                events.push({ type: 'new_message', text: msg.text, msgType: msg.type });
            }
        }

        // --- INVENTORY ---
        const invHash = state.inventory.map(i => `${i.name}:${i.count}`).sort().join('|');
        if (invHash !== this.prevInvHash) {
            if (this.prevInvHash) {
                const prevItems = new Set(this.prevInvHash.split('|'));
                const currItems = new Set(invHash.split('|'));
                const added = [...currItems].filter(x => !prevItems.has(x)).map(x => x.split(':')[0]);
                const removed = [...prevItems].filter(x => !currItems.has(x)).map(x => x.split(':')[0]);
                if (added.length || removed.length) {
                    events.push({ type: 'inventory_change', added, removed });
                }
            }
            this.prevInvHash = invHash;
        }

        if (state.inventory.length >= 28 && (prev?.inventory?.length ?? 0) < 28) {
            events.push({ type: 'inventory_full' });
        }

        // --- SKILLS ---
        const skillHash = state.skills.map(s => `${s.name}:${s.level}`).join('|');
        if (skillHash !== this.prevSkillHash) {
            this.prevSkillHash = skillHash;
        }

        // --- TICK (always, for task processing) ---
        events.push({ type: 'tick', state });

        return events;
    }
}
