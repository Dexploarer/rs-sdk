import { runScript } from '../../sdk/runner';

await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // Equip sword first
    const sword = sdk.findInventoryItem(/sword|dagger/i);
    if (sword) {
        await bot.equipItem(/sword|dagger/i);
        console.log('Equipped weapon');
    }
    await sdk.sendSetCombatStyle(1); // Strength

    console.log('Killing dwarves for bronze pickaxe...');
    let kills = 0;
    let attackFailures = 0;

    while (true) {
        const state = sdk.getState();
        const hasPick = state?.inventory?.some((i: any) => /pickaxe/i.test(i.name));
        if (hasPick) {
            console.log('Got pickaxe after', kills, 'kills!');
            await bot.equipItem(/pickaxe/i);
            break;
        }

        // Basic HP check - eat food if available and low
        const hpPct = (state?.player?.hp ?? 44) / (state?.player?.maxHp ?? 44);
        if (hpPct < 0.5) {
            const food = sdk.findInventoryItem(/shrimp|bread|meat|trout|salmon/i);
            if (food) {
                await bot.eatFood(food);
                await new Promise(r => setTimeout(r, 400));
            }
        }
        if (hpPct < 0.3) {
            console.log('Low HP, waiting to regen...');
            await sdk.waitForCondition(() => {
                const s = sdk.getState();
                return (s?.player?.hp ?? 0) / (s?.player?.maxHp ?? 1) > 0.7;
            }, 120_000);
            continue;
        }

        if (state?.player?.combat?.inCombat) {
            await sdk.waitForCondition(() => !(sdk.getState()?.player?.combat?.inCombat ?? false), 30000);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        try {
            const result = await bot.attackNpc(/^dwarf$/i);
            if (!result.success) {
                attackFailures++;
                console.log(`Attack failed (${attackFailures}): ${result.message}`);
                if (attackFailures >= 3) {
                    console.log('Too many attack failures, repositioning...');
                    await bot.walkTo(sdk.getState()?.player?.worldX ?? 3000 + 5, sdk.getState()?.player?.worldZ ?? 3000 + 5);
                    attackFailures = 0;
                }
                await new Promise(r => setTimeout(r, 800));
                continue;
            }
            attackFailures = 0;
        } catch { continue; }

        kills++;

        await new Promise(r => setTimeout(r, 600));

        // Pick up any pickaxe drops
        const ground = await sdk.scanGroundItems(5);
        for (const item of ground.filter((i: any) => /pickaxe/i.test(i.name) && i.distance < 5)) {
            console.log('Pickaxe on ground!');
            await bot.pickupItem(item);
        }

        console.log('[Kill ' + kills + ' | HP: ' + (sdk.getState()?.player?.hp) + '/' + (sdk.getState()?.player?.maxHp) + ']');
    }

    const finalState = sdk.getState();
    console.log('Final inventory:', finalState?.inventory?.map((i: any) => i.name + 'x' + i.count).join(', '));

}, { timeout: 60 * 60 * 1000 });
