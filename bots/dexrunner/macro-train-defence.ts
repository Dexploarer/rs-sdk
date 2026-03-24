import { runScript } from '../../sdk/runner';
import { ChainRunner, trainCombat } from '../../sdk/chains';
import { trainDefence } from '../../sdk/strategies';

await runScript(async ({ bot, sdk }) => {
    console.log('=== MACRO: Train Defence ===');
    const runner = new ChainRunner({ bot, sdk, state: () => sdk.getState()! });
    const strategy = trainDefence(45);

    while (true) {
        const state = sdk.getState();
        if (!state) { await sdk.waitForTicks(3); continue; }

        const chain = strategy.getNextChain(state);
        if (!chain) {
            console.log('Goal complete!');
            break;
        }

        console.log(`Running chain: ${chain.name}`);
        const result = await runner.run(chain);
        console.log(`Chain ${chain.name}: ${result.success ? 'OK' : 'FAILED'} (${result.stepsCompleted} steps)`);
    }
}, { timeout: 60 * 60_000 });
