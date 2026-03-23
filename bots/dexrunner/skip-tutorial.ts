import { runScript } from '../../sdk/runner';

await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    console.log('Skipping tutorial...');
    await bot.skipTutorial();
    console.log('Tutorial skipped!');

    const state = sdk.getState();
    if (state) {
        console.log(`Position: ${state.player.worldX}, ${state.player.worldZ}`);
        console.log(`Skills:`, state.skills.map(s => `${s.name}: ${s.level}`).join(', '));
    }
}, {
    timeout: 60_000,
});
