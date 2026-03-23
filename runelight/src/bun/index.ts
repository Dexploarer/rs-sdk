import { BrowserWindow, BrowserView } from "electrobun/bun";

// ============ Wait for Game Server ============

async function waitForServer(name: string, url: string, maxAttempts: number, intervalMs: number) {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const resp = await fetch(url, { method: "HEAD" });
			if (resp.ok) {
				console.log(`[RuneLight] ${name} ready`);
				return true;
			}
		} catch {}
		if (i === 0) console.log(`[RuneLight] Waiting for ${name}...`);
		await Bun.sleep(intervalMs);
	}
	console.log(`[RuneLight] WARNING: ${name} not detected`);
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

// Panel served from engine (same-origin access to /viewer/viewer.js for item sprites)
const PANEL_URL = "http://localhost:8888/runelight/index.html";

// Main window — panel fills the whole window, game overlays the left side
const mainWindow = new BrowserWindow({
	title: "RuneLight",
	url: PANEL_URL,
	frame: {
		width: WIN_WIDTH,
		height: WIN_HEIGHT,
		x: 150,
		y: 150,
	},
});

// Game viewport overlays the left portion
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

console.log("[RuneLight] App ready!");
