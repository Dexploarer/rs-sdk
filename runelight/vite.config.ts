import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
	plugins: [solid()],
	root: "src/mainview",
	base: "/runelight/",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		rollupOptions: {
			external: ["/viewer/viewer.js"],
		},
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
