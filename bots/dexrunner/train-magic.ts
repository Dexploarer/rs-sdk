import { runScript } from '../../sdk/runner';

const WIND_STRIKE = 1152;

const DRAYNOR_BANK = { x: 3092, z: 3243 };
const AUBURY = { x: 3253, z: 3401 };
const CHICKEN_AREA = { x: 3232, z: 3291 };

const RUNE_BUY = 500;

runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // ── 1. Escape wilderness if needed ──────────────────────────────────────
    let state = sdk.getState();
    const pos = state?.player;
    if (pos && pos.worldZ > 3520) {
        console.log(`In wilderness at (${pos.worldX}, ${pos.worldZ}) – running south...`);
        await bot.walkTo(3220, 3500);
        await bot.walkTo(3200, 3400);
        await bot.walkTo(3200, 3300);
        console.log('Escaped wilderness.');
    }

    // ── 2. Walk to Draynor bank and withdraw coins ───────────────────────────
    state = sdk.getState();
    let coins = state?.inventory?.find((i: any) => /^coins$/i.test(i.name))?.count ?? 0;
    console.log(`Coins in inventory: ${coins}`);

    if (coins < 5000) {
        console.log('Heading to Draynor bank...');
        await bot.walkTo(3150, 3270);
        await bot.walkTo(DRAYNOR_BANK.x, DRAYNOR_BANK.z);

        const bankResult = await bot.openBank();
        if (bankResult.success) {
            await new Promise(r => setTimeout(r, 600));
            const bankCoins = sdk.getState()?.bank?.items?.find((i: any) => /^coins$/i.test(i.name));
            if (bankCoins) {
                console.log(`Withdrawing ${bankCoins.count} coins from bank...`);
                await bot.withdrawItem(bankCoins.slot, bankCoins.count);
                await new Promise(r => setTimeout(r, 500));
            } else {
                console.log('No coins in bank either — skipping rune purchase.');
            }
            await bot.closeBank();
            await new Promise(r => setTimeout(r, 400));
        }

        coins = sdk.getState()?.inventory?.find((i: any) => /^coins$/i.test(i.name))?.count ?? 0;
        console.log(`Coins after bank: ${coins}`);
    }

    // ── 3. Buy runes from Aubury if we need them ─────────────────────────────
    state = sdk.getState();
    let airCount = state?.inventory?.find((i: any) => /^air rune$/i.test(i.name))?.count ?? 0;
    let mindCount = state?.inventory?.find((i: any) => /^mind rune$/i.test(i.name))?.count ?? 0;
    console.log(`Runes: ${airCount} air, ${mindCount} mind`);

    if ((airCount < 100 || mindCount < 100) && coins >= 3000) {
        console.log('Walking to Aubury rune shop in Varrock...');
        await bot.walkTo(3200, 3350);
        await bot.walkTo(AUBURY.x, AUBURY.z);

        let aubury = sdk.findNearbyNpc(/^aubury$/i);
        if (!aubury) {
            await bot.walkTo(3253, 3406);
            aubury = sdk.findNearbyNpc(/^aubury$/i);
        }

        if (aubury) {
            const shopResult = await bot.openShop(aubury);
            await new Promise(r => setTimeout(r, 800));

            if (!shopResult.success) {
                console.log(`Shop failed: ${shopResult.message}`);
            }

            if (shopResult.success && airCount < 100) {
                await bot.buyFromShop(/^air rune$/i, RUNE_BUY);
                await new Promise(r => setTimeout(r, 400));
            }
            if (shopResult.success && mindCount < 100) {
                await bot.buyFromShop(/^mind rune$/i, RUNE_BUY);
                await new Promise(r => setTimeout(r, 400));
            }

            if (shopResult.success) await bot.closeShop();
            await new Promise(r => setTimeout(r, 400));
        } else {
            console.log('Could not find Aubury — will try to cast with whatever runes we have.');
        }

        state = sdk.getState();
        airCount = state?.inventory?.find((i: any) => /^air rune$/i.test(i.name))?.count ?? 0;
        mindCount = state?.inventory?.find((i: any) => /^mind rune$/i.test(i.name))?.count ?? 0;
        console.log(`After shop: ${airCount} air, ${mindCount} mind runes`);
    }

    if (airCount < 1 || mindCount < 1) {
        console.log('No runes available, cannot train magic. Exiting.');
        return;
    }

    // ── 4. Walk to chickens and train ────────────────────────────────────────
    console.log('Walking to Lumbridge chickens...');
    await bot.walkTo(3230, 3291);

    const endTime = Date.now() + 10 * 60 * 1000; // 10 min run
    let casts = 0;

    console.log('Starting Wind Strike training...');
    while (Date.now() < endTime) {
        state = sdk.getState();

        const air = state?.inventory?.find((i: any) => /^air rune$/i.test(i.name))?.count ?? 0;
        const mind = state?.inventory?.find((i: any) => /^mind rune$/i.test(i.name))?.count ?? 0;
        if (air < 1 || mind < 1) {
            console.log('Out of runes!');
            break;
        }

        const chicken = sdk.findNearbyNpc(/^chicken$/i);
        if (!chicken) {
            await new Promise(r => setTimeout(r, 800));
            continue;
        }

        // HP check - eat food if low (chickens are weak but just in case)
        if (state?.player && state.player.hp < state.player.maxHp * 0.4) {
            const food = sdk.findInventoryItem(/shrimp|bread|meat|trout|salmon/i);
            if (food) {
                await bot.eatFood(food);
                await new Promise(r => setTimeout(r, 400));
            }
        }

        const result = await bot.castSpellOnNpc(chicken, WIND_STRIKE);
        if (result.success) {
            casts++;
            if (casts % 20 === 0) {
                const magic = sdk.getState()?.skills?.find((s: any) => /^magic$/i.test(s.name));
                console.log(`[${casts} casts] Magic lvl ${magic?.level} (${magic?.xp} xp) | runes left: ${air} air, ${mind} mind`);
            }
        } else {
            console.log(`Cast failed: ${result.message}`);
            await new Promise(r => setTimeout(r, 500));
        }

        await new Promise(r => setTimeout(r, 200));
    }

    const magic = sdk.getState()?.skills?.find((s: any) => /^magic$/i.test(s.name));
    console.log(`Done! ${casts} casts. Magic: lvl ${magic?.level} (${magic?.xp} xp)`);

}, { timeout: 30 * 60 * 1000 });
