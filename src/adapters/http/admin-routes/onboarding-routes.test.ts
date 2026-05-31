import { describe, expect, it } from "vitest";
import { handleOnboardingRoutes } from "./onboarding-routes.js";

describe("handleOnboardingRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleOnboardingRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			{} as never,
			{ adminAssetsDir: "/tmp" } as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});
});
