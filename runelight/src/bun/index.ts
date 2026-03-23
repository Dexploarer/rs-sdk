import Electrobun, { BrowserWindow, BrowserView, ApplicationMenu, Tray } from "electrobun/bun";

// ============ Wait for Game Server ============

async function waitForServer(name: string, url: string, maxAttempts: number, intervalMs: number) {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const resp = await fetch(url, { method: "HEAD" });
			if (resp.ok) {
				console.log(`[scAIpe] ${name} ready`);
				return true;
			}
		} catch {}
		if (i === 0) console.log(`[scAIpe] Waiting for ${name}...`);
		await Bun.sleep(intervalMs);
	}
	console.log(`[scAIpe] WARNING: ${name} not detected`);
	return false;
}

await Promise.all([
	waitForServer("Engine", "http://localhost:8888", 30, 1000),
	waitForServer("Gateway", "http://localhost:7780", 30, 1000),
]);

// ============ Layout ============

const WIN_WIDTH = 1400;
const WIN_HEIGHT = 900;
const PANEL_WIDTH = 300;
const GAME_WIDTH = WIN_WIDTH - PANEL_WIDTH;

const PANEL_URL = "http://localhost:8888/runelight/index.html";

// ============ Application Menu ============

let panelVisible = true;

ApplicationMenu.setApplicationMenu([
	{
		label: "scAIpe",
		submenu: [
			{ label: "About scAIpe", action: "about" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "File",
		submenu: [
			{ label: "Reconnect Bot", action: "reconnect", accelerator: "CmdOrCtrl+r" },
			{ label: "Disconnect", action: "disconnect" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "View",
		submenu: [
			{ label: "Toggle Side Panel", action: "toggle-panel", accelerator: "CmdOrCtrl+\\" },
			{ type: "separator" },
			{ label: "Reload Panel", action: "reload-panel", accelerator: "CmdOrCtrl+Shift+r" },
			{ type: "separator" },
			{ role: "toggleDevTools" },
		],
	},
	{
		label: "Scripts",
		submenu: [
			{ label: "Run Selected Script", action: "run-script", accelerator: "CmdOrCtrl+Return" },
			{ label: "Stop Script", action: "stop-script", accelerator: "CmdOrCtrl+." },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
		],
	},
]);

ApplicationMenu.on("application-menu-clicked", (event: any) => {
	const action = event?.action || event?.data?.action || "";

	switch (action) {
		case "about":
			console.log("[scAIpe] v0.1.0 — RS-SDK Desktop Client");
			break;
		case "reconnect":
			gameView?.loadURL("http://localhost:8888/bot?bot=dexrunner&password=F6sBxF2QkpBB&minimal");
			break;
		case "disconnect":
			gameView?.loadURL("about:blank");
			break;
		case "toggle-panel":
			panelVisible = !panelVisible;
			if (panelVisible) {
				mainWindow.setSize(WIN_WIDTH, WIN_HEIGHT);
			} else {
				mainWindow.setSize(GAME_WIDTH, WIN_HEIGHT);
			}
			break;
		case "reload-panel":
			panelView?.loadURL(PANEL_URL);
			break;
		case "run-script":
			fetch("http://localhost:7780/run-script", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ botName: "dexrunner", script: "script.ts" }),
			}).catch(() => {});
			break;
		case "stop-script":
			fetch("http://localhost:7780/stop-script", { method: "POST" }).catch(() => {});
			break;
	}
});

// ============ System Tray ============

const tray = new Tray({
	title: "RL",
});

tray.setMenu([
	{ type: "normal", label: "Show scAIpe", action: "show" },
	{ type: "normal", label: "Run Script", action: "tray-run" },
	{ type: "normal", label: "Stop Script", action: "tray-stop" },
	{ type: "divider" },
	{ type: "normal", label: "Quit", action: "tray-quit" },
]);

tray.on("tray-clicked", (event: any) => {
	const action = event?.action || event?.data?.action || "";

	switch (action) {
		case "show":
			mainWindow.focus();
			break;
		case "tray-run":
			fetch("http://localhost:7780/run-script", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ botName: "dexrunner", script: "script.ts" }),
			}).catch(() => {});
			break;
		case "tray-stop":
			fetch("http://localhost:7780/stop-script", { method: "POST" }).catch(() => {});
			break;
		case "tray-quit":
			tray.remove();
			process.exit(0);
			break;
	}
});

// ============ Create Window ============

const mainWindow = new BrowserWindow({
	title: "scAIpe",
	url: PANEL_URL,
	frame: {
		width: WIN_WIDTH,
		height: WIN_HEIGHT,
		x: 150,
		y: 150,
	},
});

// ============ Game Viewport (left) ============

const gameView = new BrowserView({
	url: "http://localhost:8888/bot?bot=dexrunner&password=F6sBxF2QkpBB&minimal",
	windowId: mainWindow.id,
	frame: {
		x: 0,
		y: 0,
		width: GAME_WIDTH,
		height: WIN_HEIGHT,
	},
	sandbox: true,
	autoResize: false,
});

// ============ Side Panel (right) ============

const panelView = new BrowserView({
	url: PANEL_URL,
	windowId: mainWindow.id,
	frame: {
		x: GAME_WIDTH,
		y: 0,
		width: PANEL_WIDTH,
		height: WIN_HEIGHT,
	},
	autoResize: false,
});

console.log("[scAIpe] App ready!");
console.log("[scAIpe] Shortcuts: Cmd+\\ toggle panel, Cmd+Enter run script, Cmd+. stop script");
