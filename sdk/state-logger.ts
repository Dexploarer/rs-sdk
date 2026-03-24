// Game state logger using TOON format for compact, token-efficient encoding
import { encode } from '@toon-format/toon';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { BotWorldState } from './types';

const LOG_DIR = join(import.meta.dir, '../learnings/exploration');

export function ensureLogDir() {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

/** Encode the full game state as compact TOON */
export function stateToToon(state: BotWorldState): string {
    const p = state.player;
    if (!p) return 'player: null';

    const data: any = {
        player: {
            name: p.name,
            combat: p.combatLevel,
            hp: p.hp,
            maxHp: p.maxHp,
            x: p.worldX,
            z: p.worldZ,
            level: p.level,
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
        nearbyLocs: state.nearbyLocs.slice(0, 8).map(l => ({
            name: l.name, dist: l.distance, x: l.x, z: l.z,
            opts: l.optionsWithIndex?.map(o => o.text).join('/') || ''
        })),
        groundItems: state.groundItems.slice(0, 5).map(i => ({
            name: i.name, count: i.count, dist: i.distance
        })),
        messages: state.gameMessages.slice(0, 3).map(m => ({
            text: m.text, type: m.type
        })),
    };

    if (state.dialog?.isOpen) {
        data.dialog = {
            text: state.dialog.text?.slice(0, 100),
            options: state.dialog.options
        };
    }

    return encode(data);
}

/** Log a discovery to a file */
export function logDiscovery(category: string, entry: string) {
    ensureLogDir();
    const file = join(LOG_DIR, `${category}.toon`);
    const timestamp = new Date().toISOString().slice(0, 19);
    appendFileSync(file, `# ${timestamp}\n${entry}\n\n`);
}

/** Log a location we visited with what we saw */
export function logLocation(name: string, x: number, z: number, state: BotWorldState) {
    const npcs = state.nearbyNpcs.slice(0, 10).map(n =>
        ({ name: n.name, lvl: n.combatLevel, dist: n.distance, aggressive: n.distance < 5 && n.combatLevel > 0 ? '?' : 'no' })
    );
    const locs = state.nearbyLocs.slice(0, 10).map(l =>
        ({ name: l.name, dist: l.distance, opts: l.optionsWithIndex?.map(o => o.text).join('/') || '' })
    );
    const items = state.groundItems.map(i =>
        ({ name: i.name, count: i.count, dist: i.distance })
    );

    const data = {
        location: { name, x, z, level: state.player?.level ?? 0 },
        npcs,
        objects: locs,
        groundItems: items,
    };

    logDiscovery('locations', encode(data));
}

/** Log a combat encounter */
export function logCombat(npcName: string, result: string, hpBefore: number, hpAfter: number, xpGained?: number) {
    logDiscovery('combat', encode({
        encounter: { npc: npcName, result, hpBefore, hpAfter, xpGained: xpGained ?? 0 }
    }));
}

/** Log a shop we visited */
export function logShop(shopName: string, items: { name: string; price: number; stock: number }[]) {
    logDiscovery('shops', encode({
        shop: { name: shopName },
        items,
    }));
}

/** Log a danger we discovered */
export function logDanger(description: string, x: number, z: number, threat: string) {
    logDiscovery('dangers', encode({
        danger: { description, x, z, threat }
    }));
}
