import { describe, expect, it } from "vitest";
import { handleSettingsRoutes } from "./settings-routes.js";

describe("handleSettingsRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleSettingsRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			{} as never,
			{} as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});
});
