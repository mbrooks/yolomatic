import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
		pool: "threads",
		maxThreads: 1,
		env: {
			NODE_ENV: "development",
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "json-summary", "html"],
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
			thresholds: {
				lines: 76,
				functions: 71,
				branches: 70,
				statements: 76,
			},
		},
	},
});
