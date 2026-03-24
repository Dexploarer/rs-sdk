import type { ActionContext } from "../../sdk/micro-actions";
import { runScript } from '../../sdk/runner';
import { ChainRunner, bankRun } from '../../sdk/chains';

await runScript(async ({ bot, sdk }) => {
    console.log('=== MACRO: Bank Run ===');
    const state = sdk.getState()!;
    const px = state.player!.worldX;
    const pz = state.player!.worldZ;

    // Pick nearest safe bank
    const banks = [
        { name: 'Al Kharid', x: 3269, z: 3167, dist: Math.abs(px - 3269) + Math.abs(pz - 3167) },
        { name: 'Varrock West', x: 3185, z: 3436, dist: Math.abs(px - 3185) + Math.abs(pz - 3436) },
    ];
    const nearest = banks.sort((a, b) => a.dist - b.dist)[0];
    console.log(`Nearest bank: ${nearest.name}`);

    const chain = bankRun({
        fromX: px, fromZ: pz,
        bankX: nearest.x, bankZ: nearest.z,
        depositPatterns: [/^raw /i, /^bones$/i, /^feather$/i, /^cowhide$/i],
    });

    const ctx: ActionContext = { bot, sdk, state: () => sdk.getState()! };
    const runner = new ChainRunner();
    const result = await runner.run(chain, ctx);
    console.log(`Bank run: ${result.success ? 'OK' : 'FAILED'}`);
}, { timeout: 5 * 60_000 });
