import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRefinementLog, fetchRefinementAttempts } from "./refinements.js";

vi.mock("./client.js", () => ({
	apiGet: vi.fn(),
}));

import { apiGet } from "./client.js";

describe("refinements api", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("fetchRefinementLog", () => {
		it("GETs the refinement log endpoint without a since cursor", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ available: false, logs: [] });

			await fetchRefinementLog("mbrooks", "yeetomatic", 42);

			expect(apiGet).toHaveBeenCalledWith("/api/refinements/mbrooks/yeetomatic/42/log");
		});

		it("appends the encoded since cursor when provided", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ available: false, logs: [] });

			await fetchRefinementLog("mbrooks", "yeetomatic", 42, "2026-01-01T00:00:00Z");

			expect(apiGet).toHaveBeenCalledWith(
				"/api/refinements/mbrooks/yeetomatic/42/log?since=2026-01-01T00%3A00%3A00Z",
			);
		});

		it("URL-encodes owner and repo segments", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ available: false, logs: [] });

			await fetchRefinementLog("owner org", "my repo", 7);

			expect(apiGet).toHaveBeenCalledWith(
				"/api/refinements/owner%20org/my%20repo/7/log",
			);
		});
	});

	describe("fetchRefinementAttempts", () => {
		it("GETs the refinement attempts endpoint", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ attempts: [] });

			await fetchRefinementAttempts("mbrooks", "yeetomatic", 42);

			expect(apiGet).toHaveBeenCalledWith("/api/refinements/mbrooks/yeetomatic/42/attempts");
		});

		it("URL-encodes owner and repo segments", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ attempts: [] });

			await fetchRefinementAttempts("owner org", "my repo", 7);

			expect(apiGet).toHaveBeenCalledWith("/api/refinements/owner%20org/my%20repo/7/attempts");
		});
	});
});