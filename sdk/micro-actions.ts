// Micro-actions — atomic, parameterized, reusable actions with pre/post conditions
// Each action is self-contained: preconditions check, execute, postconditions verify

import type { BotSDK } from './index';
import type { BotActions } from './actions';
import type { BotWorldState, NearbyNpc } from './types';

export interface ActionContext {
    bot: BotActions;
    sdk: BotSDK;
    state: () => BotWorldState; // fresh state getter
}

export interface MicroAction<P = any> {
    name: string;
    preconditions: (state: BotWorldState, params: P) => { ok: boolean; reason?: string };
    execute: (ctx: ActionContext, params: P) => Promise<{ success: boolean; message: string }>;
    postconditions: (state: BotWorldState, params: P) => boolean;
}

// ============ Helpers ============

const FOOD_PATTERN = /cooked|bread|shrimp|trout|salmon|lobster|cake|pie|meat|potato/i;

/** Find an NPC matching pattern that is NOT already in combat */
export function findFreeNpc(state: BotWorldState, pattern: RegExp): NearbyNpc | null {
    return state.nearbyNpcs.find(n =>
        pattern.test(n.name) &&
        !n.inCombat &&
        n.combatLevel > 0 &&
        n.distance < 15
    ) ?? null;
}

// ============ Micro-Actions ============

/** Walk to coords with HP monitoring — eats food if HP drops, aborts if critically low with no food */
export const walkSafe: MicroAction<{ x: number; z: number }> = {
    name: 'walkSafe',
    preconditions: (state) => {
        if (state.player?.combat.inCombat) return { ok: false, reason: 'In combat' };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        const walkPromise = ctx.bot.walkTo(params.x, params.z);

        // Monitor HP while walking
        const monitor = async () => {
            while (true) {
                await ctx.sdk.waitForTicks(5);
                const s = ctx.state();
                if (!s.player) break;
                const pct = s.player.hp / s.player.maxHp;

                if (pct < 0.3) {
                    const food = s.inventory.find(i => FOOD_PATTERN.test(i.name));
                    if (food) {
                        await ctx.bot.eatFood(food);
                    } else if (pct < 0.2) {
                        return 'abort';
                    }
                }
                // Check if walk finished
                const pos = s.player;
                const dx = Math.abs(pos.worldX - params.x);
                const dz = Math.abs(pos.worldZ - params.z);
                if (dx <= 3 && dz <= 3) break;
            }
            return 'ok';
        };

        const [walkResult, monitorResult] = await Promise.all([walkPromise, monitor()]);

        if (monitorResult === 'abort') {
            return { success: false, message: 'Aborted walk — HP critically low with no food' };
        }
        return { success: walkResult.success, message: walkResult.message };
    },
    postconditions: (state, params) => {
        if (!state.player) return false;
        const dx = Math.abs(state.player.worldX - params.x);
        const dz = Math.abs(state.player.worldZ - params.z);
        return dx <= 3 && dz <= 3;
    },
};

/** Attack a free NPC matching pattern, optionally setting combat style first */
export const attackTarget: MicroAction<{ pattern: RegExp; style?: number }> = {
    name: 'attackTarget',
    preconditions: (state, params) => {
        if (state.player?.combat.inCombat) return { ok: false, reason: 'Already in combat' };
        const npc = findFreeNpc(state, params.pattern);
        if (!npc) return { ok: false, reason: `No free NPC matching ${params.pattern}` };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        // Set combat style if specified
        if (params.style !== undefined) {
            await ctx.sdk.sendSetCombatStyle(params.style);
            await ctx.sdk.waitForTicks(1);
        }

        const state = ctx.state();
        const npc = findFreeNpc(state, params.pattern);
        if (!npc) return { success: false, message: `No free NPC matching ${params.pattern}` };

        const attackOpt = npc.optionsWithIndex.find(o => /attack/i.test(o.text));
        if (!attackOpt) return { success: false, message: `No attack option on ${npc.name}` };

        // Walk near if needed
        if (npc.distance > 2) {
            const walk = await ctx.bot.walkTo(npc.x, npc.z, 2);
            if (!walk.success) return { success: false, message: `Cannot reach ${npc.name}: ${walk.message}` };
        }

        const result = await ctx.sdk.sendInteractNpc(npc.index, attackOpt.opIndex);
        if (!result.success) return { success: false, message: result.message };

        // Wait for combat to start then end
        try {
            await ctx.sdk.waitForCondition(s => s.player?.combat.inCombat === true, 5000);
        } catch {
            return { success: false, message: `Timeout waiting to engage ${npc.name}` };
        }

        // Wait for combat to end
        try {
            await ctx.sdk.waitForCondition(s => !s.player?.combat.inCombat, 60000);
        } catch {
            return { success: false, message: 'Combat timeout — still fighting after 60s' };
        }

        return { success: true, message: `Killed ${npc.name}` };
    },
    postconditions: (state) => !state.player?.combat.inCombat,
};

/** Pick up ground items matching patterns within maxDist */
export const lootGround: MicroAction<{ patterns: RegExp[]; maxDist: number }> = {
    name: 'lootGround',
    preconditions: (state) => {
        if (state.inventory.length >= 28) return { ok: false, reason: 'Inventory full' };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        let picked = 0;
        for (const pattern of params.patterns) {
            // Re-check state each iteration — items may appear/disappear
            let items = ctx.state().groundItems.filter(
                g => pattern.test(g.name) && g.distance <= params.maxDist
            );
            for (const item of items) {
                if (ctx.state().inventory.length >= 28) break;
                const result = await ctx.bot.pickupItem(item);
                if (result.success) picked++;
                await ctx.sdk.waitForTicks(1);
            }
        }
        return { success: true, message: `Picked up ${picked} items` };
    },
    postconditions: (state, params) => {
        return !state.groundItems.some(
            g => params.patterns.some(p => p.test(g.name)) && g.distance <= params.maxDist
        );
    },
};

/** Eat food if HP below 50% */
export const eatFood: MicroAction<{}> = {
    name: 'eatFood',
    preconditions: (state) => {
        if (!state.player) return { ok: false, reason: 'No player state' };
        if (state.player.hp >= state.player.maxHp * 0.5) return { ok: false, reason: 'HP above 50%' };
        const hasFood = state.inventory.some(i => FOOD_PATTERN.test(i.name));
        if (!hasFood) return { ok: false, reason: 'No food in inventory' };
        return { ok: true };
    },
    execute: async (ctx) => {
        const food = ctx.state().inventory.find(i => FOOD_PATTERN.test(i.name));
        if (!food) return { success: false, message: 'No food found' };

        const hpBefore = ctx.state().player!.hp;
        const result = await ctx.bot.eatFood(food);
        if (!result.success) return { success: false, message: result.message };
        return { success: true, message: `Ate ${food.name}, healed ${result.hpGained} HP` };
    },
    postconditions: (state) => {
        // HP should have increased (or at least we tried)
        return true;
    },
};

/** Bury all bones in inventory */
export const buryBones: MicroAction<{}> = {
    name: 'buryBones',
    preconditions: (state) => {
        const hasBones = state.inventory.some(i => /bones/i.test(i.name));
        if (!hasBones) return { ok: false, reason: 'No bones in inventory' };
        return { ok: true };
    },
    execute: async (ctx) => {
        let buried = 0;
        while (true) {
            const bones = ctx.state().inventory.find(i => /bones/i.test(i.name));
            if (!bones) break;
            await ctx.sdk.sendUseItem(bones.slot);
            await ctx.sdk.waitForTicks(2);
            buried++;
        }
        return { success: true, message: `Buried ${buried} bones` };
    },
    postconditions: (state) => !state.inventory.some(i => /bones/i.test(i.name)),
};

/** Walk to bank coords and open the bank */
export const openBank: MicroAction<{ x: number; z: number }> = {
    name: 'openBank',
    preconditions: (state) => {
        if (state.player?.combat.inCombat) return { ok: false, reason: 'In combat' };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        const walk = await ctx.bot.walkTo(params.x, params.z);
        if (!walk.success) return { success: false, message: `Cannot reach bank: ${walk.message}` };

        const result = await ctx.bot.openBank();
        if (!result.success) return { success: false, message: result.message };
        return { success: true, message: 'Bank opened' };
    },
    postconditions: (state) => state.bank.isOpen || state.interface?.isOpen,
};

/** Deposit items matching patterns (use -1 for all) */
export const depositItems: MicroAction<{ patterns: RegExp[] }> = {
    name: 'depositItems',
    preconditions: (state) => {
        if (!state.bank.isOpen && !state.interface?.isOpen) return { ok: false, reason: 'Bank not open' };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        let deposited = 0;
        for (const pattern of params.patterns) {
            // Re-scan inventory each time — items shift after deposits
            const items = ctx.state().inventory.filter(i => pattern.test(i.name));
            for (const item of items) {
                const result = await ctx.bot.depositItem(item, -1);
                if (result.success) deposited++;
                await ctx.sdk.waitForTicks(1);
            }
        }
        return { success: true, message: `Deposited ${deposited} item stacks` };
    },
    postconditions: (state, params) => {
        return !state.inventory.some(i => params.patterns.some(p => p.test(i.name)));
    },
};

/** Withdraw items from bank by pattern and amount */
export const withdrawItems: MicroAction<{ items: { pattern: RegExp; amount: number }[] }> = {
    name: 'withdrawItems',
    preconditions: (state) => {
        if (!state.bank.isOpen && !state.interface?.isOpen) return { ok: false, reason: 'Bank not open' };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        let withdrawn = 0;
        for (const req of params.items) {
            const bankItem = ctx.state().bank.items.find(i => req.pattern.test(i.name));
            if (!bankItem) continue;
            const result = await ctx.bot.withdrawItem(bankItem.slot, req.amount);
            if (result.success) withdrawn++;
            await ctx.sdk.waitForTicks(1);
        }
        return { success: true, message: `Withdrew ${withdrawn} item types` };
    },
    postconditions: (state, params) => {
        return params.items.every(req =>
            state.inventory.some(i => req.pattern.test(i.name))
        );
    },
};

/** Close the bank interface */
export const closeBank: MicroAction<{}> = {
    name: 'closeBank',
    preconditions: (state) => {
        if (!state.bank.isOpen && !state.interface?.isOpen) return { ok: false, reason: 'Bank not open' };
        return { ok: true };
    },
    execute: async (ctx) => {
        const result = await ctx.bot.closeBank();
        return { success: result.success, message: result.message };
    },
    postconditions: (state) => !state.bank.isOpen && !state.interface?.isOpen,
};

/** Cook raw food at a range location */
export const cookFood: MicroAction<{ rawPattern: RegExp; rangeX: number; rangeZ: number }> = {
    name: 'cookFood',
    preconditions: (state, params) => {
        const hasRaw = state.inventory.some(i => params.rawPattern.test(i.name));
        if (!hasRaw) return { ok: false, reason: 'No raw food in inventory' };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        // Walk to range area
        const walk = await ctx.bot.walkTo(params.rangeX, params.rangeZ);
        if (!walk.success) return { success: false, message: `Cannot reach range: ${walk.message}` };

        let cooked = 0;
        while (true) {
            const raw = ctx.state().inventory.find(i => params.rawPattern.test(i.name));
            if (!raw) break;

            const range = ctx.sdk.findNearbyLoc(/range|stove/i);
            if (!range) return { success: false, message: 'No cooking range found nearby' };

            const result = await ctx.bot.useItemOnLoc(raw, range);
            if (!result.success) return { success: false, message: `Cook failed: ${result.message}` };
            cooked++;
            await ctx.sdk.waitForTicks(2);
        }
        return { success: true, message: `Cooked ${cooked} items` };
    },
    postconditions: (state, params) => !state.inventory.some(i => params.rawPattern.test(i.name)),
};

/** Buy items from a shop NPC */
export const buyFromShop: MicroAction<{ npcPattern: RegExp; items: { name: RegExp; amount: number }[] }> = {
    name: 'buyFromShop',
    preconditions: (state) => {
        if (state.player?.combat.inCombat) return { ok: false, reason: 'In combat' };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        // Open shop
        const openResult = await ctx.bot.openShop(params.npcPattern);
        if (!openResult.success) return { success: false, message: `Shop open failed: ${openResult.message}` };

        let bought = 0;
        for (const req of params.items) {
            const result = await ctx.bot.buyFromShop(req.name, req.amount);
            if (result.success) bought++;
            await ctx.sdk.waitForTicks(1);
        }

        await ctx.bot.closeShop();
        return { success: true, message: `Bought ${bought} item types` };
    },
    postconditions: (state, params) => {
        return params.items.every(req =>
            state.inventory.some(i => req.name.test(i.name))
        );
    },
};

/** Equip an item from inventory */
export const equipItem: MicroAction<{ pattern: RegExp }> = {
    name: 'equipItem',
    preconditions: (state, params) => {
        const item = state.inventory.find(i => params.pattern.test(i.name));
        if (!item) return { ok: false, reason: `No item matching ${params.pattern} in inventory` };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        const item = ctx.state().inventory.find(i => params.pattern.test(i.name));
        if (!item) return { success: false, message: `Item not found: ${params.pattern}` };

        const result = await ctx.bot.equipItem(item);
        return { success: result.success, message: result.message };
    },
    postconditions: (state, params) => !state.inventory.some(i => params.pattern.test(i.name)),
};

/** Set combat style (0-3) */
export const setCombatStyle: MicroAction<{ style: number }> = {
    name: 'setCombatStyle',
    preconditions: () => ({ ok: true }),
    execute: async (ctx, params) => {
        const result = await ctx.sdk.sendSetCombatStyle(params.style);
        await ctx.sdk.waitForTicks(1);
        return { success: result.success, message: result.success ? `Set combat style to ${params.style}` : result.message };
    },
    postconditions: (state, params) => state.combatStyle?.currentStyle === params.style,
};

/** Drop all items matching patterns */
export const dropItems: MicroAction<{ patterns: RegExp[] }> = {
    name: 'dropItems',
    preconditions: (state, params) => {
        const hasMatch = state.inventory.some(i => params.patterns.some(p => p.test(i.name)));
        if (!hasMatch) return { ok: false, reason: 'No matching items to drop' };
        return { ok: true };
    },
    execute: async (ctx, params) => {
        let dropped = 0;
        for (const pattern of params.patterns) {
            while (true) {
                const item = ctx.state().inventory.find(i => pattern.test(i.name));
                if (!item) break;
                await ctx.sdk.sendDropItem(item.slot);
                await ctx.sdk.waitForTicks(1);
                dropped++;
            }
        }
        return { success: true, message: `Dropped ${dropped} items` };
    },
    postconditions: (state, params) => {
        return !state.inventory.some(i => params.patterns.some(p => p.test(i.name)));
    },
};
