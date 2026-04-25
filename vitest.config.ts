import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "json-summary", "html"],
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts"],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 70,
				statements: 80,
			},
		},
	},
});
