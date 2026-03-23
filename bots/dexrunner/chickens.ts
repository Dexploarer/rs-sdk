import { runScript } from '../../sdk/runner';

// Lumbridge chicken coop
const CHICKEN_AREA = { x: 3237, z: 3295 };
const DRAYNOR_BANK = { x: 3092, z: 3243 };
const FEATHER_TARGET = 1000;
const STRENGTH_STYLE = 1;

await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // Bank any logs first (on the way)
    const state = sdk.getState();
    const hasLogs = state?.inventory.some(i => /^(oak )?logs$/i.test(i.name));
    if (hasLogs) {
        console.log('Banking logs first at Draynor...');
        await bot.walkTo(DRAYNOR_BANK.x, DRAYNOR_BANK.z);
        const bank = await bot.openBank();
        if (bank.success) {
            await bot.depositItem(/logs/i, -1);
            await bot.closeBank();
        }
    }

    // Walk to chicken area
    console.log('Walking to Lumbridge chicken coop...');
    await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);

    // Set Strength combat style
    console.log('Setting combat style to Strength...');
    await sdk.sendSetCombatStyle(STRENGTH_STYLE);
    await new Promise(r => setTimeout(r, 600));

    let totalFeathers = 0;
    let kills = 0;

    while (totalFeathers < FEATHER_TARGET) {
        const state = sdk.getState();
        if (!state?.player) { await new Promise(r => setTimeout(r, 500)); continue; }

        const strLevel = state.skills.find(s => s.name === 'Strength')?.level ?? 1;
        console.log(`[Kill ${kills} | Feathers: ${totalFeathers}/${FEATHER_TARGET} | STR: ${strLevel}]`);

        // Attack nearest chicken
        try {
            const result = await bot.attackNpc(/^chicken$/i);
            if (!result.success) {
                console.log(`Attack failed: ${result.message}`);
                await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
        } catch (e) {
            console.log('Attack timed out, finding next target...');
            continue;
        }

        kills++;

        // Short wait for drops to appear
        await new Promise(r => setTimeout(r, 400));

        // Scan and loot
        const groundItems = await sdk.scanGroundItems(5);

        // Pick up feathers first
        const feathers = groundItems.filter(i => /^feather$/i.test(i.name) && i.distance < 4);
        for (const f of feathers) {
            const inv = sdk.getState()?.inventory ?? [];
            if (inv.length >= 28) break;
            const result = await bot.pickupItem(f);
            if (result.success) {
                totalFeathers += f.count;
                console.log(`  Picked up ${f.count} feathers (total: ${totalFeathers})`);
            }
        }

        // Pick up and bury bones
        const bones = groundItems.filter(i => /^bones$/i.test(i.name) && i.distance < 4);
        for (const bone of bones) {
            const inv = sdk.getState()?.inventory ?? [];
            if (inv.length >= 28) break;
            const pickup = await bot.pickupItem(bone);
            if (pickup.success && pickup.item) {
                await new Promise(r => setTimeout(r, 200));
                // Re-query bone slot right before burying (inventory may have shifted)
                const freshInv = sdk.getState()?.inventory ?? [];
                const boneInInv = freshInv.find(i => /^bones$/i.test(i.name));
                if (boneInInv) {
                    await sdk.sendUseItem(boneInInv.slot);
                    await new Promise(r => setTimeout(r, 600));
                    console.log('  Buried bones (Prayer XP)');
                }
            }
        }

        // Drop raw chicken (don't need it)
        const rawChicken = sdk.getState()?.inventory.find(i => /^raw chicken$/i.test(i.name));
        if (rawChicken) {
            await sdk.sendDropItem(rawChicken.slot);
            await new Promise(r => setTimeout(r, 200));
        }

        // Reposition if drifted far
        const pos = sdk.getState()?.player;
        if (pos) {
            const dist = Math.sqrt(Math.pow(pos.worldX - CHICKEN_AREA.x, 2) + Math.pow(pos.worldZ - CHICKEN_AREA.z, 2));
            if (dist > 12) {
                console.log('Drifted, repositioning...');
                await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
            }
        }


        // Check if feather target reached
        if (totalFeathers >= FEATHER_TARGET) {
            console.log(`Feather target reached! (${totalFeathers}/${FEATHER_TARGET})`);
            break;
        }
    }

    console.log(`\nDone! ${kills} chickens killed, ${totalFeathers} feathers collected.`);
    const finalState = sdk.getState();
    if (finalState) {
        const str = finalState.skills.find(s => s.name === 'Strength')?.level ?? 1;
        const pray = finalState.skills.find(s => s.name === 'Prayer')?.level ?? 1;
        const hp = finalState.skills.find(s => s.name === 'Hitpoints')?.level ?? 10;
        console.log(`Strength: ${str} | Prayer: ${pray} | HP: ${hp}`);
    }

}, {
    timeout: 2 * 60 * 60 * 1000, // 2 hours
});
