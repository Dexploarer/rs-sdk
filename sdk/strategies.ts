// Strategies — high-level goals that pick chains based on current state
// Each strategy inspects world state and returns the next chain to execute

import type { BotWorldState } from './types';
import type { Chain } from './chains';
import { trainCombat, bankRun } from './chains';

// ============ Types ============

export interface Strategy {
    name: string;
    goal: string;
    /** Returns the next chain to run, or null if goal is complete */
    getNextChain: (state: BotWorldState) => Chain | null;
}

// ============ Known Locations ============

const LOCATIONS = {
    // Training spots
    lumbridge_goblins: { x: 3259, z: 3228 },
    lumbridge_cows: { x: 3253, z: 3270 },
    varrock_guards: { x: 3211, z: 3462 },
    barbarian_village: { x: 3082, z: 3420 },
    // Banks
    lumbridge_bank: { x: 3208, z: 3220 },
    varrock_west_bank: { x: 3185, z: 3436 },
    varrock_east_bank: { x: 3253, z: 3420 },
    al_kharid_bank: { x: 3269, z: 3167 },
};

// ============ Helpers ============

function getSkillLevel(state: BotWorldState, skillName: string): number {
    return state.skills.find(s => s.name.toLowerCase() === skillName.toLowerCase())?.level ?? 1;
}

function isInventoryFull(state: BotWorldState): boolean {
    return state.inventory.length >= 28;
}

/** Pick training spot and NPC based on combat level */
function pickTrainingSpot(combatLevel: number): { location: { x: number; z: number }; npcPattern: RegExp; bank: { x: number; z: number } } {
    if (combatLevel < 10) {
        return {
            location: LOCATIONS.lumbridge_goblins,
            npcPattern: /^goblin$/i,
            bank: LOCATIONS.lumbridge_bank,
        };
    }
    if (combatLevel < 25) {
        return {
            location: LOCATIONS.lumbridge_cows,
            npcPattern: /^cow$/i,
            bank: LOCATIONS.lumbridge_bank,
        };
    }
    if (combatLevel < 40) {
        return {
            location: LOCATIONS.barbarian_village,
            npcPattern: /^barbarian$/i,
            bank: LOCATIONS.varrock_west_bank,
        };
    }
    // 40+ — guards
    return {
        location: LOCATIONS.varrock_guards,
        npcPattern: /^guard$/i,
        bank: LOCATIONS.varrock_west_bank,
    };
}

// ============ Strategy Factories ============

/** Train a melee skill to target level, auto-selecting training spot and handling bank runs */
function trainMelee(skillName: string, style: number, target: number): Strategy {
    return {
        name: `train_${skillName.toLowerCase()}_to_${target}`,
        goal: `Train ${skillName} from current level to ${target}`,
        getNextChain: (state) => {
            const level = getSkillLevel(state, skillName);
            if (level >= target) return null; // Goal complete

            const combatLevel = state.player?.combatLevel ?? 3;
            const spot = pickTrainingSpot(combatLevel);

            // If inventory is full, do a bank run first
            if (isInventoryFull(state)) {
                return bankRun({
                    fromX: spot.location.x,
                    fromZ: spot.location.z,
                    bankX: spot.bank.x,
                    bankZ: spot.bank.z,
                    depositPatterns: [/./], // deposit everything
                });
            }

            // Otherwise, train combat
            return trainCombat({
                skill: skillName,
                style,
                location: spot.location,
                npcPattern: spot.npcPattern,
                lootPatterns: [/bones/i],
            });
        },
    };
}

/** Train Defence to target level (combat style 3 — defensive) */
export function trainDefence(target: number): Strategy {
    return trainMelee('Defence', 3, target);
}

/** Train Attack to target level (combat style 0 — accurate) */
export function trainAttack(target: number): Strategy {
    return trainMelee('Attack', 0, target);
}

/** Train Strength to target level (combat style 1 — aggressive) */
export function trainStrength(target: number): Strategy {
    return trainMelee('Strength', 1, target);
}
