// scAIpe Game Memory — SpacetimeDB Module
// Real-time shared database for multiple agents to read/write game knowledge
// All data stored as TOON-encoded strings for token efficiency

import { schema, table, t } from 'spacetimedb/server';

// ============ Tables ============

const spacetimedb = schema({
    // Periodic game state snapshots
    state_snapshot: table(
        { name: 'state_snapshot', public: true },
        {
            id: t.u64().primaryKey().autoInc(),
            tick: t.u64().index('btree'),
            timestamp: t.string(),
            player_x: t.u32(),
            player_z: t.u32(),
            player_hp: t.u32(),
            player_max_hp: t.u32(),
            combat_level: t.u32(),
            in_combat: t.bool(),
            toon_state: t.string(), // full TOON-encoded state
        }
    ),

    // Every action taken by any agent
    action_log: table(
        { name: 'action_log', public: true },
        {
            id: t.u64().primaryKey().autoInc(),
            tick: t.u64().index('btree'),
            timestamp: t.string(),
            agent: t.string().index('btree'),
            action_type: t.string().index('btree'),
            target: t.string(),
            result: t.string(),
            context: t.string(), // TOON surrounding state
        }
    ),

    // Game events (attacks, level ups, deaths, discoveries)
    game_event: table(
        { name: 'game_event', public: true },
        {
            id: t.u64().primaryKey().autoInc(),
            tick: t.u64().index('btree'),
            timestamp: t.string(),
            event_type: t.string().index('btree'),
            data: t.string(), // TOON event context
            agent: t.string(),
        }
    ),

    // Persistent knowledge entries
    knowledge: table(
        { name: 'knowledge', public: true },
        {
            id: t.string().primaryKey(), // "location:draynor_bank", "danger:dark_wizards"
            category: t.string().index('btree'),
            title: t.string(),
            content: t.string(), // TOON knowledge
            confidence: t.f32(),
            last_verified: t.string(),
            times_used: t.u32(),
        }
    ),

    // Routes between locations
    route: table(
        { name: 'route', public: true },
        {
            id: t.string().primaryKey(),
            from_name: t.string(),
            from_x: t.u32(),
            from_z: t.u32(),
            to_name: t.string(),
            to_x: t.u32(),
            to_z: t.u32(),
            safety: t.f32(),
            dangers: t.string(),
            waypoints: t.string(),
            last_used: t.string(),
            times_used: t.u32(),
        }
    ),

    // Player observations (learning from human play)
    observation: table(
        { name: 'observation', public: true },
        {
            id: t.u64().primaryKey().autoInc(),
            timestamp: t.string(),
            what_happened: t.string(),
            why_inferred: t.string(),
            context: t.string(),
            lesson: t.string(),
        }
    ),
});

export default spacetimedb;

// ============ Reducers ============

export const log_state = spacetimedb.reducer(
    {
        tick: t.u64(), timestamp: t.string(),
        player_x: t.u32(), player_z: t.u32(),
        player_hp: t.u32(), player_max_hp: t.u32(),
        combat_level: t.u32(), in_combat: t.bool(),
        toon_state: t.string(),
    },
    (ctx, args) => { ctx.db.state_snapshot.insert({ ...args, id: BigInt(0) }); }
);

export const log_action = spacetimedb.reducer(
    {
        tick: t.u64(), timestamp: t.string(), agent: t.string(),
        action_type: t.string(), target: t.string(),
        result: t.string(), context: t.string(),
    },
    (ctx, args) => { ctx.db.action_log.insert({ ...args, id: BigInt(0) }); }
);

export const log_event = spacetimedb.reducer(
    {
        tick: t.u64(), timestamp: t.string(),
        event_type: t.string(), data: t.string(), agent: t.string(),
    },
    (ctx, args) => { ctx.db.game_event.insert({ ...args, id: BigInt(0) }); }
);

export const upsert_knowledge = spacetimedb.reducer(
    {
        id: t.string(), category: t.string(), title: t.string(),
        content: t.string(), confidence: t.f32(),
    },
    (ctx, { id, category, title, content, confidence }) => {
        const existing = ctx.db.knowledge.id.find(id);
        const now = new Date().toISOString();
        if (existing) {
            ctx.db.knowledge.id.update({
                ...existing,
                title, content, confidence,
                last_verified: now,
                times_used: existing.times_used + 1,
            });
        } else {
            ctx.db.knowledge.insert({
                id, category, title, content, confidence,
                last_verified: now, times_used: 0,
            });
        }
    }
);

export const upsert_route = spacetimedb.reducer(
    {
        id: t.string(), from_name: t.string(), from_x: t.u32(), from_z: t.u32(),
        to_name: t.string(), to_x: t.u32(), to_z: t.u32(),
        safety: t.f32(), dangers: t.string(), waypoints: t.string(),
    },
    (ctx, args) => {
        const existing = ctx.db.route.id.find(args.id);
        const now = new Date().toISOString();
        if (existing) {
            ctx.db.route.id.update({
                ...existing, ...args,
                last_used: now, times_used: existing.times_used + 1,
            });
        } else {
            ctx.db.route.insert({ ...args, last_used: now, times_used: 0 });
        }
    }
);

export const log_observation = spacetimedb.reducer(
    {
        timestamp: t.string(), what_happened: t.string(),
        why_inferred: t.string(), context: t.string(), lesson: t.string(),
    },
    (ctx, args) => { ctx.db.observation.insert({ ...args, id: BigInt(0) }); }
);
