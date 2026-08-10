// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SettingsScreen } from "./SettingsScreen.js";
import { DEFAULT_SETTINGS_TAB } from "../../app/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = path.resolve(__dirname, "../../styles.css");

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const MOCK_SETTINGS = [
	{
		key: "github_token",
		value: "ghp_token",
		description: "GitHub personal access token",
		type: "string",
		default: undefined,
		requiresRestart: true,
		sensitive: true,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "github-integration",
	},
	{
		key: "github_username",
		value: "yolomatic-bot",
		description: "GitHub username",
		type: "string",
		default: undefined,
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "github-integration",
	},
	{
		key: "github_event_mode",
		value: "webhook",
		description: "GitHub event ingestion mode",
		type: "string",
		default: "webhook",
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "github-integration",
	},
	{
		key: "admin_github_username",
		value: "admin",
		description: "GitHub user authorized for /yolomatic stop and /yolomatic issue-refinement",
		type: "string",
		default: undefined,
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "authentication",
	},
	{
		key: "port",
		value: 6767,
		description: "HTTP server port",
		type: "number",
		default: 6767,
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "server",
	},
	{
		key: "sessions_dir",
		value: "./sessions",
		description: "Directory for session state files",
		type: "string",
		default: "./sessions",
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "file-system",
	},
	{
		key: "log_level",
		value: "info",
		description: "Log level",
		type: "string",
		default: "info",
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "logging",
	},
	{
		key: "configured_repositories",
		value: "[\"mbrooks/yolomatic\"]",
		description: "JSON list of repositories configured during onboarding",
		type: "string",
		default: "[]",
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-07-23T00:00:00.000Z",
		category: "repositories",
	},
	{
		key: "default_branch",
		value: "main",
		description: "Default git branch for new worktrees",
		type: "string",
		default: "main",
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-07-23T00:00:00.000Z",
		category: "git-worktrees",
	},
	{
		key: "onboarding_complete",
		value: true,
		description: "Whether the onboarding wizard has been completed",
		type: "boolean",
		default: undefined,
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-07-23T00:00:00.000Z",
		category: "server",
	},
	{
		key: "self_report_enabled",
		value: true,
		description: "Enable self-monitoring reports",
		type: "boolean",
		default: true,
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "agent-behavior",
	},
	{
		key: "issue_new_comment_enabled",
		value: true,
		description: "Post an automatic comment on newly opened issues.",
		type: "boolean",
		default: true,
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "issues",
	},
	{
		key: "issue_admin_link_in_comments_enabled",
		value: true,
		description: "Include a link to the admin UI in status comments.",
		type: "boolean",
		default: true,
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "issues",
	},
	{
		key: "pi_agent_model",
		value: "kimi-k2.7-code:cloud",
		description: "LLM model identifier",
		type: "string",
		default: undefined,
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-07-23T00:00:00.000Z",
		category: "ai-llm",
	},
	{
		key: "pi_agent_provider",
		value: "ollama",
		description: "LLM provider used by worker containers.",
		type: "string",
		default: "ollama",
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-07-23T00:00:00.000Z",
		category: "ai-llm",
	},
	{
		key: "ollama_container_name",
		value: "yolomatic-ollama",
		description: "Name of the Ollama Docker container.",
		type: "string",
		default: "yolomatic-ollama",
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-07-23T00:00:00.000Z",
		category: "ai-llm",
	},
	{
		key: "openai_api_key",
		value: "",
		description: "OpenAI platform API key. Required when pi_agent_provider is openai.",
		type: "string",
		default: undefined,
		requiresRestart: true,
		sensitive: true,
		updatedAt: "2026-07-23T00:00:00.000Z",
		category: "ai-llm",
	},
	{
		key: "admin_base_url",
		value: "http://host:6767/yolomatic/admin",
		description: "Absolute public base URL of the admin UI.",
		type: "string",
		default: "",
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "server",
	},
];

function mockSettingsFetch() {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
		const url = typeof input === "string" ? input : input.url;
		if (url === "/api/settings") {
			return Promise.resolve(jsonResponse({ settings: MOCK_SETTINGS }));
		}
		return Promise.reject(new Error(`Unexpected fetch: ${url}`));
	});
}

function mockFetchWithSave(response: { updated: string[]; requiresRestart: string[] } = { updated: [], requiresRestart: [] }) {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		const url = typeof input === "string" ? input : input.url;
		if (url === "/api/settings" && init?.method === "PATCH") {
			return Promise.resolve(jsonResponse(response));
		}
		if (url === "/api/settings") {
			return Promise.resolve(jsonResponse({ settings: MOCK_SETTINGS }));
		}
		return Promise.reject(new Error(`Unexpected fetch: ${url}`));
	});
}

function mockSettingsAndOllama(ollamaStatus: unknown) {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
		const url = typeof input === "string" ? input : input.url;
		if (url === "/api/settings") {
			return Promise.resolve(jsonResponse({ settings: MOCK_SETTINGS }));
		}
		if (url === "/api/ollama/signin") {
			return Promise.resolve(jsonResponse(ollamaStatus));
		}
		return Promise.reject(new Error(`Unexpected fetch: ${url}`));
	});
}

function aiLlmSettingsWithProvider(provider: string) {
	return MOCK_SETTINGS.map((setting) =>
		setting.key === "pi_agent_provider" ? { ...setting, value: provider } : setting,
	);
}

describe("SettingsScreen", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		window.location.hash = "";
	});

	it("renders loading state on default category tab", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} tab={DEFAULT_SETTINGS_TAB} />);
		expect(screen.getByText("Loading settings...")).not.toBeNull();
	});

	it("renders settings filtered by active category tab", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		await waitFor(() => {
			expect(screen.getByText("github_token")).not.toBeNull();
		});
		expect(screen.getByText("github_username")).not.toBeNull();
		expect(screen.queryByText("admin_github_username")).toBeNull();
		expect(screen.queryByText("port")).toBeNull();
	});

	it("renders github_event_mode as a dropdown with supported modes", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		const eventMode = await screen.findByRole("combobox", { name: /github_event_mode/ }) as HTMLSelectElement;
		expect(eventMode.tagName).toBe("SELECT");
		expect(Array.from(eventMode.options, (option) => option.value)).toEqual(["webhook", "polling", "both"]);

		fireEvent.change(eventMode, { target: { value: "both" } });
		expect(eventMode.value).toBe("both");
		expect(eventMode.parentElement?.classList.contains("dirty")).toBe(true);
	});

	it("renames Agent Behavior to Worker Behavior and filters its settings", async () => {
		mockSettingsFetch();
		const { rerender } = render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		await waitFor(() => {
			expect(screen.getByText("github_token")).not.toBeNull();
		});

		expect(screen.queryByRole("button", { name: "Agent Behavior" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Worker Behavior" }));
		expect(window.location.hash).toBe("#/settings/agent-behavior");

		rerender(<SettingsScreen onBack={vi.fn()} tab="agent-behavior" />);

		await waitFor(() => {
			expect(screen.getByText("self_report_enabled")).not.toBeNull();
		});
		expect(screen.queryByText("github_token")).toBeNull();
	});

	it("renders skills tab", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ skills: [] }),
		);
		render(<SettingsScreen onBack={vi.fn()} tab="skills" />);

		await waitFor(() => {
			expect(screen.getByText("No server-level skills defined.")).not.toBeNull();
		});
	});

	it("renders invitations tab", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ invitations: [] }),
		);
		render(<SettingsScreen onBack={vi.fn()} tab="invitations" />);

		await waitFor(() => {
			expect(screen.getByText("No pending invitations.")).not.toBeNull();
		});
	});

	it("navigates to invitations tab when invitations button is clicked", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} tab={DEFAULT_SETTINGS_TAB} />);

		const invitationsButton = screen.getByRole("button", { name: "Invitations" });
		fireEvent.click(invitationsButton);

		expect(window.location.hash).toBe("#/settings/invitations");
	});

	it("navigates to skills tab when skills button is clicked", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} tab={DEFAULT_SETTINGS_TAB} />);

		const skillsButton = screen.getByRole("button", { name: "Skills" });
		fireEvent.click(skillsButton);

		expect(window.location.hash).toBe("#/settings/skills");
	});

	it("navigates to default category tab when no tab is provided", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} />);

		const defaultButton = screen.getByRole("button", { name: "Server" });
		expect(defaultButton).not.toBeNull();
		expect(defaultButton.className).toContain("active");
	});

	it("renders consolidated sections under Server and hides their former tabs", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="server" />);

		await waitFor(() => {
			expect(screen.getByText("port")).not.toBeNull();
		});

		const tabs = screen.getAllByRole("button").filter((button) => button.classList.contains("repo-tab"));
		expect(tabs.map((button) => button.textContent)).toEqual([
			"Server",
			"Issues",
			"Repositories",
			"GitHub Integration",
			"Git & Worktrees",
			"Worker Behavior",
			"AI / LLM",
			"Users",
			"Skills",
			"Invitations",
			"Rerun On-Boarding",
		]);
		expect(screen.queryByRole("button", { name: "Authentication" })).toBeNull();
		expect(screen.queryByRole("button", { name: "File System" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Logging" })).toBeNull();

		for (const section of ["Server", "Authentication", "File System", "Logging"]) {
			expect(screen.getByRole("heading", { name: section })).not.toBeNull();
		}
		expect(screen.getByText("admin_github_username")).not.toBeNull();
		expect(screen.getByText("sessions_dir")).not.toBeNull();
		expect(screen.getByText("log_level")).not.toBeNull();
		expect(screen.queryByText("configured_repositories")).toBeNull();
		expect(screen.queryByText("onboarding_complete")).toBeNull();
		expect(screen.queryByText("github_token")).toBeNull();
		expect(screen.queryByText("self_report_enabled")).toBeNull();
	});

	it("renders the Issues tab with the issue-category toggles", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="issues" />);

		await waitFor(() => {
			expect(screen.getByText("issue_new_comment_enabled")).not.toBeNull();
		});
		expect(screen.getByText("issue_admin_link_in_comments_enabled")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Issues" }).className).toContain("active");
		expect(screen.queryByText("admin_base_url")).toBeNull();
		expect(screen.queryByText("github_token")).toBeNull();
	});

	it("renders admin_base_url under the Server tab", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="server" />);

		await waitFor(() => {
			expect(screen.getByText("port")).not.toBeNull();
		});
		expect(screen.getByText("admin_base_url")).not.toBeNull();
	});

	it("keeps Git & Worktrees settings in their own tab", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="git-worktrees" />);

		await waitFor(() => {
			expect(screen.getByText("default_branch")).not.toBeNull();
		});

		expect(screen.getByRole("button", { name: "Git & Worktrees" }).className).toContain("active");
		expect(screen.queryByText("configured_repositories")).toBeNull();
		expect(screen.queryByText("port")).toBeNull();
	});

	it("renders the selectable Repositories tab and hides other settings", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "/api/repos/accessible") {
				return Promise.resolve(jsonResponse({
					repositories: [
						{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
					],
					configured: [{ owner: "mbrooks", repo: "yolomatic" }],
				}));
			}
			if (url === "/api/settings") {
				return Promise.resolve(jsonResponse({ settings: MOCK_SETTINGS }));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<SettingsScreen onBack={vi.fn()} tab="repositories" />);

		await waitFor(() => {
			expect(screen.getByText("mbrooks/yolomatic")).not.toBeNull();
		});

		expect(screen.getByRole("button", { name: "Repositories" }).className).toContain("active");
		expect(screen.getByRole("button", { name: "Deselect All" })).not.toBeNull();
		expect(screen.queryByText("default_branch")).toBeNull();
		expect(screen.queryByText("port")).toBeNull();
	});

	it("does not rerun onboarding when confirmation is declined", async () => {
		const fetchSpy = mockFetchWithSave();
		const onRerunOnboarding = vi.fn();
		vi.spyOn(window, "confirm").mockReturnValue(false);
		render(
			<SettingsScreen
				onBack={vi.fn()}
				onRerunOnboarding={onRerunOnboarding}
				tab="server"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Rerun On-Boarding" })).not.toBeNull();
		});
		const button = screen.getByRole("button", { name: "Rerun On-Boarding" });
		expect(button.className).toContain("settings-rerun-onboarding");
		expect(screen.getByRole("button", { name: "Invitations" }).nextElementSibling).toBe(button);
		fireEvent.click(button);

		expect(window.confirm).toHaveBeenCalledWith("Are you sure you want to rerun the on-boarding wizard?");
		expect(onRerunOnboarding).not.toHaveBeenCalled();
		expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
	});

	it("marks onboarding incomplete and opens the wizard after confirmation", async () => {
		const fetchSpy = mockFetchWithSave({ updated: ["onboarding_complete"], requiresRestart: ["onboarding_complete"] });
		const onRerunOnboarding = vi.fn();
		vi.spyOn(window, "confirm").mockReturnValue(true);
		render(
			<SettingsScreen
				onBack={vi.fn()}
				onRerunOnboarding={onRerunOnboarding}
				tab="server"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Rerun On-Boarding" })).not.toBeNull();
		});
		fireEvent.click(screen.getByRole("button", { name: "Rerun On-Boarding" }));

		await waitFor(() => {
			expect(onRerunOnboarding).toHaveBeenCalledTimes(1);
		});
		const patchCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "PATCH");
		expect(JSON.parse(patchCall?.[1]?.body as string)).toEqual({ onboarding_complete: false });
	});

	it("calls onBack when back button is clicked", () => {
		const onBack = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={onBack} tab={DEFAULT_SETTINGS_TAB} />);

		fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it("marks a row dirty and enables save when a value is edited", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		await waitFor(() => {
			expect(screen.getByDisplayValue("yolomatic-bot")).not.toBeNull();
		});

		const input = screen.getByDisplayValue("yolomatic-bot") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "new-bot" } });

		expect(input.parentElement?.classList.contains("dirty")).toBe(true);
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("saves changes and refreshes settings", async () => {
		const fetchSpy = mockFetchWithSave({ updated: ["github_username"], requiresRestart: [] });
		render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		await waitFor(() => {
			expect(screen.getByDisplayValue("yolomatic-bot")).not.toBeNull();
		});

		fireEvent.change(screen.getByDisplayValue("yolomatic-bot"), { target: { value: "new-bot" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => {
			expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
		});

		const patchCall = fetchSpy.mock.calls.find(([input, init]) => {
			const url = typeof input === "string" ? input : input.url;
			return url === "/api/settings" && init?.method === "PATCH";
		});
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall![1].body as string);
		expect(body).toEqual({ github_username: "new-bot" });
	});

	it("styles the Rerun On-Boarding tab like the other neutral settings tabs", async () => {
		const css = await readFile(STYLES_PATH, "utf-8");

		// No rule targeting .settings-rerun-onboarding may reintroduce the red
		// tab styling; the rerun action should inherit the neutral .repo-tab look.
		const rerunBlocks = [
			...css.matchAll(/\.repo-tab\.settings-rerun-onboarding[^{]*\{[^}]*\}/gu),
		].map((match) => match[0]);
		for (const block of rerunBlocks) {
			expect(block).not.toContain("var(--red)");
			expect(block).not.toContain("#fff");
			expect(block).not.toMatch(/background\s*:/u);
			expect(block).not.toMatch(/color\s*:/u);
		}

		// The base .repo-tab rule should still define the neutral styling.
		const baseBlock = css.match(/\.repo-tab\s*\{[^}]*\}/u);
		expect(baseBlock, "expected a base .repo-tab rule to exist").not.toBeNull();
		expect(baseBlock![0]).toContain("background: var(--surface)");
	});

	it("renders pi_agent_provider as a dropdown offering ollama and openai", async () => {
		mockSettingsAndOllama({ signedIn: true, user: "alice", message: "ok" });
		render(<SettingsScreen onBack={vi.fn()} tab="ai-llm" />);

		const provider = await screen.findByRole("combobox", { name: /pi_agent_provider/ }) as HTMLSelectElement;
		expect(provider.tagName).toBe("SELECT");
		expect(Array.from(provider.options, (option) => option.value)).toEqual(["ollama", "openai"]);
	});

	it("does not render the Ollama status panel when the provider is not ollama", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "/api/settings") {
				return Promise.resolve(jsonResponse({ settings: aiLlmSettingsWithProvider("other") }));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<SettingsScreen onBack={vi.fn()} tab="ai-llm" />);

		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: /pi_agent_provider/ })).not.toBeNull();
		});
		expect(screen.queryByText("Ollama sign-in status")).toBeNull();
		expect(globalThis.fetch).not.toHaveBeenCalledWith("/api/ollama/signin", expect.anything());
	});

	it("hides the openai_api_key field when the provider is ollama", async () => {
		mockSettingsAndOllama({ signedIn: true, user: "alice", message: "ok" });
		render(<SettingsScreen onBack={vi.fn()} tab="ai-llm" />);

		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: /pi_agent_provider/ })).not.toBeNull();
		});
		expect(screen.queryByText("openai_api_key")).toBeNull();
		expect(screen.queryByLabelText(/openai_api_key/)).toBeNull();
	});

	it("shows the openai_api_key field when the provider is openai", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "/api/settings") {
				return Promise.resolve(jsonResponse({ settings: aiLlmSettingsWithProvider("openai") }));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<SettingsScreen onBack={vi.fn()} tab="ai-llm" />);

		await waitFor(() => {
			expect(screen.getByText("openai_api_key")).not.toBeNull();
		});
		expect((screen.getByRole("combobox", { name: /pi_agent_provider/ }) as HTMLSelectElement).value).toBe("openai");
		// Ollama-only UI is hidden when openai is selected.
		expect(screen.queryByText("Ollama sign-in status")).toBeNull();
	});

	it("renders the Ollama status panel for a signed-in account", async () => {
		mockSettingsAndOllama({ signedIn: true, user: "alice", message: "You are already signed in as user 'alice'" });
		render(<SettingsScreen onBack={vi.fn()} tab="ai-llm" />);

		await waitFor(() => {
			expect(screen.getByText(/Signed in as/)).not.toBeNull();
		});
		expect(screen.getByText("alice")).not.toBeNull();
	});

	it("renders the connect URL and CLI command when not signed in", async () => {
		mockSettingsAndOllama({
			signedIn: false,
			signInUrl: "https://ollama.com/connect?name=x&key=y",
			message: "You need to be signed in to Ollama to run Cloud models.",
		});
		render(<SettingsScreen onBack={vi.fn()} tab="ai-llm" />);

		const link = await screen.findByText("https://ollama.com/connect?name=x&key=y");
		expect(link.tagName).toBe("A");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(screen.getByText("Not signed in.")).not.toBeNull();
		expect(screen.getByText(/docker exec -it yolomatic-ollama ollama login/)).not.toBeNull();
	});

	it("renders an error with a retry control when the Ollama container cannot be reached", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "/api/settings") {
				return Promise.resolve(jsonResponse({ settings: MOCK_SETTINGS }));
			}
			if (url === "/api/ollama/signin") {
				return Promise.resolve(jsonResponse({
					signedIn: false,
					error: "No such container: yolomatic-ollama",
					message: "Ollama container \"yolomatic-ollama\" was not found.",
				}));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<SettingsScreen onBack={vi.fn()} tab="ai-llm" />);

		await waitFor(() => {
			expect(screen.getByText(/Could not reach the Ollama container/)).not.toBeNull();
		});
		expect(screen.getByRole("button", { name: /Re-check status/ })).not.toBeNull();

		const recheck = screen.getByRole("button", { name: /Re-check status/ });
		fireEvent.click(recheck);
		await waitFor(() => {
			expect(fetchSpy.mock.calls.filter(([input]) => {
				const url = typeof input === "string" ? input : input.url;
				return url === "/api/ollama/signin";
			}).length).toBeGreaterThanOrEqual(2);
		});
	});
});
