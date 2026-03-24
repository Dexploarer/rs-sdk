import { runScript } from '../../sdk/runner';

// Pickpocket men in Lumbridge for starting gold
// Target: 500gp (enough for bronze chainbody + food)
const TARGET_GOLD = 500;
const DURATION = 5 * 60_000; // 5 minutes

await runScript(async ({ bot, sdk }) => {
    console.log(`=== PICKPOCKET MEN FOR ${TARGET_GOLD}gp ===`);

    // Walk to Lumbridge center where men walk around
    await bot.walkTo(3222, 3222);

    const endTime = Date.now() + DURATION;
    let attempts = 0;
    let successes = 0;
    let fails = 0;

    while (Date.now() < endTime) {
        const state = sdk.getState();
        if (!state) { await sdk.waitForTicks(2); continue; }

        // Check if we have enough gold
        const coins = state.inventory.find(i => /^coins$/i.test(i.name));
        const gold = coins?.count ?? 0;
        if (gold >= TARGET_GOLD) {
            console.log(`\nReached ${gold}gp! Target met.`);
            break;
        }

        // Find a man to pickpocket
        const man = sdk.findNearbyNpc(/^man$/i);
        if (!man) {
            console.log('No man nearby, repositioning...');
            await bot.walkTo(3222, 3222);
            await sdk.waitForTicks(3);
            continue;
        }

        attempts++;
        const result = await bot.pickpocketNpc(man);

        if (result.success) {
            successes++;
            if (successes % 10 === 0) {
                const nowCoins = sdk.getState()?.inventory.find(i => /^coins$/i.test(i.name));
                console.log(`Pickpocket ${successes}/${attempts} | Gold: ${nowCoins?.count ?? 0}gp`);
            }
        } else {
            fails++;
            // Stunned — wait a moment
            await sdk.waitForTicks(5);
        }
    }

    const finalCoins = sdk.getState()?.inventory.find(i => /^coins$/i.test(i.name));
    console.log(`\n=== DONE ===`);
    console.log(`Attempts: ${attempts} | Success: ${successes} | Fails: ${fails}`);
    console.log(`Gold: ${finalCoins?.count ?? 0}gp`);
    console.log(`Thieving XP gained: ${sdk.getSkillXp('thieving')} xp`);
}, { timeout: 6 * 60_000 });
