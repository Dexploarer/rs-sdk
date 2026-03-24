// Chain runner — executes sequences of micro-actions with repeat/skip logic
// Each chain is a named pipeline of steps that can repeat, skip, and log progress

import { encode } from '@toon-format/toon';
import type { MicroAction, ActionContext } from './micro-actions';
import type { BotWorldState } from './types';
import * as ma from './micro-actions';

// ============ Types ============

export interface ChainStep {
    action: MicroAction;
    params: any;
    /** Repeat this step until condition is true */
    repeatUntil?: (state: BotWorldState) => boolean;
    /** Skip this step if condition is true */
    skipIf?: (state: BotWorldState) => boolean;
    /** Max repeats before moving on (default: 1000) */
    maxRepeats?: number;
}

export interface Chain {
    name: string;
    steps: ChainStep[];
}

export interface ChainResult {
    success: boolean;
    stepsCompleted: number;
    message: string;
}

// ============ Chain Runner ============

export class ChainRunner {
    async run(chain: Chain, ctx: ActionContext): Promise<ChainResult> {
        console.log(`[Chain] Starting: ${chain.name} (${chain.steps.length} steps)`);
        let stepsCompleted = 0;

        for (let i = 0; i < chain.steps.length; i++) {
            const step = chain.steps[i];
            const state = ctx.state();

            // Skip check
            if (step.skipIf && step.skipIf(state)) {
                console.log(`[Chain] Step ${i + 1}/${chain.steps.length} ${step.action.name}: SKIPPED`);
                stepsCompleted++;
                continue;
            }

            const maxRepeats = step.maxRepeats ?? 1000;
            let repeats = 0;

            do {
                repeats++;
                const currentState = ctx.state();

                // Check preconditions
                const pre = step.action.preconditions(currentState, step.params);
                if (!pre.ok) {
                    // If repeating and preconditions fail, that's normal — just skip this iteration
                    if (step.repeatUntil && repeats > 1) {
                        await ctx.sdk.waitForTicks(2);
                        continue;
                    }
                    console.log(`[Chain] Step ${i + 1} ${step.action.name}: precondition failed — ${pre.reason}`);
                    // Non-repeating step with failed precondition — skip it
                    break;
                }

                console.log(`[Chain] Step ${i + 1}/${chain.steps.length} ${step.action.name}${step.repeatUntil ? ` (repeat ${repeats})` : ''}`);

                const result = await step.action.execute(ctx, step.params);

                if (!result.success) {
                    console.log(`[Chain] Step ${step.action.name} failed: ${result.message}`);
                    // If repeating, failures are tolerable — try again
                    if (step.repeatUntil) {
                        await ctx.sdk.waitForTicks(2);
                        continue;
                    }
                    // Non-repeating step failure — abort chain
                    return {
                        success: false,
                        stepsCompleted,
                        message: `Step ${step.action.name} failed: ${result.message}`,
                    };
                }

                // Check repeatUntil condition
                if (!step.repeatUntil) break;
                if (step.repeatUntil(ctx.state())) break;

            } while (repeats < maxRepeats);

            stepsCompleted++;

            if (repeats >= maxRepeats) {
                console.log(`[Chain] Step ${step.action.name} hit max repeats (${maxRepeats})`);
            }
        }

        console.log(`[Chain] Completed: ${chain.name} (${stepsCompleted}/${chain.steps.length} steps)`);
        return { success: true, stepsCompleted, message: `Chain ${chain.name} complete` };
    }
}

// ============ Pre-built Chain Factories ============

export interface TrainCombatParams {
    skill: string;
    style: number;
    location: { x: number; z: number };
    npcPattern: RegExp;
    lootPatterns?: RegExp[];
}

/** Combat training loop: walk to spot, set style, kill+loot+bury+eat until full */
export function trainCombat(params: TrainCombatParams): Chain {
    const lootPatterns = params.lootPatterns ?? [/bones/i];

    return {
        name: `train_${params.skill}`,
        steps: [
            // Walk to training location
            {
                action: ma.walkSafe,
                params: { x: params.location.x, z: params.location.z },
            },
            // Set combat style
            {
                action: ma.setCombatStyle,
                params: { style: params.style },
            },
            // Kill + loot + bury + eat, repeat until inventory full
            {
                action: ma.attackTarget,
                params: { pattern: params.npcPattern, style: params.style },
                repeatUntil: (state) => state.inventory.length >= 28,
                maxRepeats: 200,
            },
            {
                action: ma.lootGround,
                params: { patterns: lootPatterns, maxDist: 5 },
                repeatUntil: (state) => state.inventory.length >= 28,
                maxRepeats: 200,
                skipIf: (state) => state.inventory.length >= 28,
            },
            {
                action: ma.buryBones,
                params: {},
                skipIf: (state) => !state.inventory.some(i => /bones/i.test(i.name)),
            },
            {
                action: ma.eatFood,
                params: {},
                skipIf: (state) => {
                    if (!state.player) return true;
                    return state.player.hp >= state.player.maxHp * 0.5;
                },
            },
        ],
    };
}

export interface BankRunParams {
    fromX: number;
    fromZ: number;
    bankX: number;
    bankZ: number;
    depositPatterns: RegExp[];
    withdrawItems?: { pattern: RegExp; amount: number }[];
}

/** Bank run: walk to bank, deposit, optionally withdraw, walk back */
export function bankRun(params: BankRunParams): Chain {
    const steps: ChainStep[] = [
        // Walk to bank
        {
            action: ma.walkSafe,
            params: { x: params.bankX, z: params.bankZ },
        },
        // Open bank
        {
            action: ma.openBank,
            params: { x: params.bankX, z: params.bankZ },
        },
        // Deposit items
        {
            action: ma.depositItems,
            params: { patterns: params.depositPatterns },
        },
    ];

    // Optionally withdraw items
    if (params.withdrawItems && params.withdrawItems.length > 0) {
        steps.push({
            action: ma.withdrawItems,
            params: { items: params.withdrawItems },
        });
    }

    // Close bank
    steps.push({
        action: ma.closeBank,
        params: {},
    });

    // Walk back
    steps.push({
        action: ma.walkSafe,
        params: { x: params.fromX, z: params.fromZ },
    });

    return { name: 'bank_run', steps };
}

export interface CookRunParams {
    rawPattern: RegExp;
    rangeX: number;
    rangeZ: number;
    returnX: number;
    returnZ: number;
}

/** Cook run: walk to range, cook all raw food, walk back */
export function cookRun(params: CookRunParams): Chain {
    return {
        name: 'cook_run',
        steps: [
            {
                action: ma.walkSafe,
                params: { x: params.rangeX, z: params.rangeZ },
            },
            {
                action: ma.cookFood,
                params: { rawPattern: params.rawPattern, rangeX: params.rangeX, rangeZ: params.rangeZ },
            },
            {
                action: ma.walkSafe,
                params: { x: params.returnX, z: params.returnZ },
            },
        ],
    };
}

export interface BuyGearParams {
    shopX: number;
    shopZ: number;
    npcPattern: RegExp;
    items: { name: RegExp; amount: number }[];
    equipAfter?: RegExp[];
}

/** Buy gear from shop, optionally equip after purchase */
export function buyGear(params: BuyGearParams): Chain {
    const steps: ChainStep[] = [
        // Walk to shop
        {
            action: ma.walkSafe,
            params: { x: params.shopX, z: params.shopZ },
        },
        // Buy items
        {
            action: ma.buyFromShop,
            params: { npcPattern: params.npcPattern, items: params.items },
        },
    ];

    // Equip purchased items
    if (params.equipAfter) {
        for (const pattern of params.equipAfter) {
            steps.push({
                action: ma.equipItem,
                params: { pattern },
                skipIf: (state) => !state.inventory.some(i => pattern.test(i.name)),
            });
        }
    }

    return { name: 'buy_gear', steps };
}
