import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMetrics } from "./metrics.js";

vi.mock("./client.js", () => ({
	apiGet: vi.fn(),
}));

import { apiGet } from "./client.js";

describe("metrics api", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("GETs the metrics endpoint without a query by default", async () => {
		vi.mocked(apiGet).mockResolvedValueOnce({ windowDays: 7, buckets: [], recent: [] });

		await fetchMetrics();

		expect(apiGet).toHaveBeenCalledWith("/api/metrics");
	});

	it("appends the encoded days query parameter when provided", async () => {
		vi.mocked(apiGet).mockResolvedValueOnce({ windowDays: 30, buckets: [], recent: [] });

		await fetchMetrics(30);

		expect(apiGet).toHaveBeenCalledWith("/api/metrics?days=30");
	});
});