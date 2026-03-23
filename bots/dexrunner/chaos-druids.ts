import { runScript } from '../../sdk/runner';

const DRAYNOR_BANK = { x: 3092, z: 3243 };
const DUNGEON_ENTRANCE = { x: 3096, z: 3468 };  // adjacent to trapdoor, not on it
const DRUID_AREA = { x: 3110, z: 9944 };

const FLEE_HP = 0.40;  // flee underground at 40% hp
const REGEN_HP = 0.90; // wait until 90% hp before re-entering

const KEEP = /^(coins|grimy|rune|law rune|nature rune|chaos rune|earth rune|air rune|mind rune|water rune|body rune|tinderbox|shrimps|anchovies|trout|bread|kebab)$/i;
const FOOD = /^(shrimps|anchovies|trout|bread|kebab|cooked|salmon|tuna|lobster|swordfish|sardine)$/i;

function getLevel(skills: any[], name: string) {
    return skills.find((s: any) => s.name.toLowerCase() === name.toLowerCase())?.level ?? 1;
}

function hpPct(state: any) {
    return (state?.player?.hp ?? 1) / (state?.player?.maxHp ?? 1);
}

function isUnderground(state: any) {
    return (state?.player?.worldZ ?? 0) > 6400;
}

async function goToBank(ctx: any) {
    const { bot, sdk } = ctx;
    // Safe route: avoid dark wizards at ~(3220, 3220)
    const pos = sdk.getState()?.player;
    if (pos && pos.worldZ < 3260) await bot.walkTo(3222, 3270);
    await bot.walkTo(3150, 3270);
    await bot.walkTo(DRAYNOR_BANK.x, DRAYNOR_BANK.z);
}

async function enterDungeon(ctx: any) {
    const { bot, sdk } = ctx;
    if (isUnderground(sdk.getState())) return;

    await bot.walkTo(DUNGEON_ENTRANCE.x, DUNGEON_ENTRANCE.z);

    // Open trapdoor if closed
    const s1 = sdk.getState();
    const td1 = s1?.nearbyLocs.find((l: any) => /trapdoor/i.test(l.name));
    if (td1?.options.some((o: any) => /^open$/i.test(o))) {
        await bot.interactLoc(td1, /^open$/i);
        await new Promise(r => setTimeout(r, 1200));
    }

    // Climb down
    const s2 = sdk.getState();
    const td2 = s2?.nearbyLocs.find((l: any) => /trapdoor/i.test(l.name));
    const downOpt = td2?.options.find((o: any) => /climb|down|descend/i.test(o));
    if (td2 && downOpt) {
        await bot.interactLoc(td2, new RegExp(downOpt, 'i'));
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`Underground: z=${sdk.getState()?.player?.worldZ}`);
}

async function exitDungeon(ctx: any) {
    const { bot, sdk } = ctx;
    if (!isUnderground(sdk.getState())) return;

    await bot.walkTo(3097, 9868);

    const s = sdk.getState();
    const ladder = s?.nearbyLocs.find((l: any) =>
        /ladder|trapdoor/i.test(l.name) &&
        l.options.some((o: any) => /up|climb|ascend|open/i.test(o))
    );
    if (ladder) {
        const opt = ladder.options.find((o: any) => /up|climb|ascend|open/i.test(o));
        await bot.interactLoc(ladder, new RegExp(opt!, 'i'));
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`Surface: z=${sdk.getState()?.player?.worldZ}`);
}

async function navigateToDruids(ctx: any) {
    const { bot, sdk } = ctx;
    if (!isUnderground(sdk.getState())) return;

    await bot.walkTo(3097, 9930);

    // Open door to druid room if present
    const s = sdk.getState();
    const door = s?.nearbyLocs.find((l: any) =>
        /^door$/i.test(l.name) && l.distance < 6 &&
        l.options.some((o: any) => /^open$/i.test(o))
    );
    if (door) {
        console.log(`Opening door @ (${door.x}, ${door.z})`);
        await bot.openDoor(door);
        await new Promise(r => setTimeout(r, 800));
    }

    await bot.walkTo(DRUID_AREA.x, DRUID_AREA.z);
    const nearby = sdk.getState()?.nearbyNpcs.filter((n: any) => /chaos druid/i.test(n.name)) ?? [];
    console.log(`In druid area: ${nearby.length} druids visible`);
}

// ===== MAIN =====
await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // Exit dungeon if we started underground
    if (isUnderground(sdk.getState())) {
        console.log('Started underground, exiting first...');
        await exitDungeon(ctx);
    }

    // Get gear from bank
    console.log('Getting gear...');
    await goToBank(ctx);
    const bank = await bot.openBank();
    if (bank.success) {
        // Deposit all junk first (raw fish, logs, misc)
        for (const item of sdk.getState()?.inventory ?? []) {
            if (/sword|dagger|axe|shield|scimitar|tinderbox/i.test(item.name)) continue;
            await bot.depositItem(new RegExp(`^${item.name}$`, 'i'), -1);
            await new Promise(r => setTimeout(r, 150));
        }
        const b = sdk.getState()?.bank;
        // Withdraw food if any
        for (const item of b?.items.filter((i: any) => FOOD.test(i.name)) ?? []) {
            await bot.withdrawItem(item.slot, item.count);
            await new Promise(r => setTimeout(r, 200));
        }
        // Withdraw weapon if none equipped
        const equip = sdk.getState()?.equipment ?? [];
        const hasWeapon = equip.some((i: any) => /sword|dagger|axe|scimitar/i.test(i.name));
        if (!hasWeapon) {
            const weapon = b?.items.find((i: any) => /sword|dagger/i.test(i.name));
            if (weapon) { await bot.withdrawItem(weapon.slot, 1); await new Promise(r => setTimeout(r, 200)); }
        }
        await bot.closeBank();
    }

    // Equip anything unequipped
    const sword = sdk.findInventoryItem(/sword|dagger/i);
    if (sword) await bot.equipItem(sword);

    // Set Strength style
    await sdk.sendSetCombatStyle(1);
    console.log('Strength style set');

    await enterDungeon(ctx);
    await navigateToDruids(ctx);

    let kills = 0;
    let bankTrips = 0;

    while (true) {
        const state = sdk.getState();
        if (!state?.player) { await new Promise(r => setTimeout(r, 500)); continue; }

        const str = getLevel(state.skills, 'Strength');
        const hp = `${state.player.hp}/${state.player.maxHp}`;
        const inv = state.inventory.length;
        const underground = isUnderground(state);

        // Eat food if available and low hp
        if (hpPct(state) < FLEE_HP) {
            const food = sdk.findInventoryItem(FOOD);
            if (food) {
                await bot.eatFood(food);
                await new Promise(r => setTimeout(r, 400));
                continue;
            }
        }

        // Flee underground if too low and no food
        if (underground && hpPct(state) < FLEE_HP) {
            console.log(`Low HP (${hp}), exiting dungeon...`);
            await exitDungeon(ctx);
            // Wait for HP to regen
            console.log('Waiting for HP regen...');
            await sdk.waitForCondition(() => hpPct(sdk.getState()) >= REGEN_HP, 120_000);
            console.log(`HP restored: ${sdk.getState()?.player?.hp}/${sdk.getState()?.player?.maxHp}`);
            await enterDungeon(ctx);
            await navigateToDruids(ctx);
            continue;
        }

        // Bank when inventory full
        if (inv >= 26) {
            console.log(`Banking (${inv} items)...`);
            if (underground) await exitDungeon(ctx);
            await goToBank(ctx);
            const b = await bot.openBank();
            if (b.success) {
                for (const item of sdk.getState()?.inventory ?? []) {
                    if (/sword|dagger|axe|shield|tinderbox/i.test(item.name)) continue;
                    await bot.depositItem(new RegExp(`^${item.name}$`, 'i'), -1);
                }
                // Re-withdraw food if any in bank
                const bankItems = sdk.getState()?.bank?.items ?? [];
                for (const item of bankItems.filter((i: any) => FOOD.test(i.name))) {
                    await bot.withdrawItem(item.slot, item.count);
                    await new Promise(r => setTimeout(r, 200));
                }
                await bot.closeBank();
                bankTrips++;
                console.log(`Bank trip ${bankTrips} done. Total kills: ${kills}`);
            }
            await sdk.waitForCondition(() => hpPct(sdk.getState()) >= REGEN_HP, 120_000);
            await enterDungeon(ctx);
            await navigateToDruids(ctx);
            continue;
        }

        console.log(`[Kill ${kills} | STR: ${str} | HP: ${hp} | Inv: ${inv}]`);

        // Wait out combat
        if (state.player.combat?.inCombat) {
            await sdk.waitForCondition(() => !(sdk.getState()?.player?.combat?.inCombat ?? false), 20_000);
            await new Promise(r => setTimeout(r, 300));
        }

        // Attack chaos druid
        try {
            const result = await bot.attackNpc(/^chaos druid$/i);
            if (!result.success) {
                console.log(`No druid: ${result.message}`);
                if (underground) {
                    await bot.walkTo(DRUID_AREA.x, DRUID_AREA.z);
                }
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
        } catch { continue; }

        kills++;
        await new Promise(r => setTimeout(r, 400));

        // Loot valuables
        const ground = await sdk.scanGroundItems(5);
        for (const drop of ground.filter((i: any) => KEEP.test(i.name) && i.distance < 4)) {
            if ((sdk.getState()?.inventory?.length ?? 0) >= 26) break;
            await bot.pickupItem(drop);
        }

        // Bury bones
        for (const bone of ground.filter((i: any) => /^bones$/i.test(i.name) && i.distance < 4)) {
            if ((sdk.getState()?.inventory?.length ?? 0) >= 26) break;
            const r = await bot.pickupItem(bone);
            if (r.success) {
                const b = sdk.getState()?.inventory.find((i: any) => /^bones$/i.test(i.name));
                if (b) { await sdk.sendUseItem(b.slot); await new Promise(r => setTimeout(r, 500)); }
            }
        }

        // Drop junk
        for (const item of sdk.getState()?.inventory ?? []) {
            if (KEEP.test(item.name)) continue;
            if (/sword|dagger|axe|shield|tinderbox/i.test(item.name)) continue;
            await sdk.sendDropItem(item.slot);
            await new Promise(r => setTimeout(r, 150));
        }
    }

}, { timeout: 5 * 60 * 60 * 1000 });
