import { runScript } from '../../sdk/runner';
import { ChainRunner } from '../../sdk/chains';
import { trainDefence } from '../../sdk/strategies';
import type { ActionContext } from '../../sdk/micro-actions';

await runScript(async ({ bot, sdk }) => {
    console.log('=== MACRO: Train Defence ===');
    const ctx: ActionContext = { bot, sdk, state: () => sdk.getState()! };
    const runner = new ChainRunner();
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
        const result = await runner.run(chain, ctx);
        console.log(`Chain ${chain.name}: ${result.success ? 'OK' : 'FAILED'} (${result.stepsCompleted} steps)`);
    }
}, { timeout: 60 * 60_000 });
