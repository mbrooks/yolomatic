import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

function resolveAdminBase(): string {
	const raw = (process.env.TARS_ADMIN_BASE_URL ?? "/tars/admin/").trim() || "/tars/admin/";
	return raw.endsWith("/") ? raw : `${raw}/`;
}

export default defineConfig({
	base: resolveAdminBase(),
	root: resolve(rootDir, "src/admin"),
	plugins: [react(), tailwindcss()],
	build: {
		emptyOutDir: true,
		outDir: resolve(rootDir, "dist/admin"),
		rollupOptions: {
			input: resolve(rootDir, "src/admin/index.html"),
		},
	},
});
