import { runScript } from '../../sdk/runner';

const VARROCK_MINE = { x: 3285, z: 3365 };
const VARROCK_BANK = { x: 3253, z: 3420 };
const LUMBRIDGE_FURNACE = { x: 3225, z: 3256 };

const MAX_MINE_RETRIES = 5; // consecutive failures before giving up

function countOre(sdk: any, pattern: RegExp): number {
    const inv = sdk.getState()?.inventory ?? [];
    return inv.filter((i: any) => pattern.test(i.name)).reduce((s: number, i: any) => s + i.count, 0);
}

function emptySlots(sdk: any): number {
    const inv = sdk.getState()?.inventory ?? [];
    return 28 - inv.length;
}

async function mineOre(bot: any, sdk: any, orePattern: RegExp, oreName: string) {
    let consecutiveFailures = 0;

    while (consecutiveFailures < MAX_MINE_RETRIES) {
        const oreCount = countOre(sdk, orePattern);
        const empty = emptySlots(sdk);
        console.log(`${oreName}: ${oreCount}, empty slots: ${empty}`);
        if (oreCount >= 28 || empty === 0) break;

        // Use high-level interactLoc to mine the nearest rock
        const result = await bot.interactLoc(/rocks?/i, 'mine');
        if (!result.success) {
            consecutiveFailures++;
            console.log(`Mine attempt failed (${consecutiveFailures}/${MAX_MINE_RETRIES}): ${result.message}`);
            await new Promise(r => setTimeout(r, 800));
            continue;
        }

        // Wait for ore count to increase (ore appears in inventory when mining succeeds)
        const beforeCount = countOre(sdk, orePattern);
        try {
            await sdk.waitForCondition(() => {
                return countOre(sdk, orePattern) > beforeCount || emptySlots(sdk) === 0;
            }, 8000);
            consecutiveFailures = 0; // reset on success
        } catch {
            consecutiveFailures++;
            console.log(`Ore count didn't increase (${consecutiveFailures}/${MAX_MINE_RETRIES})`);
        }
    }

    if (consecutiveFailures >= MAX_MINE_RETRIES) {
        console.log(`Gave up mining ${oreName} after ${MAX_MINE_RETRIES} consecutive failures`);
    }

    const finalCount = countOre(sdk, orePattern);
    console.log(`Got ${finalCount} ${oreName}`);
    return finalCount;
}

runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // ── Step 1: Mine full inventory of copper ────────────────────────────────
    console.log('Walking to SE Varrock mine...');
    await bot.walkTo(VARROCK_MINE.x, VARROCK_MINE.z);

    console.log('Mining copper...');
    await mineOre(bot, sdk, /^copper ore$/i, 'Copper ore');

    // ── Step 2: Bank copper ──────────────────────────────────────────────────
    console.log('Banking copper at Varrock...');
    await bot.walkTo(VARROCK_BANK.x, VARROCK_BANK.z);
    await bot.openBank();
    await new Promise(r => setTimeout(r, 600));
    await bot.depositItem(/^copper ore$/i, -1);
    await bot.closeBank();
    await new Promise(r => setTimeout(r, 400));

    // Verify deposit after bank is closed
    const copperLeft = countOre(sdk, /^copper ore$/i);
    console.log(`Copper remaining in inventory: ${copperLeft}`);

    // ── Step 3: Mine full inventory of tin ───────────────────────────────────
    console.log('Back to mine for tin...');
    await bot.walkTo(VARROCK_MINE.x, VARROCK_MINE.z);

    console.log('Mining tin...');
    await mineOre(bot, sdk, /^tin ore$/i, 'Tin ore');

    // ── Step 4: Bank tin ─────────────────────────────────────────────────────
    console.log('Banking tin...');
    await bot.walkTo(VARROCK_BANK.x, VARROCK_BANK.z);
    await bot.openBank();
    await new Promise(r => setTimeout(r, 600));
    await bot.depositItem(/^tin ore$/i, -1);

    // ── Step 5: Withdraw 14 copper + 14 tin for smelting ────────────────────
    console.log('Withdrawing 14 copper + 14 tin for smelting...');
    await bot.withdrawItem(/^copper ore$/i, 14);
    await new Promise(r => setTimeout(r, 300));
    await bot.withdrawItem(/^tin ore$/i, 14);
    await new Promise(r => setTimeout(r, 300));
    await bot.closeBank();
    await new Promise(r => setTimeout(r, 400));

    // Read inventory after bank is closed
    const inv = sdk.getState()?.inventory ?? [];
    const c = inv.find((i: any) => /^copper ore$/i.test(i.name))?.count ?? 0;
    const t = inv.find((i: any) => /^tin ore$/i.test(i.name))?.count ?? 0;
    console.log(`Inventory: ${c} copper, ${t} tin — heading to Lumbridge furnace`);

    // ── Step 6: Smelt at Lumbridge furnace ───────────────────────────────────
    await bot.walkTo(3240, 3350);
    await bot.walkTo(LUMBRIDGE_FURNACE.x, LUMBRIDGE_FURNACE.z);
    console.log('Smelting bronze bars...');

    const smeltResult = await bot.interactLoc(/^furnace$/i, 'smelt');
    if (!smeltResult.success) {
        console.log(`interactLoc failed: ${smeltResult.message}, trying useItemOnLoc`);
        const copper2 = sdk.getState()?.inventory?.find((i: any) => /^copper ore$/i.test(i.name));
        if (copper2) await bot.useItemOnLoc(copper2, /^furnace$/i);
    }

    // Wait for smelting to finish
    await sdk.waitForCondition(() => {
        const s = sdk.getState();
        const bars = s?.inventory?.find((i: any) => /^bronze bar$/i.test(i.name))?.count ?? 0;
        return bars >= 14;
    }, 30000);

    const bars = sdk.getState()?.inventory?.find((i: any) => /^bronze bar$/i.test(i.name))?.count ?? 0;
    const smithing = sdk.getState()?.skills?.find((s: any) => /^smithing$/i.test(s.name));
    console.log(`Done! ${bars} bronze bars | Smithing lvl ${smithing?.level} (${smithing?.xp} xp)`);

}, { timeout: 20 * 60 * 1000 });
