import { runScript } from '../../sdk/runner';

// Train Defence on cows using Defensive combat style
// With Attack 40 and Strength 50 we one/two-shot cows
const TARGET_LEVEL = 20;
const DURATION = 30 * 60_000; // 30 minutes
const COW_FIELD = { x: 3253, z: 3290 };
const GATE = { x: 3253, z: 3270 };

await runScript(async ({ bot, sdk }) => {
    console.log('=== TRAIN DEFENCE ON COWS ===');
    console.log(`Target: Defence ${TARGET_LEVEL}`);

    // Set Defensive combat style (style 3)
    await sdk.sendSetCombatStyle(3);
    console.log('Combat style: Defensive');

    // Walk to cow field
    console.log('Walking to cow field...');
    await bot.walkTo(COW_FIELD.x, COW_FIELD.z);

    // Open gate if needed
    const gate = sdk.findNearbyLoc(/^gate$/i);
    if (gate) {
        await bot.openDoor(gate);
        await sdk.waitForTicks(2);
    }

    const startXp = sdk.getSkillXp('defence') ?? 0;
    const startTime = Date.now();
    const endTime = startTime + DURATION;
    let kills = 0;
    let consecutiveFails = 0;

    while (Date.now() < endTime) {
        const state = sdk.getState();
        if (!state) { await sdk.waitForTicks(2); continue; }

        // Check if we hit target
        const defLevel = state.skills.find(s => s.name === 'Defence')?.level ?? 1;
        if (defLevel >= TARGET_LEVEL) {
            console.log(`\nDefence ${defLevel} reached! Target met!`);
            break;
        }

        // Eat food if HP low
        if (state.player && state.player.hp < state.player.maxHp * 0.4) {
            const food = sdk.findInventoryItem(/bread|shrimp|meat|chicken|trout/i);
            if (food) {
                await bot.eatFood(food);
                console.log(`Ate food. HP: ${sdk.getState()?.player?.hp}/${sdk.getState()?.player?.maxHp}`);
            }
        }

        // Pick up bones to bury (free Prayer XP)
        const bones = sdk.findGroundItem(/^bones$/i);
        if (bones && bones.distance < 4) {
            await bot.pickupItem(bones);
            const boneInv = sdk.findInventoryItem(/^bones$/i);
            if (boneInv) {
                await sdk.sendUseItem(boneInv.slot);
                await sdk.waitForTicks(2);
            }
        }

        // Attack a cow
        const cow = sdk.findNearbyNpc(/^cow$/i);
        const result = await bot.attackNpc(cow ?? undefined);

        if (result.success) {
            kills++;
            consecutiveFails = 0;

            if (kills % 10 === 0) {
                const xpNow = sdk.getSkillXp('defence') ?? 0;
                const xpGained = xpNow - startXp;
                const elapsed = (Date.now() - startTime) / 1000 / 60;
                const xpHr = elapsed > 0 ? Math.round(xpGained / elapsed * 60) : 0;
                const lvl = sdk.getState()?.skills.find(s => s.name === 'Defence')?.level ?? 1;
                console.log(`Kills: ${kills} | Def: ${lvl} | XP: +${xpGained} (${xpHr}/hr) | ${elapsed.toFixed(1)}min`);
            }
        } else {
            consecutiveFails++;
            if (consecutiveFails >= 5) {
                console.log('Too many fails, repositioning...');
                await bot.walkTo(COW_FIELD.x, COW_FIELD.z);
                consecutiveFails = 0;
            }
        }
    }

    const finalXp = sdk.getSkillXp('defence') ?? 0;
    const totalXp = finalXp - startXp;
    const elapsed = (Date.now() - startTime) / 1000 / 60;
    const defLevel = sdk.getState()?.skills.find(s => s.name === 'Defence')?.level ?? 1;

    console.log('\n=== RESULTS ===');
    console.log(`Defence: ${defLevel} | XP gained: ${totalXp}`);
    console.log(`Kills: ${kills} | Time: ${elapsed.toFixed(1)} min`);
    console.log(`XP/hr: ${elapsed > 0 ? Math.round(totalXp / elapsed * 60) : 0}`);
}, { timeout: 35 * 60_000 });
