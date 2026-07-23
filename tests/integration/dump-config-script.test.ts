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
			false,
		);

		expect(values.github_username).toBe("stored-user");
		expect(values.port).toBe(7777);
		expect(values.default_branch).toBe("main");
		expect(values.onboarding_complete).toBe(true);
		expect(values.admin_username).toBeNull();
	});

	it("redacts configured secrets unless explicitly requested", () => {
		const env = {
			GITHUB_TOKEN: "github-secret",
			WEBHOOK_SECRET: "webhook-secret",
		};
		const store = { get: () => undefined };

		const redacted = getEffectiveSettings(store, env, false);
		const revealed = getEffectiveSettings(store, env, true);

		expect(redacted.github_token).toBe("<redacted>");
		expect(redacted.webhook_secret).toBe("<redacted>");
		expect(revealed.github_token).toBe("github-secret");
		expect(revealed.webhook_secret).toBe("webhook-secret");
	});
});
