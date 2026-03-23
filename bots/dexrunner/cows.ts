import { runScript } from '../../sdk/runner';

const COW_AREA = { x: 3253, z: 3290 };
const COW_GATE = { x: 3253, z: 3272 };
const DRAYNOR_BANK = { x: 3092, z: 3243 };

function insideCowPen(x: number, z: number): boolean {
    return x >= 3242 && x <= 3265 && z >= 3255 && z <= 3298;
}

async function enterCowPen(ctx: any) {
    const { bot, sdk } = ctx;

    if (insideCowPen(sdk.getState()?.player?.worldX ?? 0, sdk.getState()?.player?.worldZ ?? 0)) return;

    // Walk to gate area
    await bot.walkTo(COW_GATE.x, COW_GATE.z - 2);

    // Open gate if visible
    const state = sdk.getState();
    const gate = state?.nearbyLocs.find((l: any) => /gate/i.test(l.name));
    if (gate) {
        console.log('Opening gate...');
        const gateResult = await bot.openDoor(gate);
        if (!gateResult.success && gateResult.reason !== 'already_open') {
            console.log(`Gate failed: ${gateResult.message}, retrying...`);
            await new Promise(r => setTimeout(r, 600));
            await bot.openDoor(gate);
        }
        await new Promise(r => setTimeout(r, 600));
    }

    // Walk into pen
    await bot.walkTo(COW_AREA.x, COW_AREA.z);
}

await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    let totalHides = 0;
    let trips = 0;

    while (true) {
        console.log(`[Trip ${trips + 1} | Hides banked: ${totalHides}] Walking to cow pen...`);
        await enterCowPen(ctx);

        // Kill cows and collect hides until inventory full
        while (true) {
            const inv = sdk.getState()?.inventory ?? [];
            if (inv.length >= 27) {
                console.log('Inventory full, heading to bank...');
                break;
            }

            // Only wait for combat end if actually in combat
            const combatState = sdk.getState()?.player?.combat;
            if (combatState && combatState.inCombat) {
                await sdk.waitForCondition(() => !(sdk.getState()?.player?.combat?.inCombat ?? false), 15000);
                await new Promise(r => setTimeout(r, 300));
            }

            // Attack a cow
            try {
                const result = await bot.attackNpc(/^cow$/i);
                if (!result.success) {
                    console.log(`Attack failed: ${result.message}`);
                    const pos = sdk.getState()?.player;
                    if (!pos || !insideCowPen(pos.worldX, pos.worldZ)) {
                        await enterCowPen(ctx);
                    }
                    await new Promise(r => setTimeout(r, 600));
                    continue;
                }
            } catch {
                console.log('Attack timed out, retrying...');
                continue;
            }

            // Wait for drops
            await new Promise(r => setTimeout(r, 400));

            // Scan and loot cowhide
            const ground = await sdk.scanGroundItems(5);
            const hides = ground.filter(i => /^cowhide$/i.test(i.name) && i.distance < 4);
            for (const hide of hides) {
                const inv = sdk.getState()?.inventory ?? [];
                if (inv.length >= 27) break;
                const r = await bot.pickupItem(hide);
                if (r.success) console.log(`  Picked up cowhide (inv: ${(sdk.getState()?.inventory ?? []).length}/28)`);
            }

            // Drop bones only when inventory is nearly full
            const currentInv = sdk.getState()?.inventory ?? [];
            if (currentInv.length >= 25) {
                const bones = currentInv.filter(i => /^bones$/i.test(i.name));
                for (const bone of bones) {
                    await sdk.sendDropItem(bone.slot);
                    await new Promise(r => setTimeout(r, 150));
                }
            }

            // Reposition if drifted outside pen
            const pos = sdk.getState()?.player;
            if (pos && !insideCowPen(pos.worldX, pos.worldZ)) {
                console.log('Outside pen, walking back...');
                await bot.walkTo(COW_AREA.x, COW_AREA.z);
            }
        }

        // Bank at Draynor
        const hideCount = (sdk.getState()?.inventory ?? []).filter(i => /^cowhide$/i.test(i.name)).length;
        console.log(`Banking ${hideCount} cowhides at Draynor...`);
        await bot.walkTo(DRAYNOR_BANK.x, DRAYNOR_BANK.z);

        const bank = await bot.openBank();
        if (bank.success) {
            await bot.depositItem(/^cowhide$/i, -1);
            await bot.closeBank();
            totalHides += hideCount;
            trips++;  // Only increment on successful bank
            console.log(`Banked! Total hides: ${totalHides}`);
        } else {
            console.log(`Bank failed: ${bank.message}, will retry next loop`);
        }
    }

}, {
    timeout: 3 * 60 * 60 * 1000,
});
