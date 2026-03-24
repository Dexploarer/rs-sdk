import { runScript } from '../../sdk/runner';
import { EventEngine } from '../../sdk/event-engine';
import { SpacetimeConnector } from '../../sdk/spacetime-connector';
import { encode } from '@toon-format/toon';

// Event-driven Defence grind: reacts to attacks, loots, cooks, banks
const TARGET_DEF = 45;
const CHICKEN_AREA = { x: 3237, z: 3295 };
const COOKING_RANGE = { x: 3212, z: 3215 };

await runScript(async ({ bot, sdk }) => {
    const engine = new EventEngine(sdk, bot);

    // Connect to SpacetimeDB shared memory
    const stdb = new SpacetimeConnector('grind-defence');
    const stdbConnected = await stdb.connect();
    if (stdbConnected) {
        engine.attachSpacetime(stdb);
        console.log('[SpacetimeDB] Connected — events will be shared');

        // Log initial knowledge
        stdb.upsertKnowledge('training:chicken_coop', 'training', 'Chicken Coop Defence Training', {
            location: CHICKEN_AREA,
            style: 'Block (Defensive)',
            xpRate: '~36K def XP/hr at combat 43+',
            risk: 'zero — chickens do 0 damage',
            loot: 'raw chicken, bones, feathers',
        }, 0.95);
    } else {
        console.log('[SpacetimeDB] Not available — logging to files only');
    }

    // Ensure Block style
    await sdk.sendSetCombatStyle(3);

    // --- EVENT HANDLERS ---

    engine.on('attacked', async (e, { bot, sdk }) => {
        if (e.type !== 'attacked') return;
        console.log(`⚔ Attacked by ${e.by} Lvl ${e.level}!`);
        // If it's something dangerous, run
        if (e.level > 5) {
            console.log('  DANGER — running to safety!');
            await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
        }
    });

    engine.on('low_hp', async (e, { bot, sdk }) => {
        if (e.type !== 'low_hp') return;
        console.log(`♥ LOW HP: ${e.hp}/${e.maxHp} (${e.pct}%)`);
        const food = sdk.findInventoryItem(/cooked chicken|bread|shrimp|meat/i);
        if (food) {
            await bot.eatFood(food);
            console.log('  Ate food');
        } else {
            console.log('  NO FOOD — need to cook or bank');
        }
    });

    engine.on('level_up', async (e) => {
        if (e.type !== 'level_up') return;
        console.log(`★ LEVEL UP: ${e.skill} → ${e.level} (${e.xp} xp)`);
        if (e.skill === 'Defence' && e.level >= TARGET_DEF) {
            console.log(`  TARGET REACHED! Defence ${e.level}`);
            engine.stop();
        }
    });

    engine.on('inventory_full', async (e, { bot, sdk }) => {
        console.log('▶ Inventory full — cooking raw chicken');
        await bot.walkTo(COOKING_RANGE.x, COOKING_RANGE.z);
        let cooked = 0;
        for (let i = 0; i < 28; i++) {
            const raw = sdk.findInventoryItem(/^raw chicken$/i);
            if (!raw) break;
            const range = sdk.findNearbyLoc(/^cooking range$/i);
            if (!range) break;
            const r = await bot.useItemOnLoc(raw, range);
            if (r.success) cooked++;
        }
        console.log(`  Cooked ${cooked}. Walking back.`);
        await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
    });

    engine.on('stunned', async () => {
        console.log('✗ Stunned! Waiting...');
    });

    engine.on('cant_reach', async (e, { bot }) => {
        console.log('✗ Can\'t reach — repositioning');
        await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
    });

    // --- MAIN TICK HANDLER: grind chickens ---

    let lastKillTick = 0;

    engine.on('tick', async (e, { bot, sdk }) => {
        if (e.type !== 'tick') return;
        const s = e.state;
        if (!s.player || s.player.combat.inCombat) return;

        // Loot raw chicken from ground
        const rawGround = sdk.findGroundItem(/^raw chicken$/i);
        if (rawGround && rawGround.distance < 4 && s.inventory.length < 27) {
            await bot.pickupItem(rawGround);
            return;
        }

        // Loot and bury bones
        const bonesGround = sdk.findGroundItem(/^bones$/i);
        if (bonesGround && bonesGround.distance < 3 && s.inventory.length < 28) {
            await bot.pickupItem(bonesGround);
            const bone = sdk.findInventoryItem(/^bones$/i);
            if (bone) {
                await sdk.sendUseItem(bone.slot);
                await sdk.waitForTicks(1);
            }
            return;
        }

        // Attack chicken
        const chicken = sdk.findNearbyNpc(/^chicken$/i);
        if (chicken) {
            const opt = chicken.optionsWithIndex?.find(o => /attack/i.test(o.text));
            if (opt) {
                await sdk.sendInteractNpc(chicken.index, opt.opIndex);
                await sdk.waitForTicks(2);
            }
        }
    });

    // --- PROGRESS LOGGING ---

    const startDef = sdk.getSkillXp('defence') ?? 0;
    const startPrayer = sdk.getSkillXp('prayer') ?? 0;
    const startTime = Date.now();
    let lastLog = 0;

    engine.on('tick', async (e) => {
        if (e.type !== 'tick') return;
        const now = Date.now();
        if (now - lastLog < 30_000) return; // log every 30s
        lastLog = now;

        const defXp = (sdk.getSkillXp('defence') ?? 0) - startDef;
        const prayXp = (sdk.getSkillXp('prayer') ?? 0) - startPrayer;
        const elapsed = ((now - startTime) / 60_000).toFixed(1);
        const defLvl = sdk.getSkill('defence')?.level ?? 1;
        const prayLvl = sdk.getSkill('prayer')?.level ?? 1;
        const hp = sdk.getState()?.player;
        const food = sdk.getState()?.inventory.filter(i => /cooked/i.test(i.name)).reduce((a, i) => a + i.count, 0) ?? 0;

        console.log(encode({
            progress: {
                min: elapsed, def: `${defLvl}(+${defXp}xp)`, prayer: `${prayLvl}(+${prayXp}xp)`,
                hp: `${hp?.hp}/${hp?.maxHp}`, food, inv: sdk.getState()?.inventory.length + '/28'
            }
        }));
    });

    // GO
    console.log('=== EVENT-DRIVEN DEFENCE GRIND ===');
    console.log(`Target: Defence ${TARGET_DEF}`);
    await bot.walkTo(CHICKEN_AREA.x, CHICKEN_AREA.z);
    await engine.start();

}, { timeout: 60 * 60_000 }); // 1 hour max
