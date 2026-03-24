import { runScript } from '../../sdk/runner';
import { ChainRunner } from '../../sdk/chains';
import { trainDefence } from '../../sdk/strategies';

// Full grind: runs the Defence strategy in an infinite loop
// Strategy handles: picking training location, banking when full, cooking food
await runScript(async ({ bot, sdk }) => {
    console.log('=== MACRO: Full Grind (Defence → 45) ===');
    const runner = new ChainRunner({ bot, sdk, state: () => sdk.getState()! });
    const strategy = trainDefence(45);
    let cycles = 0;

    while (true) {
        const state = sdk.getState();
        if (!state) { await sdk.waitForTicks(3); continue; }

        const chain = strategy.getNextChain(state);
        if (!chain) {
            const defLvl = state.skills.find(s => s.name === 'Defence')?.level ?? 0;
            console.log(`\nGOAL COMPLETE! Defence: ${defLvl}`);
            break;
        }

        cycles++;
        const result = await runner.run(chain);

        if (cycles % 5 === 0) {
            const s = sdk.getState()!;
            const skills = s.skills.filter(sk => sk.experience > 0);
            console.log(`\n--- Cycle ${cycles} ---`);
            skills.forEach(sk => console.log(`  ${sk.name}: ${sk.level} (${sk.experience} xp)`));
            console.log(`  HP: ${s.player?.hp}/${s.player?.maxHp} | Inv: ${s.inventory.length}/28`);
        }
    }
}, { timeout: 4 * 60 * 60_000 }); // 4 hour max
