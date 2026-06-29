import { describe, expect, it } from "vitest";
import {
	findConfiguredRepository,
	parseConfiguredRepositories,
	removeConfiguredRepository,
	repoModeIncludesPolling,
	repoModeIncludesWebhook,
	resolveConfiguredRepoDefaultBranch,
	resolveConfiguredRepoGitHubEventMode,
	stringifyConfiguredRepositories,
	upsertConfiguredRepository,
} from "./configured-repositories.js";

describe("configured-repositories", () => {
	it("parses legacy repository entries without settings", () => {
		expect(parseConfiguredRepositories('[{"owner":"mbrooks","repo":"tars"}]')).toEqual([
			{ owner: "mbrooks", repo: "tars" },
		]);
	});

	it("parses repo settings and skips invalid values", () => {
		expect(
			parseConfiguredRepositories(
				'[{"owner":"mbrooks","repo":"tars","settings":{"github_event_mode":"polling","default_branch":"master"}},{"owner":"bad","repo":"repo","settings":{"github_event_mode":"invalid"}}]',
			),
		).toEqual([
			{
				owner: "mbrooks",
				repo: "tars",
				settings: { github_event_mode: "polling", default_branch: "master" },
			},
			{ owner: "bad", repo: "repo" },
		]);
	});

	it("upserts repositories and preserves settings", () => {
		const updated = upsertConfiguredRepository(
			[{ owner: "mbrooks", repo: "tars" }],
			{
				owner: "mbrooks",
				repo: "tars",
				settings: { github_event_mode: "webhook", default_branch: "main" },
			},
		);
		expect(findConfiguredRepository(updated, "mbrooks", "tars")).toEqual({
			owner: "mbrooks",
			repo: "tars",
			settings: { github_event_mode: "webhook", default_branch: "main" },
		});
		expect(JSON.parse(stringifyConfiguredRepositories(updated))).toEqual([
			{
				owner: "mbrooks",
				repo: "tars",
				settings: { github_event_mode: "webhook", default_branch: "main" },
			},
		]);
	});

	it("resolves repo settings with global fallbacks", () => {
		const repositories = parseConfiguredRepositories(
			'[{"owner":"mbrooks","repo":"tars","settings":{"github_event_mode":"polling","default_branch":"master"}}]',
		);
		expect(resolveConfiguredRepoGitHubEventMode(repositories, "mbrooks", "tars", "webhook")).toBe("polling");
		expect(resolveConfiguredRepoGitHubEventMode(repositories, "mbrooks", "case", "webhook")).toBe("webhook");
		expect(resolveConfiguredRepoDefaultBranch(repositories, "mbrooks", "tars", "main")).toBe("master");
		expect(resolveConfiguredRepoDefaultBranch(repositories, "mbrooks", "case", "main")).toBe("main");
	});

	it("checks whether a mode includes webhook or polling", () => {
		expect(repoModeIncludesWebhook("webhook")).toBe(true);
		expect(repoModeIncludesWebhook("both")).toBe(true);
		expect(repoModeIncludesWebhook("polling")).toBe(false);
		expect(repoModeIncludesPolling("polling")).toBe(true);
		expect(repoModeIncludesPolling("both")).toBe(true);
		expect(repoModeIncludesPolling("webhook")).toBe(false);
	});

	describe("removeConfiguredRepository", () => {
		it("removes a configured repository by owner and repo", () => {
			const repositories = parseConfiguredRepositories(
				JSON.stringify([
					{ owner: "mbrooks", repo: "tars" },
					{ owner: "octocat", repo: "hello-world" },
				]),
			);
			const updated = removeConfiguredRepository(repositories, "mbrooks", "tars");
			expect(updated).toEqual([{ owner: "octocat", repo: "hello-world" }]);
		});

		it("matches case-insensitively", () => {
			const repositories = parseConfiguredRepositories(
				JSON.stringify([{ owner: "Mbrooks", repo: "Tars" }]),
			);
			const updated = removeConfiguredRepository(repositories, "mbrooks", "tars");
			expect(updated).toEqual([]);
		});

		it("returns the same list when the repository is not configured", () => {
			const repositories = parseConfiguredRepositories(
				JSON.stringify([{ owner: "mbrooks", repo: "tars" }]),
			);
			const updated = removeConfiguredRepository(repositories, "unknown", "missing");
			expect(updated).toEqual(repositories);
		});
	});
});
