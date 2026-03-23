import { runScript } from '../../sdk/runner';

// Al Kharid scimitar shop (Zeke's)
const AL_KHARID_TOLL = { x: 3268, z: 3228 };
const ZEKE_SHOP = { x: 3287, z: 3186 };

// Edgeville dungeon entrance area (trapdoor south of Edgeville)
const EDGEVILLE_DUNGEON_ENTRANCE = { x: 3097, z: 3468 };

// Strength style = 1, Attack style = 0, Never attack after 40
const STRENGTH_STYLE = 1;
const ATTACK_STYLE = 0;
const ATK_CAP = 40;
const STR_TARGET = 70;

const MAX_CONSECUTIVE_FAILURES = 5;
const HP_EAT_THRESHOLD = 0.4; // Eat when HP drops below 40%
const MAX_SCIMITAR_ATTEMPTS = 3;

function getLevel(skills: any[], name: string): number {
    return skills.find((s: any) => s.name.toLowerCase() === name.toLowerCase())?.level ?? 1;
}

/** Check HP and eat food if below threshold */
async function checkAndEatFood(bot: any, sdk: any): Promise<void> {
    const state = sdk.getState();
    if (!state?.player) return;
    const { hp, maxHp } = state.player;
    if (hp < maxHp * HP_EAT_THRESHOLD) {
        const food = state.inventory.find((i: any) =>
            /trout|salmon|tuna|lobster|swordfish|shark|shrimp|meat|bread|cake|pie/i.test(i.name)
        );
        if (food) {
            console.log(`HP low (${hp}/${maxHp}), eating ${food.name}...`);
            await bot.eatFood(new RegExp(food.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        }
    }
}

async function buyScimitar(ctx: any) {
    const { bot, sdk } = ctx;
    const state = sdk.getState();
    const coins = state?.inventory.find((i: any) => /^coins$/i.test(i.name))?.count ?? 0;

    // Pick best affordable scimitar
    const target = coins >= 1040 ? /mithril scimitar/i
        : coins >= 400 ? /steel scimitar/i
        : coins >= 112 ? /iron scimitar/i
        : /bronze scimitar/i;

    console.log(`Buying scimitar with ${coins} coins...`);

    // Pay toll if needed
    const pos = state?.player;
    if (pos && pos.worldX < 3267) {
        console.log('Paying Al Kharid toll...');
        await bot.walkTo(AL_KHARID_TOLL.x, AL_KHARID_TOLL.z);
        const toll = sdk.getState()?.nearbyNpcs.find((n: any) => /toll/i.test(n.name) || /gate/i.test(n.name));
        if (toll) await bot.talkTo(toll);
        await new Promise(r => setTimeout(r, 1000));
    }

    await bot.walkTo(ZEKE_SHOP.x, ZEKE_SHOP.z);

    let bought = false;
    for (let attempt = 0; attempt < MAX_SCIMITAR_ATTEMPTS; attempt++) {
        const shopResult = await bot.openShop(/zeke/i);
        if (!shopResult.success) {
            console.log(`Failed to open shop (attempt ${attempt + 1}/${MAX_SCIMITAR_ATTEMPTS}): ${shopResult.message}`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }
        const buyResult = await bot.buyFromShop(target, 1);
        await bot.closeShop();
        if (buyResult.success) {
            bought = true;
            break;
        }
        console.log(`Failed to buy scimitar (attempt ${attempt + 1}/${MAX_SCIMITAR_ATTEMPTS}): ${buyResult.message}`);
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!bought) {
        console.log('Could not buy scimitar after max attempts, continuing without one.');
        return;
    }

    // Equip it
    const scimitar = sdk.findInventoryItem(target);
    if (scimitar) {
        await bot.equipItem(target);
        console.log('Scimitar equipped!');
    }
}

await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // Walk to Edgeville dungeon entrance
    console.log('Walking to Edgeville dungeon area...');
    await bot.walkTo(EDGEVILLE_DUNGEON_ENTRANCE.x, EDGEVILLE_DUNGEON_ENTRANCE.z);

    // Scan for dungeon entrance (trapdoor / ladder / cave entrance)
    const state = sdk.getState();
    console.log('Nearby locs:', state?.nearbyLocs.map((l: any) => `${l.name} @ (${l.x},${l.z})`).join(', '));

    // Try to find and enter dungeon
    const entrance = state?.nearbyLocs.find((l: any) =>
        /trapdoor|ladder|cave|dungeon|entrance/i.test(l.name) &&
        l.options.some((o: any) => /open|enter|climb|descend/i.test(o))
    );

    if (entrance) {
        console.log(`Found entrance: ${entrance.name} @ (${entrance.x}, ${entrance.z}) options: ${entrance.options.join(', ')}`);

        // Step 1: Open the trapdoor if needed
        if (entrance.options.some((o: any) => /^open$/i.test(o))) {
            console.log('Opening trapdoor...');
            await bot.interactLoc(entrance, /^open$/i);
            await new Promise(r => setTimeout(r, 1200));
        }

        // Step 2: Climb down
        const state2 = sdk.getState();
        const trapdoor = state2?.nearbyLocs.find((l: any) => /trapdoor/i.test(l.name));
        if (trapdoor) {
            console.log(`Trapdoor options now: ${trapdoor.options.join(', ')}`);
            const climbOpt = trapdoor.options.find((o: any) => /climb|descend|down/i.test(o));
            if (climbOpt) {
                console.log(`Climbing down...`);
                await bot.interactLoc(trapdoor, new RegExp(climbOpt, 'i'));
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // Validate position after dungeon entry
        const afterPos = sdk.getState()?.player;
        console.log(`After entry: pos (${afterPos?.worldX}, ${afterPos?.worldZ}) plane: ${afterPos?.level}`);

        // If we're still on the surface (plane 0 and near entrance), entry may have failed
        if (afterPos && afterPos.level === 0 &&
            Math.abs(afterPos.worldX - EDGEVILLE_DUNGEON_ENTRANCE.x) < 10 &&
            Math.abs(afterPos.worldZ - EDGEVILLE_DUNGEON_ENTRANCE.z) < 10) {
            console.log('WARNING: May still be on surface after dungeon entry attempt. Retrying...');
            const retryEntrance = sdk.getState()?.nearbyLocs.find((l: any) =>
                /trapdoor/i.test(l.name) &&
                l.options.some((o: any) => /climb|descend|down/i.test(o))
            );
            if (retryEntrance) {
                const climbOpt = retryEntrance.options.find((o: any) => /climb|descend|down/i.test(o));
                if (climbOpt) {
                    await bot.interactLoc(retryEntrance, new RegExp(climbOpt, 'i'));
                    await new Promise(r => setTimeout(r, 2000));
                    const retryPos = sdk.getState()?.player;
                    console.log(`Retry entry: pos (${retryPos?.worldX}, ${retryPos?.worldZ}) plane: ${retryPos?.level}`);
                }
            }
        }
    } else {
        console.log('No dungeon entrance found nearby. Scanning for giants on surface...');
    }

    // Set strength style
    await sdk.sendSetCombatStyle(STRENGTH_STYLE);
    await new Promise(r => setTimeout(r, 300));
    console.log('Combat style set to Strength');

    let coinsCollected = 0;
    let boughtScimitar = false;
    let consecutiveFailures = 0;

    while (true) {
        const state = sdk.getState();
        if (!state?.player) { await new Promise(r => setTimeout(r, 500)); continue; }

        // Check HP and eat food if needed
        await checkAndEatFood(bot, sdk);

        const strLevel = getLevel(state.skills, 'Strength');
        const atkLevel = getLevel(state.skills, 'Attack');
        const coins = state.inventory.find((i: any) => /^coins$/i.test(i.name))?.count ?? 0;

        console.log(`[STR: ${strLevel}/70 | ATK: ${atkLevel} | Coins: ${coins}]`);

        // Check STR target
        if (strLevel >= STR_TARGET) {
            console.log('STR 70 reached!');
            break;
        }

        // Buy scimitar once we have enough coins
        if (!boughtScimitar && coins >= 32) {
            const hasScimitar = state.equipment.some((i: any) => /scimitar/i.test(i.name)) ||
                state.inventory.some((i: any) => /scimitar/i.test(i.name));
            if (!hasScimitar) {
                await buyScimitar(ctx);
                boughtScimitar = true;
                // Walk back to dungeon after buying
                await bot.walkTo(EDGEVILLE_DUNGEON_ENTRANCE.x, EDGEVILLE_DUNGEON_ENTRANCE.z);
                // Re-enter dungeon if needed
                const nearEntrance = sdk.getState()?.nearbyLocs.find((l: any) =>
                    /trapdoor|ladder|cave|dungeon/i.test(l.name)
                );
                if (nearEntrance) {
                    const enterOpt = nearEntrance.options.find((o: any) => /open|enter|climb|descend/i.test(o));
                    if (enterOpt) {
                        await bot.interactLoc(nearEntrance, new RegExp(enterOpt, 'i'));
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
                await sdk.sendSetCombatStyle(STRENGTH_STYLE);
                consecutiveFailures = 0;
            }
        }

        // Wait out combat if needed
        if (state.player.combat?.inCombat) {
            await sdk.waitForCondition(() => !(sdk.getState()?.player?.combat?.inCombat ?? false), 20000);
            await new Promise(r => setTimeout(r, 300));
            // Check HP after combat
            await checkAndEatFood(bot, sdk);
        }

        // Attack nearest giant
        try {
            const result = await bot.attackNpc(/^giant$/i);
            if (!result.success) {
                consecutiveFailures++;
                console.log(`No giant found (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${result.message} — scanning area...`);
                await sdk.scanNearbyLocs(15);
                await new Promise(r => setTimeout(r, 1500));

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    console.log('Too many failures, repositioning...');
                    // Walk slightly away and back to reset position
                    const curState = sdk.getState();
                    if (curState?.player) {
                        await bot.walkTo(curState.player.worldX + 5, curState.player.worldZ + 3, 2);
                        await new Promise(r => setTimeout(r, 1000));
                        await bot.walkTo(curState.player.worldX - 5, curState.player.worldZ - 3, 2);
                    }
                    consecutiveFailures = 0;
                }
                continue;
            }
            consecutiveFailures = 0;
        } catch {
            consecutiveFailures++;
            console.log(`Attack timed out (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.log('Too many timeouts, repositioning...');
                const curState = sdk.getState();
                if (curState?.player) {
                    await bot.walkTo(curState.player.worldX + 5, curState.player.worldZ + 3, 2);
                    await new Promise(r => setTimeout(r, 1000));
                }
                consecutiveFailures = 0;
            }
            continue;
        }

        // Wait for drops
        await new Promise(r => setTimeout(r, 400));

        // Loot coins and big bones
        const ground = await sdk.scanGroundItems(5);
        const coinDrop = ground.filter((i: any) => /^coins$/i.test(i.name) && i.distance < 4);
        for (const c of coinDrop) {
            const inv = sdk.getState()?.inventory ?? [];
            if (inv.length >= 28) break;
            const r = await bot.pickupItem(c);
            if (r.success) coinsCollected += c.count;
        }

        // Pick up and bury big bones
        const bones = ground.filter((i: any) => /^big bones$/i.test(i.name) && i.distance < 4);
        for (const bone of bones) {
            const inv = sdk.getState()?.inventory ?? [];
            if (inv.length >= 28) break;
            const r = await bot.pickupItem(bone);
            if (r.success && r.item) {
                const boneInInv = sdk.getState()?.inventory.find((i: any) => /^big bones$/i.test(i.name));
                if (boneInInv) {
                    await sdk.sendUseItem(boneInInv.slot);
                    await new Promise(r => setTimeout(r, 600));
                    console.log('  Buried big bones');
                }
            }
        }

        // Drop everything else except coins, scimitar, tinderbox, food
        const inv = sdk.getState()?.inventory ?? [];
        for (const item of inv) {
            if (/^coins$|^scimitar$|^tinderbox$/i.test(item.name)) continue;
            // Keep food items
            if (/trout|salmon|tuna|lobster|swordfish|shark|shrimp|meat|bread|cake|pie/i.test(item.name)) continue;
            // Keep scimitars with prefix (e.g. "iron scimitar")
            if (/scimitar/i.test(item.name)) continue;
            await sdk.sendDropItem(item.slot);
            await new Promise(r => setTimeout(r, 150));
        }
    }

    console.log(`\nSTR 70 done! Total coins collected: ${coinsCollected}`);
    console.log('Now buying best scimitar and heading to Moss Giants for ATK 40...');

    // Buy scimitar for moss giants phase
    await buyScimitar(ctx);

    // Walk back toward moss giant area (Varrock sewers / Crandor)
    // Moss giants at m39_53 ≈ (2496, 3392) Rimmington area or (3140, 3380) Varrock sewers
    console.log('Walking to Moss Giants (Varrock sewers area)...');
    await bot.walkTo(3140, 3380);

    // Set Attack style for ATK to 40, then never again
    await sdk.sendSetCombatStyle(ATTACK_STYLE);
    console.log('Attack style ON — training ATK to 40');

    let mossFailures = 0;

    while (true) {
        const state = sdk.getState();
        if (!state?.player) { await new Promise(r => setTimeout(r, 500)); continue; }

        // Check HP and eat food if needed
        await checkAndEatFood(bot, sdk);

        const atkLevel = getLevel(state.skills, 'Attack');
        const strLevel = getLevel(state.skills, 'Strength');
        console.log(`[ATK: ${atkLevel}/40 | STR: ${strLevel}]`);

        if (atkLevel >= ATK_CAP) {
            // IMMEDIATELY switch off attack, never again
            await sdk.sendSetCombatStyle(STRENGTH_STYLE);
            console.log('ATK 40 reached. Switched to Strength. NEVER using Attack style again.');
            break;
        }

        if (state.player.combat?.inCombat) {
            await sdk.waitForCondition(() => !(sdk.getState()?.player?.combat?.inCombat ?? false), 25000);
            await new Promise(r => setTimeout(r, 300));
            await checkAndEatFood(bot, sdk);
        }

        try {
            const result = await bot.attackNpc(/^moss giant$/i);
            if (!result.success) {
                mossFailures++;
                console.log(`Moss giant not found (${mossFailures}/${MAX_CONSECUTIVE_FAILURES}): ${result.message}`);
                await new Promise(r => setTimeout(r, 1500));

                if (mossFailures >= MAX_CONSECUTIVE_FAILURES) {
                    console.log('Too many failures finding moss giants, repositioning...');
                    const curState = sdk.getState();
                    if (curState?.player) {
                        await bot.walkTo(curState.player.worldX + 5, curState.player.worldZ + 3, 2);
                        await new Promise(r => setTimeout(r, 1000));
                        await bot.walkTo(curState.player.worldX - 5, curState.player.worldZ - 3, 2);
                    }
                    mossFailures = 0;
                }
                continue;
            }
            mossFailures = 0;
        } catch {
            mossFailures++;
            console.log(`Moss giant attack timed out (${mossFailures}/${MAX_CONSECUTIVE_FAILURES})`);
            if (mossFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.log('Too many timeouts, repositioning...');
                const curState = sdk.getState();
                if (curState?.player) {
                    await bot.walkTo(curState.player.worldX + 5, curState.player.worldZ + 3, 2);
                    await new Promise(r => setTimeout(r, 1000));
                }
                mossFailures = 0;
            }
            continue;
        }

        // Bury big bones
        await new Promise(r => setTimeout(r, 400));
        const ground = await sdk.scanGroundItems(5);
        const bigBones = ground.filter((i: any) => /^big bones$/i.test(i.name) && i.distance < 4);
        for (const bone of bigBones) {
            const inv = sdk.getState()?.inventory ?? [];
            if (inv.length >= 28) break;
            const r = await bot.pickupItem(bone);
            if (r.success) {
                const b = sdk.getState()?.inventory.find((i: any) => /^big bones$/i.test(i.name));
                if (b) { await sdk.sendUseItem(b.slot); await new Promise(r => setTimeout(r, 600)); }
            }
        }
    }

    console.log('All done! ATK 40 locked in, Strength mode forever.');

}, {
    timeout: 5 * 60 * 60 * 1000,
});
