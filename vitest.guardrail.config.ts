import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
		pool: "threads",
		maxThreads: 1,
		setupFiles: ["./tests/setup/happy-dom-localstorage.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "json-summary", "html"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/*.test.tsx",
				"src/**/*.d.ts",
				"src/**/types.ts",
				"src/config.ts",
				"src/**/config.ts",
				"src/**/*.config.ts",
				"src/adapters/github/octokit.ts",
				"src/**/*.styles.ts",
				"src/**/*.style.ts",
			],
			thresholds: {
				lines: 0,
				functions: 0,
				branches: 0,
				statements: 0,
			},
		},
	},
});