// Agent - Claude AI integration for autonomous bot control
// Connects to gateway WS in control mode, receives state, calls Claude, executes actions

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { BotWorldState, BotAction, ActionResult } from '../../sdk/types';

// ============ API Key Persistence ============

const KEY_DIR = join(process.env.HOME || '', '.scaipe');
const KEY_FILE = join(KEY_DIR, 'credentials.json');

function loadSavedApiKey(): string {
    try {
        if (existsSync(KEY_FILE)) {
            const data = JSON.parse(readFileSync(KEY_FILE, 'utf-8'));
            return data.apiKey || '';
        }
    } catch {}
    return '';
}

function saveApiKey(apiKey: string): void {
    try {
        if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true });
        writeFileSync(KEY_FILE, JSON.stringify({ apiKey }, null, 2));
        console.log(`[Agent] API key saved to ${KEY_FILE}`);
    } catch (e) {
        console.warn('[Agent] Failed to save API key:', e);
    }
}

// ============ Types ============

interface AgentConfig {
    botName: string;
    apiKey: string;
    model?: string;
    goal?: string;
    gatewayPort?: number;
}

interface AgentEvent {
    type: 'thinking' | 'action' | 'action_result' | 'narration' | 'error' | 'status';
    timestamp: number;
    data: any;
}

interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string | Anthropic.Messages.ContentBlock[];
}

// ============ Game Knowledge ============

const GAME_KNOWLEDGE = `## Combat Tips
- Cow field at (3253,3290), gate at (3253,3270). Open gate before entering.
- Chickens at (3237,3295) - safe, drop feathers.
- Al Kharid warriors (3293,3175) lvl 9 - faster XP, kebabs nearby.
- Combat styles: 0=Attack, 1=Strength, 3=Defence. Train lowest stat.
- Always wrap attacks in error handling - timeouts are common in crowded areas.
- Check combat state: state.player.combat.inCombat
- Use scanGroundItems for dropped loot, NOT nearbyLocs.
- Limit pickups to 3 per loop, then resume combat.

## Banking Tips
- NO bank in Lumbridge. Nearest: Draynor (3092,3243), Al Kharid (3269,3167), Varrock West (3185,3436).
- Open bank with interactNpc on banker/booth, option "Bank".
- Deposit: bankDeposit with slot and amount (-1 = all).
- Withdraw: bankWithdraw with bank slot and count.
- Close bank with closeModal before walking away.
- Gate at cow field: open before walking through (z < 3268 threshold).`;

// ============ Tool Definitions ============

const TOOLS: Anthropic.Messages.Tool[] = [
    {
        name: 'walk_to',
        description: 'Walk to coordinates. Use for navigation.',
        input_schema: {
            type: 'object' as const,
            properties: {
                x: { type: 'number', description: 'World X coordinate' },
                z: { type: 'number', description: 'World Z coordinate' },
                running: { type: 'boolean', description: 'Run instead of walk' }
            },
            required: ['x', 'z']
        }
    },
    {
        name: 'interact_npc',
        description: 'Interact with a nearby NPC by index and option. Options include Attack, Talk-to, Trade, Pickpocket, etc.',
        input_schema: {
            type: 'object' as const,
            properties: {
                npc_index: { type: 'number', description: 'NPC index from nearby NPCs list' },
                option_index: { type: 'number', description: 'Option index (from NPC options list)' }
            },
            required: ['npc_index', 'option_index']
        }
    },
    {
        name: 'talk_to_npc',
        description: 'Talk to a nearby NPC. Walks to them and starts dialog.',
        input_schema: {
            type: 'object' as const,
            properties: {
                npc_index: { type: 'number', description: 'NPC index from nearby NPCs list' }
            },
            required: ['npc_index']
        }
    },
    {
        name: 'interact_loc',
        description: 'Interact with a nearby location/object (tree, rock, door, gate, furnace, etc.) by coordinates, ID, and option.',
        input_schema: {
            type: 'object' as const,
            properties: {
                x: { type: 'number', description: 'Object world X' },
                z: { type: 'number', description: 'Object world Z' },
                loc_id: { type: 'number', description: 'Object/location ID' },
                option_index: { type: 'number', description: 'Option index (e.g. 0=Chop, 1=Examine)' }
            },
            required: ['x', 'z', 'loc_id', 'option_index']
        }
    },
    {
        name: 'pickup_item',
        description: 'Pick up a ground item by coordinates and item ID.',
        input_schema: {
            type: 'object' as const,
            properties: {
                x: { type: 'number', description: 'Item world X' },
                z: { type: 'number', description: 'Item world Z' },
                item_id: { type: 'number', description: 'Item ID' }
            },
            required: ['x', 'z', 'item_id']
        }
    },
    {
        name: 'use_inventory_item',
        description: 'Use an inventory item (eat food, bury bones, read, etc.).',
        input_schema: {
            type: 'object' as const,
            properties: {
                slot: { type: 'number', description: 'Inventory slot (0-27)' },
                option_index: { type: 'number', description: 'Option index (0=first option like Eat/Bury/Wield)' }
            },
            required: ['slot', 'option_index']
        }
    },
    {
        name: 'drop_item',
        description: 'Drop an inventory item.',
        input_schema: {
            type: 'object' as const,
            properties: {
                slot: { type: 'number', description: 'Inventory slot (0-27)' }
            },
            required: ['slot']
        }
    },
    {
        name: 'say_in_chat',
        description: 'Say a message in game chat. Keep under 100 characters.',
        input_schema: {
            type: 'object' as const,
            properties: {
                message: { type: 'string', description: 'Chat message (max 100 chars)' }
            },
            required: ['message']
        }
    },
    {
        name: 'click_dialog_option',
        description: 'Click a dialog option when a dialog/conversation is open.',
        input_schema: {
            type: 'object' as const,
            properties: {
                option_index: { type: 'number', description: 'Dialog option index' }
            },
            required: ['option_index']
        }
    },
    {
        name: 'bank_deposit',
        description: 'Deposit an inventory item into the bank (bank must be open).',
        input_schema: {
            type: 'object' as const,
            properties: {
                slot: { type: 'number', description: 'Inventory slot' },
                amount: { type: 'number', description: 'Amount to deposit (-1 for all)' }
            },
            required: ['slot', 'amount']
        }
    },
    {
        name: 'bank_withdraw',
        description: 'Withdraw an item from the bank (bank must be open).',
        input_schema: {
            type: 'object' as const,
            properties: {
                slot: { type: 'number', description: 'Bank slot' },
                amount: { type: 'number', description: 'Amount to withdraw (-1 for all)' }
            },
            required: ['slot', 'amount']
        }
    },
    {
        name: 'use_item_on_item',
        description: 'Use one inventory item on another (e.g. knife on logs, needle on leather).',
        input_schema: {
            type: 'object' as const,
            properties: {
                source_slot: { type: 'number', description: 'Source inventory slot' },
                target_slot: { type: 'number', description: 'Target inventory slot' }
            },
            required: ['source_slot', 'target_slot']
        }
    },
    {
        name: 'use_item_on_loc',
        description: 'Use an inventory item on a world object (e.g. ore on furnace, fish on range).',
        input_schema: {
            type: 'object' as const,
            properties: {
                item_slot: { type: 'number', description: 'Inventory slot of item' },
                x: { type: 'number', description: 'Object world X' },
                z: { type: 'number', description: 'Object world Z' },
                loc_id: { type: 'number', description: 'Object/location ID' }
            },
            required: ['item_slot', 'x', 'z', 'loc_id']
        }
    },
    {
        name: 'use_item_on_npc',
        description: 'Use an inventory item on an NPC.',
        input_schema: {
            type: 'object' as const,
            properties: {
                item_slot: { type: 'number', description: 'Inventory slot of item' },
                npc_index: { type: 'number', description: 'NPC index' }
            },
            required: ['item_slot', 'npc_index']
        }
    },
    {
        name: 'spell_on_npc',
        description: 'Cast a combat spell on an NPC.',
        input_schema: {
            type: 'object' as const,
            properties: {
                npc_index: { type: 'number', description: 'NPC index' },
                spell_component: { type: 'number', description: 'Spell component ID' }
            },
            required: ['npc_index', 'spell_component']
        }
    },
    {
        name: 'set_combat_style',
        description: 'Set combat style. 0=Attack, 1=Strength, 3=Defence.',
        input_schema: {
            type: 'object' as const,
            properties: {
                style: { type: 'number', description: 'Combat style index (0-3)' }
            },
            required: ['style']
        }
    },
    {
        name: 'wait',
        description: 'Wait for a number of game ticks (~600ms each). Use when waiting for combat, fishing, etc.',
        input_schema: {
            type: 'object' as const,
            properties: {
                ticks: { type: 'number', description: 'Number of ticks to wait (default 1)' }
            },
            required: []
        }
    },
    {
        name: 'close_modal',
        description: 'Close any open modal interface (bank, shop, level-up dialog, etc.).',
        input_schema: {
            type: 'object' as const,
            properties: {},
            required: []
        }
    },
    {
        name: 'scan_nearby_locs',
        description: 'Scan for objects/locations in a wider radius than normally visible.',
        input_schema: {
            type: 'object' as const,
            properties: {
                radius: { type: 'number', description: 'Scan radius (default: extended)' }
            },
            required: []
        }
    },
    {
        name: 'scan_ground_items',
        description: 'Scan for ground items (drops) in the area. Use this instead of nearbyLocs for drops.',
        input_schema: {
            type: 'object' as const,
            properties: {
                radius: { type: 'number', description: 'Scan radius' }
            },
            required: []
        }
    },
    {
        name: 'toggle_prayer',
        description: 'Toggle a prayer on/off.',
        input_schema: {
            type: 'object' as const,
            properties: {
                prayer_index: { type: 'number', description: 'Prayer index (0-14)' }
            },
            required: ['prayer_index']
        }
    },
    {
        name: 'shop_buy',
        description: 'Buy an item from an open shop.',
        input_schema: {
            type: 'object' as const,
            properties: {
                slot: { type: 'number', description: 'Shop slot' },
                amount: { type: 'number', description: 'Amount to buy' }
            },
            required: ['slot', 'amount']
        }
    },
    {
        name: 'shop_sell',
        description: 'Sell an inventory item to an open shop.',
        input_schema: {
            type: 'object' as const,
            properties: {
                slot: { type: 'number', description: 'Inventory slot' },
                amount: { type: 'number', description: 'Amount to sell' }
            },
            required: ['slot', 'amount']
        }
    },
    {
        name: 'close_shop',
        description: 'Close the shop interface.',
        input_schema: {
            type: 'object' as const,
            properties: {},
            required: []
        }
    },
    {
        name: 'equip_item',
        description: 'Equip an item from inventory (use option index for Wield/Wear).',
        input_schema: {
            type: 'object' as const,
            properties: {
                slot: { type: 'number', description: 'Inventory slot' },
                option_index: { type: 'number', description: 'Option index (usually 1 for Wield/Wear)' }
            },
            required: ['slot', 'option_index']
        }
    }
];

// ============ State Summarizer ============

function summarizeState(state: BotWorldState): string {
    const lines: string[] = [];

    // Player info
    const p = state.player;
    if (p) {
        lines.push(`Player: ${p.name} | Combat: ${p.combatLevel} | HP: ${p.hp}/${p.maxHp} | Pos: (${p.worldX}, ${p.worldZ}) | Plane: ${p.level} | Run: ${p.runEnergy}%`);
        if (p.combat.inCombat) lines.push(`In combat: targeting index ${p.combat.targetIndex}`);
    }

    // Skills (non-zero, non-default)
    const skills = state.skills.filter(s => s.baseLevel > 1 || s.experience > 0);
    if (skills.length > 0) {
        const skillStr = skills.map(s => `${s.name}:${s.baseLevel}`).join(', ');
        lines.push(`Skills: ${skillStr}`);
    }

    // Inventory
    if (state.inventory.length > 0) {
        const items = state.inventory.map(i => i.count > 1 ? `${i.name}x${i.count}` : i.name);
        lines.push(`Inventory (${state.inventory.length}/28): ${items.join(', ')}`);
    } else {
        lines.push('Inventory: empty');
    }

    // Equipment
    if (state.equipment.length > 0) {
        const equip = state.equipment.map(i => i.name);
        lines.push(`Equipment: ${equip.join(', ')}`);
    }

    // Nearby NPCs (top 5)
    const npcs = state.nearbyNpcs.slice(0, 5);
    if (npcs.length > 0) {
        lines.push('Nearby NPCs:');
        for (const n of npcs) {
            const opts = n.options.join('/');
            const combat = n.inCombat ? ' [in combat]' : '';
            lines.push(`  - ${n.name} (lvl ${n.combatLevel}, idx=${n.index}, dist=${n.distance.toFixed(0)}, hp=${n.hp}/${n.maxHp}${combat}) [${opts}]`);
        }
    }

    // Nearby objects (top 5)
    const locs = state.nearbyLocs.slice(0, 5);
    if (locs.length > 0) {
        lines.push('Nearby objects:');
        for (const l of locs) {
            const opts = l.options.join('/');
            lines.push(`  - ${l.name} (id=${l.id}, pos=(${l.x},${l.z}), dist=${l.distance.toFixed(0)}) [${opts}]`);
        }
    }

    // Ground items (top 5)
    const ground = state.groundItems.slice(0, 5);
    if (ground.length > 0) {
        lines.push('Ground items:');
        for (const g of ground) {
            lines.push(`  - ${g.name}${g.count > 1 ? 'x' + g.count : ''} (id=${g.id}, pos=(${g.x},${g.z}), dist=${g.distance.toFixed(0)})`);
        }
    }

    // Game messages (recent, type 2 = player chat)
    const msgs = state.gameMessages.slice(-5);
    if (msgs.length > 0) {
        lines.push('Recent messages:');
        for (const m of msgs) {
            const prefix = m.type === 2 ? `[${m.sender}]: ` : '';
            lines.push(`  ${prefix}${m.text}`);
        }
    }

    // Dialog
    if (state.dialog.isOpen) {
        lines.push(`Dialog open: ${state.dialog.text || ''}`);
        if (state.dialog.options.length > 0) {
            lines.push('Dialog options: ' + state.dialog.options.map(o => `${o.index}: ${o.text}`).join(', '));
        }
        if (state.dialog.isWaiting) lines.push('(Click to continue)');
    }

    // Bank
    if (state.bank.isOpen) {
        const bankItems = state.bank.items.slice(0, 10);
        lines.push(`Bank open (${state.bank.items.length} items): ${bankItems.map(i => `${i.name}x${i.count}`).join(', ')}${state.bank.items.length > 10 ? '...' : ''}`);
    }

    // Shop
    if (state.shop.isOpen) {
        const shopItems = state.shop.shopItems.slice(0, 8);
        lines.push(`Shop "${state.shop.title}": ${shopItems.map(i => `${i.name}x${i.count}@${i.buyPrice}gp`).join(', ')}`);
    }

    // Combat events
    if (state.combatEvents.length > 0) {
        const recent = state.combatEvents.slice(-3);
        lines.push('Combat events: ' + recent.map(e => `${e.type} dmg=${e.damage}`).join(', '));
    }

    // Prayer
    const activePrayers = state.prayers.activePrayers
        .map((active, i) => active ? i : -1)
        .filter(i => i >= 0);
    if (activePrayers.length > 0) {
        lines.push(`Active prayers: [${activePrayers.join(',')}] Points: ${state.prayers.prayerPoints}/${state.prayers.prayerLevel}`);
    }

    return lines.join('\n');
}

// ============ Tool Call → BotAction Mapping ============

function toolCallToAction(toolName: string, input: any): BotAction {
    const reason = 'Agent';

    switch (toolName) {
        case 'walk_to':
            return { type: 'walkTo', x: input.x, z: input.z, running: input.running, reason };
        case 'interact_npc':
            return { type: 'interactNpc', npcIndex: input.npc_index, optionIndex: input.option_index, reason };
        case 'talk_to_npc':
            return { type: 'talkToNpc', npcIndex: input.npc_index, reason };
        case 'interact_loc':
            return { type: 'interactLoc', x: input.x, z: input.z, locId: input.loc_id, optionIndex: input.option_index, reason };
        case 'pickup_item':
            return { type: 'pickupItem', x: input.x, z: input.z, itemId: input.item_id, reason };
        case 'use_inventory_item':
        case 'equip_item':
            return { type: 'useInventoryItem', slot: input.slot, optionIndex: input.option_index, reason };
        case 'drop_item':
            return { type: 'dropItem', slot: input.slot, reason };
        case 'say_in_chat':
            return { type: 'say', message: (input.message || '').slice(0, 100), reason };
        case 'click_dialog_option':
            return { type: 'clickDialogOption', optionIndex: input.option_index, reason };
        case 'bank_deposit':
            return { type: 'bankDeposit', slot: input.slot, amount: input.amount, reason };
        case 'bank_withdraw':
            return { type: 'bankWithdraw', slot: input.slot, amount: input.amount, reason };
        case 'use_item_on_item':
            return { type: 'useItemOnItem', sourceSlot: input.source_slot, targetSlot: input.target_slot, reason };
        case 'use_item_on_loc':
            return { type: 'useItemOnLoc', itemSlot: input.item_slot, x: input.x, z: input.z, locId: input.loc_id, reason };
        case 'use_item_on_npc':
            return { type: 'useItemOnNpc', itemSlot: input.item_slot, npcIndex: input.npc_index, reason };
        case 'spell_on_npc':
            return { type: 'spellOnNpc', npcIndex: input.npc_index, spellComponent: input.spell_component, reason };
        case 'set_combat_style':
            return { type: 'setCombatStyle', style: input.style, reason };
        case 'wait':
            return { type: 'wait', ticks: input.ticks || 1, reason };
        case 'close_modal':
            return { type: 'closeModal', reason };
        case 'scan_nearby_locs':
            return { type: 'scanNearbyLocs', radius: input.radius, reason };
        case 'scan_ground_items':
            return { type: 'scanGroundItems', radius: input.radius, reason };
        case 'toggle_prayer':
            return { type: 'togglePrayer', prayerIndex: input.prayer_index, reason };
        case 'shop_buy':
            return { type: 'shopBuy', slot: input.slot, amount: input.amount, reason };
        case 'shop_sell':
            return { type: 'shopSell', slot: input.slot, amount: input.amount, reason };
        case 'close_shop':
            return { type: 'closeShop', reason };
        default:
            return { type: 'wait', reason: `Unknown tool: ${toolName}` };
    }
}

// ============ Agent Class ============

export class Agent {
    private config: AgentConfig;
    private anthropic: Anthropic;
    private ws: WebSocket | null = null;
    private connected = false;
    private running = false;
    private lastState: BotWorldState | null = null;
    private lastProcessedAt = 0;
    private readonly THROTTLE_MS = 3000;
    private conversation: ConversationMessage[] = [];
    private history: AgentEvent[] = [];
    private sseClients: Set<ReadableStreamDefaultController<Uint8Array>> = new Set();
    private pendingActions: Map<string, { resolve: (result: ActionResult) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();
    private processing = false;
    private userMessages: string[] = [];

    constructor(config: AgentConfig) {
        this.config = config;
        // Resolve API key: UI field → saved file → env var
        const apiKey = config.apiKey || loadSavedApiKey() || process.env.ANTHROPIC_API_KEY || '';
        if (!apiKey) {
            throw new Error('No API key. Enter it in the AI tab — it will be saved for next time.');
        }
        // Save for future sessions
        saveApiKey(apiKey);
        this.anthropic = new Anthropic({ apiKey });
    }

    get isRunning(): boolean {
        return this.running;
    }

    get botName(): string {
        return this.config.botName;
    }

    get model(): string {
        return this.config.model || 'claude-3-5-haiku-20241022';
    }

    get goal(): string | undefined {
        return this.config.goal;
    }

    getHistory(): AgentEvent[] {
        return this.history.slice(-100);
    }

    getStatus(): object {
        return {
            running: this.running,
            connected: this.connected,
            botName: this.config.botName,
            model: this.model,
            goal: this.config.goal || null,
            historyLength: this.history.length,
            conversationLength: this.conversation.length,
            sseClients: this.sseClients.size
        };
    }

    // ============ SSE ============

    addSSEClient(controller: ReadableStreamDefaultController<Uint8Array>): void {
        this.sseClients.add(controller);
        // Send recent history to new client
        const recent = this.history.slice(-20);
        for (const event of recent) {
            this.writeSSE(controller, event);
        }
    }

    removeSSEClient(controller: ReadableStreamDefaultController<Uint8Array>): void {
        this.sseClients.delete(controller);
    }

    private emitEvent(event: AgentEvent): void {
        this.history.push(event);
        if (this.history.length > 500) this.history = this.history.slice(-400);

        for (const controller of this.sseClients) {
            this.writeSSE(controller, event);
        }
    }

    private writeSSE(controller: ReadableStreamDefaultController<Uint8Array>, event: AgentEvent): void {
        try {
            const data = JSON.stringify(event);
            controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
        } catch {
            this.sseClients.delete(controller);
        }
    }

    // ============ Chat ============

    addChatMessage(message: string): void {
        this.userMessages.push(message);
        this.emitEvent({
            type: 'status',
            timestamp: Date.now(),
            data: { message: `User: ${message}` }
        });
    }

    // ============ WebSocket ============

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;

        this.emitEvent({
            type: 'status',
            timestamp: Date.now(),
            data: { message: `Starting agent for ${this.config.botName}` }
        });

        this.connectWS();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
        }
        this.connected = false;

        // Clear pending actions
        for (const [id, pending] of this.pendingActions) {
            clearTimeout(pending.timeout);
            pending.resolve({ success: false, message: 'Agent stopped' });
        }
        this.pendingActions.clear();

        this.emitEvent({
            type: 'status',
            timestamp: Date.now(),
            data: { message: 'Agent stopped' }
        });
    }

    private connectWS(): void {
        const port = this.config.gatewayPort || 7780;
        const url = `ws://localhost:${port}`;
        console.log(`[Agent] Connecting to gateway at ${url}...`);

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log(`[Agent] Connected to gateway, sending sdk_connect for ${this.config.botName}`);
            this.ws!.send(JSON.stringify({
                type: 'sdk_connect',
                username: this.config.botName,
                mode: 'control',
                clientId: `agent-${this.config.botName}-${Date.now()}`
            }));
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data.toString());
                this.handleGatewayMessage(msg);
            } catch (e) {
                console.error('[Agent] Failed to parse message:', e);
            }
        };

        this.ws.onclose = () => {
            this.connected = false;
            console.log('[Agent] Disconnected from gateway');
            if (this.running) {
                setTimeout(() => this.connectWS(), 3000);
            }
        };

        this.ws.onerror = () => {
            console.error('[Agent] WebSocket error');
        };
    }

    private handleGatewayMessage(msg: any): void {
        switch (msg.type) {
            case 'sdk_connected':
                this.connected = true;
                console.log(`[Agent] SDK connected for ${this.config.botName}`);
                this.emitEvent({
                    type: 'status',
                    timestamp: Date.now(),
                    data: { message: `Connected to ${this.config.botName}` }
                });
                break;

            case 'sdk_state':
                this.lastState = msg.state;
                this.maybeProcessState();
                break;

            case 'sdk_action_result':
                this.handleActionResult(msg.actionId, msg.result);
                break;

            case 'sdk_error':
                console.error(`[Agent] SDK error: ${msg.error}`);
                this.emitEvent({
                    type: 'error',
                    timestamp: Date.now(),
                    data: { error: msg.error }
                });
                break;
        }
    }

    private handleActionResult(actionId: string | undefined, result: ActionResult): void {
        if (actionId && this.pendingActions.has(actionId)) {
            const pending = this.pendingActions.get(actionId)!;
            clearTimeout(pending.timeout);
            this.pendingActions.delete(actionId);
            pending.resolve(result);
        }

        this.emitEvent({
            type: 'action_result',
            timestamp: Date.now(),
            data: { actionId, result }
        });
    }

    // ============ State Processing ============

    private maybeProcessState(): void {
        if (!this.running || !this.lastState || this.processing) return;

        const now = Date.now();
        if (now - this.lastProcessedAt < this.THROTTLE_MS) return;

        this.lastProcessedAt = now;
        this.processState().catch(err => {
            const errMsg = err?.message || err?.error?.message || String(err) || 'Unknown error';
            console.error('[Agent] Error processing state:', errMsg, err);
            this.processing = false;
            this.emitEvent({
                type: 'error',
                timestamp: Date.now(),
                data: { message: errMsg, error: errMsg }
            });
        });
    }

    private async processState(): Promise<void> {
        if (!this.lastState || this.processing) return;
        this.processing = true;

        try {
            const stateSummary = summarizeState(this.lastState);

            // Build the user message
            let userMsg = `Current game state:\n${stateSummary}`;

            // Append any queued user messages
            if (this.userMessages.length > 0) {
                userMsg += '\n\nMessages from operator:\n' + this.userMessages.map(m => `- ${m}`).join('\n');
                this.userMessages = [];
            }

            // Trim conversation to keep context manageable (last 20 turns)
            if (this.conversation.length > 20) {
                this.conversation = this.conversation.slice(-16);
            }

            this.conversation.push({ role: 'user', content: userMsg });

            const systemPrompt = this.buildSystemPrompt();

            // Call Claude
            this.emitEvent({
                type: 'thinking',
                timestamp: Date.now(),
                data: { message: 'Analyzing game state...' }
            });

            let response;
            try {
                response = await this.anthropic.messages.create({
                    model: this.model,
                    max_tokens: 1024,
                    system: systemPrompt,
                    tools: TOOLS,
                    messages: this.conversation.map(m => ({ role: m.role, content: m.content as any }))
                });
            } catch (apiErr: any) {
                const errMsg = apiErr?.message || apiErr?.error?.message || String(apiErr);
                console.error('[Agent] API error:', errMsg);
                this.emitEvent({ type: 'error', timestamp: Date.now(), data: { message: `API: ${errMsg}` } });
                this.processing = false;
                return;
            }

            // Process response
            const assistantContent = response.content;
            this.conversation.push({ role: 'assistant', content: assistantContent });

            // Extract text blocks for narration
            for (const block of assistantContent) {
                if (block.type === 'text' && block.text.trim()) {
                    this.emitEvent({
                        type: 'narration',
                        timestamp: Date.now(),
                        data: { text: block.text }
                    });
                }
            }

            // Execute tool calls sequentially
            const toolUses = assistantContent.filter(b => b.type === 'tool_use') as Anthropic.Messages.ToolUseBlock[];

            if (toolUses.length > 0) {
                const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

                for (const toolUse of toolUses) {
                    const action = toolCallToAction(toolUse.name, toolUse.input);

                    this.emitEvent({
                        type: 'action',
                        timestamp: Date.now(),
                        data: { tool: toolUse.name, input: toolUse.input, action }
                    });

                    const result = await this.executeAction(action);

                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content: JSON.stringify(result)
                    });
                }

                // Send tool results back
                this.conversation.push({ role: 'user', content: toolResults });
            }

            // If there was a tool use and stop_reason is tool_use, get follow-up
            if (response.stop_reason === 'tool_use' && toolUses.length > 0) {
                const followUp = await this.anthropic.messages.create({
                    model: this.model,
                    max_tokens: 512,
                    system: systemPrompt,
                    tools: TOOLS,
                    messages: this.conversation.map(m => ({ role: m.role, content: m.content as any }))
                });

                const followUpContent = followUp.content;
                this.conversation.push({ role: 'assistant', content: followUpContent });

                for (const block of followUpContent) {
                    if (block.type === 'text' && block.text.trim()) {
                        this.emitEvent({
                            type: 'narration',
                            timestamp: Date.now(),
                            data: { text: block.text }
                        });
                    }
                }

                // Handle additional tool calls from follow-up
                const moreTools = followUpContent.filter(b => b.type === 'tool_use') as Anthropic.Messages.ToolUseBlock[];
                if (moreTools.length > 0) {
                    const moreResults: Anthropic.Messages.ToolResultBlockParam[] = [];
                    for (const toolUse of moreTools) {
                        const action = toolCallToAction(toolUse.name, toolUse.input);
                        this.emitEvent({
                            type: 'action',
                            timestamp: Date.now(),
                            data: { tool: toolUse.name, input: toolUse.input, action }
                        });
                        const result = await this.executeAction(action);
                        moreResults.push({
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: JSON.stringify(result)
                        });
                    }
                    this.conversation.push({ role: 'user', content: moreResults });
                }
            }
        } finally {
            this.processing = false;
        }
    }

    private buildSystemPrompt(): string {
        let prompt = `You are an AI agent playing a 2004-era MMORPG (RuneScape). You control a character named "${this.config.botName}" through tool calls.

## Rules
- You receive game state every few seconds. Analyze it and decide what to do.
- Use tools to take actions. You can call multiple tools per turn.
- Keep say_in_chat messages under 100 characters. Be friendly and in-character.
- If another player chats nearby (type 2 messages), respond via say_in_chat.
- If HP drops below 50%, eat food from inventory immediately.
- If a dialog is open, handle it (click options or continue).
- If a level-up dialog appears, close it with close_modal.
- Explain your reasoning in text blocks (shown in the UI panel). Keep it brief (1-2 sentences).
- Use entity indices from the nearby lists for tool calls (npc_index, loc_id, etc.).
- For NPCs: use the index field and option opIndex from their options list.
- For objects: use x, z, loc_id from the nearby objects list.
- For ground items: use x, z, item_id. Use scan_ground_items to find drops.
- Inventory slots are 0-27.`;

        if (this.config.goal) {
            prompt += `\n\n## Current Goal\n${this.config.goal}`;
        }

        prompt += `\n\n## Game Knowledge\n${GAME_KNOWLEDGE}`;

        return prompt;
    }

    // ============ Action Execution ============

    private executeAction(action: BotAction): Promise<ActionResult> {
        return new Promise((resolve) => {
            if (!this.ws || !this.connected) {
                resolve({ success: false, message: 'Not connected' });
                return;
            }

            const actionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

            const timeout = setTimeout(() => {
                this.pendingActions.delete(actionId);
                resolve({ success: false, message: 'Action timeout (10s)' });
            }, 10000);

            this.pendingActions.set(actionId, { resolve, timeout });

            this.ws.send(JSON.stringify({
                type: 'sdk_action',
                username: this.config.botName,
                actionId,
                action
            }));
        });
    }
}

// ============ Factory ============

export function createAgent(config: AgentConfig): Agent {
    return new Agent(config);
}

export function hasApiKey(): boolean {
    return !!(loadSavedApiKey() || process.env.ANTHROPIC_API_KEY);
}

export function saveApiKeyExternal(apiKey: string): void {
    saveApiKey(apiKey);
}
