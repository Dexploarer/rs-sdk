import { runScript } from '../../sdk/runner';

await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    const pos = sdk.getState()?.player;
    console.log(`Current position: (${pos?.worldX}, ${pos?.worldZ}) plane: ${pos?.level}`);

    if ((pos?.worldZ ?? 0) > 3520) {
        console.log('IN WILDERNESS! Running south immediately...');
        // Run directly south in stages
        await bot.walkTo(3220, 3500);
        await bot.walkTo(3222, 3400);
        await bot.walkTo(3222, 3300);
        await bot.walkTo(3222, 3218); // Lumbridge
        console.log('Safe!');
    }

    console.log(`Safe position: (${sdk.getState()?.player?.worldX}, ${sdk.getState()?.player?.worldZ})`);
}, { timeout: 120_000 });
