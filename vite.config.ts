import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	base: "/tarsadmin/",
	root: resolve(rootDir, "src/admin"),
	plugins: [react()],
	build: {
		emptyOutDir: true,
		outDir: resolve(rootDir, "dist/admin"),
		rollupOptions: {
			input: resolve(rootDir, "src/admin/index.html"),
		},
	},
});
