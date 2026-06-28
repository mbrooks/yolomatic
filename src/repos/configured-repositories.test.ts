import { describe, expect, it } from "vitest";
import {
	findConfiguredRepository,
	parseConfiguredRepositories,
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
});
