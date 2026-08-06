import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
		poolOptions: {
			threads: {
				maxThreads: 1,
			},
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "json-summary", "html"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
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