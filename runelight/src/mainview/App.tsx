import { createSignal, For, Show, onMount, onCleanup, createEffect } from "solid-js";

const TABS = ["Status", "Inventory", "Nearby", "Scripts"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
	const [activeTab, setActiveTab] = createSignal<Tab>("Status");
	const [status, setStatus] = createSignal("Connecting...");
	const [connected, setConnected] = createSignal(false);
	const [gameState, setGameState] = createSignal<any>(null);

	let ws: WebSocket | null = null;

	function connectGateway() {
		ws = new WebSocket("ws://localhost:7780");

		ws.onopen = () => {
			ws!.send(JSON.stringify({
				type: "sdk_connect",
				username: "dexrunner",
				password: "",
				clientId: `scaipe-${Date.now()}`,
				mode: "observe",
			}));
		};

		ws.onmessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.type === "sdk_connected") {
				setConnected(true);
				setStatus("Observing");
			} else if (msg.type === "sdk_state" && msg.state) {
				setGameState(msg.state);
			} else if (msg.type === "sdk_error") {
				setStatus(`Error: ${msg.error}`);
			}
		};

		ws.onclose = () => {
			setConnected(false);
			setStatus("Reconnecting...");
			setTimeout(connectGateway, 2000);
		};

		ws.onerror = () => setStatus("Connection error");
	}

	onMount(() => {
		// Wait a moment for the game to connect, then observe
		setTimeout(connectGateway, 3000);
	});

	onCleanup(() => ws?.close());

	return (
		<div class="panel-root">
			<div class="panel-header">
				<span class="panel-title">scAIpe</span>
				<span class={`status-dot ${connected() ? "online" : "offline"}`} />
			</div>

			<div class="tab-bar">
				<For each={[...TABS]}>
					{(tab) => (
						<button
							class={`tab ${activeTab() === tab ? "active" : ""}`}
							onClick={() => setActiveTab(tab)}
						>
							{tab}
						</button>
					)}
				</For>
			</div>

			<div class="tab-content">
				<Show when={activeTab() === "Status"}>
					<StatusPanel connected={connected()} status={status()} state={gameState()} />
				</Show>
				<Show when={activeTab() === "Inventory"}>
					<InventoryPanel state={gameState()} />
				</Show>
				<Show when={activeTab() === "Nearby"}>
					<NearbyPanel state={gameState()} />
				</Show>
				<Show when={activeTab() === "Scripts"}>
					<ScriptsPanel />
				</Show>
			</div>
		</div>
	);
}

// ============ Status Panel ============

function StatusPanel(props: { connected: boolean; status: string; state: any }) {
	const player = () => props.state?.player;
	const skills = () => props.state?.skills || [];

	return (
		<div class="panel-section">
			<h3>Connection</h3>
			<div class="stat-row">
				<span class="stat-label">Status</span>
				<span class={`stat-value ${props.connected ? "text-green" : "text-red"}`}>
					{props.status}
				</span>
			</div>

			<Show when={player()}>
				<h3>Player</h3>
				<div class="stat-row">
					<span class="stat-label">Name</span>
					<span class="stat-value">{player().name}</span>
				</div>
				<div class="stat-row">
					<span class="stat-label">Combat</span>
					<span class="stat-value">Lvl {player().combatLevel}</span>
				</div>
				<div class="stat-row">
					<span class="stat-label">HP</span>
					<span class="stat-value">{player().hp}/{player().maxHp}</span>
				</div>
				<div class="stat-row">
					<span class="stat-label">Position</span>
					<span class="stat-value">{player().worldX}, {player().worldZ}</span>
				</div>
			</Show>

			<Show when={skills().length > 0}>
				<h3>Skills</h3>
				<For each={skills().filter((s: any) => s.experience > 0 || s.name === "Hitpoints")}>
					{(skill: any) => (
						<div class="stat-row">
							<span class="stat-label">{skill.name}</span>
							<span class="stat-value">
								{skill.level}
								<span class="xp-text"> ({formatXp(skill.experience)} xp)</span>
							</span>
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}

// ============ Item Viewer (renders sprites from game cache) ============

let itemViewer: any = null;
let viewerReady = false;
let viewerError = "";

async function initItemViewer() {
	if (viewerReady || itemViewer) return;
	try {
		const module = await import("/viewer/viewer.js");
		itemViewer = new module.ItemViewer();
		await itemViewer.init("");
		viewerReady = true;
		console.log("[scAIpe] ItemViewer ready - rendering icons");
		// Trigger re-render of all existing canvases
		document.querySelectorAll("canvas.item-canvas").forEach((c) => {
			const id = parseInt(c.getAttribute("data-item-id") || "0");
			const count = parseInt(c.getAttribute("data-count") || "1");
			if (id > 0) renderItemToCanvas(c as HTMLCanvasElement, id, count);
		});
	} catch (e: any) {
		viewerError = e.message;
		console.error("[scAIpe] ItemViewer failed:", e);
	}
}

function renderItemToCanvas(canvas: HTMLCanvasElement, itemId: number, count: number) {
	if (!viewerReady || !itemViewer) return;
	try {
		const imageData = itemViewer.renderItemIconAsImageData(itemId, count);
		if (imageData && canvas) {
			canvas.width = imageData.width;
			canvas.height = imageData.height;
			const ctx = canvas.getContext("2d");
			if (ctx) ctx.putImageData(imageData, 0, 0);
		}
	} catch {}
}

// ============ Inventory Panel ============

function InventoryPanel(props: { state: any }) {
	const inventory = () => props.state?.inventory || [];

	onMount(() => { initItemViewer(); });

	return (
		<div class="panel-section">
			<h3>Inventory ({inventory().length}/28)</h3>
			<div class="inventory-grid">
				<For each={Array(28).fill(null)}>
					{(_, i) => {
						const item = () => inventory().find((inv: any) => inv.slot === i());
						return (
							<div class={`inv-slot ${item() ? "has-item" : ""}`} title={item()?.name || ""}>
								<Show when={item()}>
									<ItemIcon id={item()!.id} count={item()!.count} />
									<Show when={item()!.count > 1}>
										<span class="inv-count">{formatCount(item()!.count)}</span>
									</Show>
								</Show>
							</div>
						);
					}}
				</For>
			</div>
		</div>
	);
}

function ItemIcon(props: { id: number; count: number }) {
	let canvasRef: HTMLCanvasElement | undefined;

	const tryRender = () => {
		if (canvasRef && viewerReady) {
			renderItemToCanvas(canvasRef, props.id, props.count);
		}
	};

	createEffect(() => {
		// Re-render when id/count changes
		props.id; props.count;
		tryRender();
	});

	onMount(() => {
		// Poll until viewer is ready
		const interval = setInterval(() => {
			if (viewerReady) {
				tryRender();
				clearInterval(interval);
			}
		}, 500);
		setTimeout(() => clearInterval(interval), 30000);
	});

	return (
		<canvas
			ref={canvasRef}
			class="item-canvas"
			width="36"
			height="32"
			data-item-id={props.id}
			data-count={props.count}
		/>
	);
}

function formatCount(n: number): string {
	if (n >= 1_000_000) return `${Math.floor(n / 1_000_000)}M`;
	if (n >= 1_000) return `${Math.floor(n / 1_000)}K`;
	return n.toString();
}

// ============ Nearby Panel ============

function NearbyPanel(props: { state: any }) {
	const npcs = () => (props.state?.nearbyNpcs || []).slice(0, 10);
	const locs = () => (props.state?.nearbyLocs || []).slice(0, 10);
	const ground = () => (props.state?.groundItems || []).slice(0, 8);

	return (
		<div class="panel-section">
			<h3>NPCs ({npcs().length})</h3>
			<For each={npcs()} fallback={<p class="placeholder-text">None nearby</p>}>
				{(npc: any) => (
					<div class="entity-row">
						<span class="entity-name">{npc.name}</span>
						<span class="entity-info">
							<Show when={npc.combatLevel > 0}>Lvl {npc.combatLevel} - </Show>
							{npc.distance}t
						</span>
					</div>
				)}
			</For>

			<h3>Objects ({locs().length})</h3>
			<For each={locs()} fallback={<p class="placeholder-text">None nearby</p>}>
				{(loc: any) => (
					<div class="entity-row">
						<span class="entity-name">{loc.name}</span>
						<span class="entity-info">{loc.distance}t</span>
					</div>
				)}
			</For>

			<h3>Ground Items ({ground().length})</h3>
			<For each={ground()} fallback={<p class="placeholder-text">None nearby</p>}>
				{(item: any) => (
					<div class="entity-row">
						<span class="entity-name">{item.name}</span>
						<span class="entity-info">x{item.count} - {item.distance}t</span>
					</div>
				)}
			</For>
		</div>
	);
}

// ============ Scripts Panel ============

function ScriptsPanel() {
	const [scripts, setScripts] = createSignal<string[]>([]);
	const [selected, setSelected] = createSignal("");
	const [running, setRunning] = createSignal(false);
	const [runningName, setRunningName] = createSignal("");
	const [output, setOutput] = createSignal<string[]>([]);

	const GW = "http://localhost:7780";

	onMount(async () => {
		try {
			const resp = await fetch(`${GW}/scripts/dexrunner`);
			const data = await resp.json();
			setScripts(data.scripts || []);
			if (data.scripts?.length) setSelected(data.scripts[0]);
		} catch {}

		// Poll for output
		const interval = setInterval(async () => {
			try {
				const resp = await fetch(`${GW}/script-output`);
				const data = await resp.json();
				setRunning(data.running);
				setRunningName(data.script || "");
				setOutput(data.output || []);
			} catch {}
		}, 1000);

		onCleanup(() => clearInterval(interval));
	});

	async function runScript() {
		const script = selected();
		if (!script) return;
		try {
			await fetch(`${GW}/run-script`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ botName: "dexrunner", script }),
			});
			setRunning(true);
			setRunningName(script);
			setOutput([]);
		} catch {}
	}

	async function stopScript() {
		try {
			await fetch(`${GW}/stop-script`, { method: "POST" });
			setRunning(false);
			setRunningName("");
		} catch {}
	}

	let outputRef: HTMLDivElement | undefined;

	createEffect(() => {
		output(); // track
		if (outputRef) outputRef.scrollTop = outputRef.scrollHeight;
	});

	return (
		<div class="panel-section">
			<h3>Bot Scripts</h3>

			<div class="script-controls">
				<select
					class="script-select"
					value={selected()}
					onChange={(e) => setSelected(e.currentTarget.value)}
				>
					<For each={scripts()}>
						{(s) => <option value={s}>{s.replace(".ts", "")}</option>}
					</For>
				</select>
				<Show
					when={running()}
					fallback={
						<button class="script-btn run" onClick={runScript}>
							Run
						</button>
					}
				>
					<button class="script-btn stop" onClick={stopScript}>
						Stop
					</button>
				</Show>
			</div>

			<Show when={running()}>
				<div class="script-status">
					Running: <strong>{runningName()}</strong>
				</div>
			</Show>

			<div class="script-output" ref={outputRef}>
				<For each={output()}>
					{(line) => <div class="output-line">{line}</div>}
				</For>
				<Show when={output().length === 0}>
					<p class="placeholder-text">No output yet</p>
				</Show>
			</div>
		</div>
	);
}

// ============ Helpers ============

function formatXp(xp: number): string {
	if (xp >= 1_000_000) return `${(xp / 1_000_000).toFixed(1)}M`;
	if (xp >= 1_000) return `${(xp / 1_000).toFixed(1)}K`;
	return xp.toString();
}
