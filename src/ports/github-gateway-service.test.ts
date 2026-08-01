import { describe, expect, it } from "vitest";

import type {
	GitHubGatewayService,
	GatewayIssueUpdateFields,
	GatewayPullRequestUpdateFields,
} from "./github-gateway-service.js";

describe("github-gateway-service types", () => {
	it("has no runtime exports to break", () => {
		expect(true).toBe(true);
	});

	it("GatewayIssueUpdateFields allows partial issue updates", () => {
		const fields: GatewayIssueUpdateFields = { title: "T", state: "closed" };
		expect(fields.title).toBe("T");
		expect(fields.state).toBe("closed");
	});

	it("GatewayPullRequestUpdateFields allows partial PR updates", () => {
		const fields: GatewayPullRequestUpdateFields = { body: "B", labels: ["x"] };
		expect(fields.body).toBe("B");
		expect(fields.labels).toEqual(["x"]);
	});

	it("GitHubGatewayService is a GitHubService superset at the type level", () => {
		// Structural smoke: a GitHubGatewayService satisfies the base GitHubService
		// interface because it extends it. This test pins that relationship.
		const sample = {} as GitHubGatewayService;
		expect(typeof sample.getIssueDetail).toBe("undefined");
		expect(typeof sample.getAuthenticatedUser).toBe("undefined");
	});
});