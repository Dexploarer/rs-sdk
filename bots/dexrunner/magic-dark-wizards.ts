import { runScript } from '../../sdk/runner';

const WIND_STRIKE = 1152;
const MAX_CAST_RETRIES = 3;

runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // Withdraw all runes from bank
    await bot.openBank();
    await new Promise(r => setTimeout(r, 600));
    const bank = sdk.getState()?.bank?.items ?? [];
    for (const item of bank.filter((i: any) => /rune/i.test(i.name))) {
        await bot.withdrawItem(item.slot, item.count);
        await new Promise(r => setTimeout(r, 200));
    }
    await bot.closeBank();
    await new Promise(r => setTimeout(r, 400));

    let state = sdk.getState();
    const air = state?.inventory?.find((i: any) => /^air rune$/i.test(i.name))?.count ?? 0;
    const mind = state?.inventory?.find((i: any) => /^mind rune$/i.test(i.name))?.count ?? 0;
    console.log(`Starting with ${air} air, ${mind} mind runes`);

    const endTime = Date.now() + 5 * 60 * 1000;
    let kills = 0;

    while (Date.now() < endTime) {
        state = sdk.getState();
        const airLeft = state?.inventory?.find((i: any) => /^air rune$/i.test(i.name))?.count ?? 0;
        const mindLeft = state?.inventory?.find((i: any) => /^mind rune$/i.test(i.name))?.count ?? 0;

        // Check rune supply
        if (airLeft < 1 || mindLeft < 1) {
            console.log(`Out of runes (${airLeft} air, ${mindLeft} mind) — stopping to restock`);
            break;
        }

        // HP management — eat food if below 50%
        const hp = state?.player?.hp ?? 0;
        const maxHp = state?.player?.maxHp ?? 1;
        if (hp < maxHp * 0.5) {
            const food = sdk.findInventoryItem(/shrimp|trout|salmon|lobster|swordfish|tuna|cake|bread|meat/i);
            if (food) {
                const eatResult = await bot.eatFood(food);
                console.log(`Ate food: ${eatResult.message} (HP was ${hp}/${maxHp})`);
            } else {
                console.log(`LOW HP (${hp}/${maxHp}) and no food — stopping for safety`);
                break;
            }
        }

        const wizard = sdk.findNearbyNpc(/^dark wizard$/i);
        if (!wizard) {
            console.log('No dark wizard nearby, waiting...');
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        // Cast with retry limit
        let castSuccess = false;
        let retries = 0;
        while (retries < MAX_CAST_RETRIES) {
            // Check if NPC still exists before (re)trying
            const currentWizard = sdk.findNearbyNpc(/^dark wizard$/i);
            if (!currentWizard) {
                console.log('Dark wizard disappeared, finding new target...');
                break;
            }

            const result = await bot.castSpellOnNpc(currentWizard, WIND_STRIKE);
            if (result.success) {
                castSuccess = true;
                kills++;
                break;
            } else {
                retries++;
                console.log(`Cast failed (attempt ${retries}/${MAX_CAST_RETRIES}): ${result.message}`);
                if (result.reason === 'no_runes') {
                    console.log('No runes — stopping to restock');
                    break;
                }
                await new Promise(r => setTimeout(r, 600));
            }
        }

        if (castSuccess) {
            // Pick up any rune drops
            await new Promise(r => setTimeout(r, 400));
            const ground = await sdk.scanGroundItems(5);
            for (const drop of (ground ?? []).filter((i: any) => /rune|coins/i.test(i.name) && i.distance < 6)) {
                await bot.pickupItem(drop);
            }
            console.log(`Kill ${kills} | ${airLeft} air, ${mindLeft} mind runes left`);
        }
    }

    state = sdk.getState();
    const magic = state?.skills?.find((s: any) => /^magic$/i.test(s.name));
    const airFinal = state?.inventory?.find((i: any) => /^air rune$/i.test(i.name))?.count ?? 0;
    const mindFinal = state?.inventory?.find((i: any) => /^mind rune$/i.test(i.name))?.count ?? 0;
    console.log(`Done! ${kills} kills | Magic lvl ${magic?.level} (${magic?.xp} xp) | ${airFinal} air, ${mindFinal} mind runes left`);

}, { timeout: 10 * 60 * 1000 });
