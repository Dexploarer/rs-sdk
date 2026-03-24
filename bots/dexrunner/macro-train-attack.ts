import { runScript } from '../../sdk/runner';
import { ChainRunner } from '../../sdk/chains';
import { trainAttack } from '../../sdk/strategies';

await runScript(async ({ bot, sdk }) => {
    console.log('=== MACRO: Train Attack ===');
    const runner = new ChainRunner({ bot, sdk, state: () => sdk.getState()! });
    const strategy = trainAttack(60);

    while (true) {
        const state = sdk.getState();
        if (!state) { await sdk.waitForTicks(3); continue; }

        const chain = strategy.getNextChain(state);
        if (!chain) { console.log('Goal complete!'); break; }

        console.log(`Running chain: ${chain.name}`);
        const result = await runner.run(chain);
        console.log(`Chain ${chain.name}: ${result.success ? 'OK' : 'FAILED'} (${result.stepsCompleted} steps)`);
    }
}, { timeout: 60 * 60_000 });
