import { runScript } from '../../sdk/runner';

runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    await bot.walkTo(3092, 3243);
    const result = await bot.openBank();
    if (!result.success) { console.log('Could not open bank'); return; }

    await new Promise(r => setTimeout(r, 600));
    const bank = sdk.getState()?.bank?.items ?? [];
    console.log('Bank contents:');
    for (const item of bank) {
        console.log(`  ${item.name} x${item.count} (slot ${item.slot})`);
    }
    if (bank.length === 0) console.log('  (empty)');

    await sdk.sendClickComponent(786445);
}, { timeout: 60_000 });
