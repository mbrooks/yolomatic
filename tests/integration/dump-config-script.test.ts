import { describe, expect, it } from "vitest";
import { getEffectiveSettings } from "../../scripts/dump-config.js";

describe("dump-config script", () => {
	it("uses database values before environment values and defaults", () => {
		const stored = new Map([
			["github_username", "stored-user"],
			["onboarding_complete", "true"],
		]);

		const values = getEffectiveSettings(
			{ get: (key) => stored.get(key) },
			{
				GITHUB_USERNAME: "env-user",
				PORT: "7777",
			},
		);

		expect(values.github_username).toBe("stored-user");
		expect(values.port).toBe(7777);
		expect(values.default_branch).toBe("main");
		expect(values.onboarding_complete).toBe(true);
		expect(values.admin_username).toBeNull();
	});

	it("includes configured sensitive values", () => {
		const env = {
			GITHUB_TOKEN: "github-secret",
			WEBHOOK_SECRET: "webhook-secret",
		};
		const store = { get: () => undefined };

		const values = getEffectiveSettings(store, env);

		expect(values.github_token).toBe("github-secret");
		expect(values.webhook_secret).toBe("webhook-secret");
	});
});
