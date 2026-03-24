import { runScript } from '../../sdk/runner';
import { encode } from '@toon-format/toon';

// Fast chicken farming: kill, loot raw chicken + bones, bury bones
// When inventory full: cook at range, eat or bank
// Uses low-level SDK for speed since we one-shot chickens

const CHICKEN_AREA = { x: 3237, z: 3295 };
const RANGE = { x: 3211, z: 3215 }; // Lumbridge cooking range
const DURATION = 10 * 60_000;

await runScript(async ({ bot, sdk }) => {
    // Ensure Defensive style
    await sdk.sendSetCombatStyle(3);

    const startDef = sdk.getSkillXp('defence') ?? 0;
    const startPrayer = sdk.getSkillXp('prayer') ?? 0;
    const startTime = Date.now();
    let kills = 0, bonesBuried = 0, chickenLooted = 0;

    console.log('=== CHICKEN FARM (Defence + Food) ===');
    await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);

    const endTime = startTime + DURATION;

    while (Date.now() < endTime) {
        const s = sdk.getState();
        if (!s?.player) { await sdk.waitForTicks(1); continue; }

        // Skip if in combat — we're probably already killing something
        if (s.player.combat.inCombat) {
            await sdk.waitForTicks(2);
            continue;
        }

        // LOOT PHASE: grab ground items quickly
        const groundChicken = sdk.findGroundItem(/^raw chicken$/i);
        if (groundChicken && groundChicken.distance < 5) {
            await bot.pickupItem(groundChicken);
            chickenLooted++;
        }

        const groundBones = sdk.findGroundItem(/^bones$/i);
        if (groundBones && groundBones.distance < 4) {
            await bot.pickupItem(groundBones);
            // Bury immediately
            const bone = sdk.findInventoryItem(/^bones$/i);
            if (bone) {
                await sdk.sendUseItem(bone.slot);
                bonesBuried++;
                await sdk.waitForTicks(1);
            }
        }

        // INVENTORY CHECK: if full, go cook
        const inv = s.inventory;
        const emptySlots = 28 - inv.length;
        if (emptySlots <= 1) {
            const rawCount = inv.filter(i => /raw chicken/i.test(i.name)).reduce((a, i) => a + i.count, 0);
            if (rawCount > 0) {
                console.log(`Inventory full (${rawCount} raw chicken). Cooking...`);
                await bot.walkTo(RANGE.x, RANGE.z);

                // Cook all raw chicken
                let cooked = 0;
                for (let c = 0; c < 28; c++) {
                    const raw = sdk.findInventoryItem(/^raw chicken$/i);
                    if (!raw) break;
                    const range = sdk.findNearbyLoc(/^range$/i);
                    if (!range) { console.log('No range found!'); break; }
                    const r = await bot.useItemOnLoc(raw, range);
                    if (r.success) cooked++;
                }
                console.log(`Cooked ${cooked} chicken. Walking back...`);
                await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
            } else {
                // Drop junk feathers to make room
                const feathers = sdk.findInventoryItem(/^feather$/i);
                if (feathers) await sdk.sendDropItem(feathers.slot);
            }
            continue;
        }

        // KILL PHASE: find and attack chicken
        const chicken = sdk.findNearbyNpc(/^chicken$/i);
        if (!chicken) {
            await sdk.waitForTicks(3);
            continue;
        }

        // Use interactNpc directly for speed — option 1 is Attack
        const attackOpt = chicken.optionsWithIndex?.find(o => /attack/i.test(o.text));
        if (attackOpt) {
            await sdk.sendInteractNpc(chicken.index, attackOpt.opIndex);
            kills++;
            // Short wait for kill (we one-shot)
            await sdk.waitForTicks(3);
        }

        // Progress log every 20 kills
        if (kills > 0 && kills % 20 === 0) {
            const defNow = sdk.getSkillXp('defence') ?? 0;
            const prayerNow = sdk.getSkillXp('prayer') ?? 0;
            const defLvl = sdk.getSkill('defence')?.level ?? 1;
            const prayLvl = sdk.getSkill('prayer')?.level ?? 27;
            const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);
            const food = sdk.getState()?.inventory.filter(i => /cooked chicken/i.test(i.name)).reduce((a, i) => a + i.count, 0) ?? 0;

            console.log(encode({
                progress: {
                    kills, minutes: elapsed,
                    def: `${defLvl} (+${defNow - startDef}xp)`,
                    prayer: `${prayLvl} (+${prayerNow - startPrayer}xp)`,
                    bonesBuried, chickenLooted, cookedFood: food,
                    hp: `${sdk.getState()?.player?.hp}/${sdk.getState()?.player?.maxHp}`
                }
            }));
        }
    }

    // Final report
    const defEnd = sdk.getSkillXp('defence') ?? 0;
    const prayEnd = sdk.getSkillXp('prayer') ?? 0;
    const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);
    console.log('\n' + encode({
        result: {
            kills, minutes: elapsed,
            defXpGained: defEnd - startDef,
            defLevel: sdk.getSkill('defence')?.level ?? 1,
            prayerXpGained: prayEnd - startPrayer,
            prayerLevel: sdk.getSkill('prayer')?.level ?? 27,
            bonesBuried, chickenLooted,
            inventory: sdk.getState()?.inventory.map(i => `${i.name} x${i.count}`) ?? []
        }
    }));
}, { timeout: 12 * 60_000 });
