import type { ActionContext } from "../../sdk/micro-actions";
import { runScript } from '../../sdk/runner';
import { ChainRunner, buyGear } from '../../sdk/chains';

await runScript(async ({ bot, sdk }) => {
    console.log('=== MACRO: Buy Gear ===');
    const state = sdk.getState()!;
    const coins = state.inventory.find(i => i.name === 'Coins')?.count ?? 0;
    const atkLevel = state.skills.find(s => s.name === 'Attack')?.level ?? 1;

    console.log(`Gold: ${coins}gp | Attack: ${atkLevel}`);

    // Pick best affordable scimitar
    const scimitars = [
        { name: /^mithril scimitar$/i, cost: 1040, atk: 20 },
        { name: /^steel scimitar$/i, cost: 400, atk: 5 },
        { name: /^iron scimitar$/i, cost: 112, atk: 1 },
        { name: /^bronze scimitar$/i, cost: 32, atk: 1 },
    ];

    const best = scimitars.find(s => coins >= s.cost && atkLevel >= s.atk);
    if (!best) {
        console.log('Cannot afford any scimitar or attack too low.');
        return;
    }

    console.log(`Buying: ${best.name.source} (${best.cost}gp)`);

    const chain = buyGear({
        shopX: 3277, shopZ: 3187, // Zeke's in Al Kharid
        npcPattern: /^zeke$/i,
        items: [{ name: best.name, amount: 1 }],
        equipAfter: true,
    });

    const ctx: ActionContext = { bot, sdk, state: () => sdk.getState()! };
    const runner = new ChainRunner();
    const result = await runner.run(chain, ctx);
    console.log(`Buy gear: ${result.success ? 'OK' : 'FAILED'}`);
}, { timeout: 5 * 60_000 });
