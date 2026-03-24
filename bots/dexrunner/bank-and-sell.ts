import { runScript } from '../../sdk/runner';

// Bank all junk, keep only sword equipped
await runScript(async ({ bot, sdk }) => {
    console.log('=== BANK & CLEAN INVENTORY ===');

    // Walk to Draynor bank
    console.log('Walking to Draynor bank...');
    await bot.walkTo(3092, 3243);

    const result = await bot.openBank();
    if (!result.success) {
        console.log('Bank failed:', result.message);
        return;
    }

    // Deposit everything except equipped items
    const inv = sdk.getState()?.inventory ?? [];
    for (const item of inv) {
        console.log(`Depositing: ${item.name} x${item.count}`);
        await bot.depositItem(new RegExp(`^${item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), -1);
    }

    const bankState = sdk.getState();
    console.log('\nBank contents:');
    for (const item of bankState?.bank?.items ?? []) {
        console.log(`  ${item.name} x${item.count}`);
    }

    await bot.closeBank();
    console.log('\nInventory cleared. Ready to go.');
}, { timeout: 120_000 });
