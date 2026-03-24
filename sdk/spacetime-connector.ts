// SpacetimeDB connector — writes game events and knowledge to shared database
// All data TOON-encoded for token efficiency

import { encode } from '@toon-format/toon';
import { DbConnection } from '../scaipe-memory/src/module_bindings';
import type { BotWorldState } from './types';

const SPACETIME_URL = 'ws://127.0.0.1:3000';
const MODULE_NAME = 'scaipe-mem-test';

export class SpacetimeConnector {
    private conn: DbConnection | null = null;
    private agentName: string;
    private connected = false;

    constructor(agentName: string = 'default') {
        this.agentName = agentName;
    }

    async connect(): Promise<boolean> {
        try {
            this.conn = DbConnection.builder()
                .withUri(SPACETIME_URL)
                .withModuleName(MODULE_NAME)
                .onConnect((conn) => {
                    this.connected = true;
                    console.log(`[SpacetimeDB] ${this.agentName} connected`);
                })
                .onDisconnect(() => {
                    this.connected = false;
                    console.log(`[SpacetimeDB] ${this.agentName} disconnected`);
                })
                .onConnectError((_ctx, err) => {
                    console.error(`[SpacetimeDB] Connection error:`, err);
                })
                .build();

            // Wait for connection
            await new Promise<void>((resolve) => {
                const check = setInterval(() => {
                    if (this.connected) { clearInterval(check); resolve(); }
                }, 100);
                setTimeout(() => { clearInterval(check); resolve(); }, 5000);
            });

            return this.connected;
        } catch (e) {
            console.error(`[SpacetimeDB] Failed to connect:`, e);
            return false;
        }
    }

    // ============ State Logging ============

    logState(state: BotWorldState) {
        if (!this.conn || !this.connected) return;
        const p = state.player;
        if (!p) return;

        // TOON-encode full state for compact storage
        const toonState = encode({
            skills: state.skills.filter(s => s.experience > 0).map(s => ({ n: s.name, l: s.level, x: s.experience })),
            inv: state.inventory.map(i => ({ n: i.name, c: i.count })),
            npcs: state.nearbyNpcs.slice(0, 5).map(n => ({ n: n.name, l: n.combatLevel, d: n.distance })),
            locs: state.nearbyLocs.slice(0, 5).map(l => ({ n: l.name, d: l.distance })),
            ground: state.groundItems.slice(0, 3).map(i => ({ n: i.name, c: i.count, d: i.distance })),
        });

        this.conn.reducers.logState({
            tick: BigInt(state.tick),
            timestamp: new Date().toISOString(),
            playerX: p.worldX,
            playerZ: p.worldZ,
            playerHp: p.hp,
            playerMaxHp: p.maxHp,
            combatLevel: p.combatLevel,
            inCombat: p.combat?.inCombat ?? false,
            toonState,
        });
    }

    // ============ Action Logging ============

    logAction(tick: number, actionType: string, target: string, result: string, state: BotWorldState) {
        if (!this.conn || !this.connected) return;

        const context = encode({
            pos: `${state.player?.worldX},${state.player?.worldZ}`,
            hp: `${state.player?.hp}/${state.player?.maxHp}`,
            inv: state.inventory.length + '/28',
        });

        this.conn.reducers.logAction({
            tick: BigInt(tick),
            timestamp: new Date().toISOString(),
            agent: this.agentName,
            actionType,
            target,
            result,
            context,
        });
    }

    // ============ Event Logging ============

    logEvent(tick: number, eventType: string, data: Record<string, any>) {
        if (!this.conn || !this.connected) return;

        this.conn.reducers.logEvent({
            tick: BigInt(tick),
            timestamp: new Date().toISOString(),
            eventType,
            data: encode(data),
            agent: this.agentName,
        });
    }

    // ============ Knowledge ============

    upsertKnowledge(id: string, category: string, title: string, data: Record<string, any>, confidence: number = 0.8) {
        if (!this.conn || !this.connected) return;

        this.conn.reducers.upsertKnowledge({
            id,
            category,
            title,
            content: encode(data),
            confidence,
        });
    }

    // ============ Routes ============

    upsertRoute(
        id: string,
        from: { name: string; x: number; z: number },
        to: { name: string; x: number; z: number },
        safety: number,
        dangers: string[],
        waypoints: { x: number; z: number }[]
    ) {
        if (!this.conn || !this.connected) return;

        this.conn.reducers.upsertRoute({
            id,
            fromName: from.name,
            fromX: from.x,
            fromZ: from.z,
            toName: to.name,
            toX: to.x,
            toZ: to.z,
            safety,
            dangers: encode({ dangers }),
            waypoints: encode({ waypoints }),
        });
    }

    // ============ Observations ============

    logObservation(what: string, why: string, context: Record<string, any>, lesson: string) {
        if (!this.conn || !this.connected) return;

        this.conn.reducers.logObservation({
            timestamp: new Date().toISOString(),
            whatHappened: what,
            whyInferred: why,
            context: encode(context),
            lesson,
        });
    }

    disconnect() {
        this.conn = null;
        this.connected = false;
    }
}
