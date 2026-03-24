import { runScript } from '../../sdk/runner';
import { ChainRunner, cookRun } from '../../sdk/chains';

await runScript(async ({ bot, sdk }) => {
    console.log('=== MACRO: Cook Food ===');
    const state = sdk.getState()!;
    const raw = state.inventory.filter(i => /^raw /i.test(i.name));

    if (raw.length === 0) {
        console.log('No raw food to cook.');
        return;
    }

    console.log(`Cooking ${raw.reduce((a, i) => a + i.count, 0)} raw items`);

    const chain = cookRun({
        rawPattern: /^raw /i,
        rangeX: 3212, rangeZ: 3215, // Lumbridge cooking range
        returnX: state.player!.worldX, returnZ: state.player!.worldZ,
    });

    const runner = new ChainRunner({ bot, sdk, state: () => sdk.getState()! });
    const result = await runner.run(chain);
    console.log(`Cook run: ${result.success ? 'OK' : 'FAILED'}`);
}, { timeout: 5 * 60_000 });
