import { runScript } from '../../sdk/runner';

const DRAYNOR_BANK = { x: 3092, z: 3243 };
const LUMBRIDGE_TREES = { x: 3200, z: 3220 };
const VARROCK_OAKS = { x: 3190, z: 3458 };

const OAK_UNLOCK_LEVEL = 15;
const TARGET_LEVEL = 30;

function getLevel(skills: { name: string; level: number }[], name: string): number {
    return skills.find(s => s.name.toLowerCase() === name.toLowerCase())?.level ?? 1;
}

await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // Step 1: Deposit pickaxe (already at Draynor bank)
    console.log('Depositing pickaxe...');
    const openResult = await bot.openBank();
    if (openResult.success) {
        await bot.depositItem(/pickaxe/i, -1);
        await bot.closeBank();
        console.log('Pickaxe deposited.');
    }

    // Main grind loop
    let nullStateRetries = 0;
    while (true) {
        const state = sdk.getState();
        if (!state) {
            nullStateRetries++;
            if (nullStateRetries >= 10) {
                console.log('Max null state retries reached, exiting.');
                break;
            }
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        nullStateRetries = 0;

        const wcLevel = getLevel(state.skills, 'woodcutting');
        const fmLevel = getLevel(state.skills, 'firemaking');
        console.log(`--- WC: ${wcLevel} | FM: ${fmLevel} ---`);

        if (wcLevel >= TARGET_LEVEL && fmLevel >= TARGET_LEVEL) {
            console.log('Both WC and FM are level 30! Done!');
            break;
        }

        const useOak = wcLevel >= OAK_UNLOCK_LEVEL && fmLevel >= OAK_UNLOCK_LEVEL;
        const treePattern = useOak ? /^oak$/i : /^tree$/i;
        const logPattern = useOak ? /^oak logs$/i : /^logs$/i;
        const treeArea = useOak ? VARROCK_OAKS : LUMBRIDGE_TREES;

        console.log(`Mode: ${useOak ? 'OAK' : 'NORMAL'} trees`);

        // Walk to tree area
        await bot.walkTo(treeArea.x, treeArea.z);

        // Cut trees until inventory full (27 logs + tinderbox)
        console.log('Chopping trees...');
        let chopFailures = 0;
        while (true) {
            const inv = sdk.getState()?.inventory ?? [];
            const emptySlots = 28 - inv.length;
            if (emptySlots === 0) {
                console.log('Inventory full!');
                break;
            }

            const tree = sdk.findNearbyLoc(treePattern);
            const result = await bot.chopTree(tree ?? undefined);
            if (!result.success) {
                chopFailures++;
                console.log(`Chop failed (${chopFailures}/5): ${result.message}`);
                if (chopFailures >= 5) {
                    console.log('Too many chop failures, repositioning...');
                    await bot.walkTo(treeArea.x, treeArea.z);
                    chopFailures = 0;
                }
            } else {
                chopFailures = 0;
            }
        }

        // Burn all logs
        console.log('Burning logs...');
        while (true) {
            const inv = sdk.getState()?.inventory ?? [];
            const hasLogs = inv.some(i => logPattern.test(i.name));
            if (!hasLogs) {
                console.log('All logs burned.');
                break;
            }

            const logs = sdk.findInventoryItem(logPattern);
            const result = await bot.burnLogs(logs ?? undefined);
            if (!result.success) {
                console.log(`Burn failed: ${result.message}`);
                continue;
            }
            console.log(`Burned logs (+${result.xpGained} FM xp)`);
        }
    }

    console.log('Grind complete! Final state:');
    const finalState = sdk.getState();
    if (finalState) {
        const wc = getLevel(finalState.skills, 'woodcutting');
        const fm = getLevel(finalState.skills, 'firemaking');
        console.log(`Woodcutting: ${wc} | Firemaking: ${fm}`);
    }

}, {
    timeout: 3 * 60 * 60 * 1000, // 3 hours
});
