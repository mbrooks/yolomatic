import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
		poolOptions: {
			threads: {
				env: {
					NODE_ENV: "development",
				},
				maxThreads: 1,
			},
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "json-summary", "html"],
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts"],
			thresholds: {
				lines: 76,
				functions: 71,
				branches: 70,
				statements: 76,
			},
		},
	},
});
