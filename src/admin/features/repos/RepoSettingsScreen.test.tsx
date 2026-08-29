// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RepoSettingsScreen } from "./RepoSettingsScreen.js";

const fetchSpy = vi.fn();

vi.stubGlobal("fetch", fetchSpy);

function jsonResponse(body: unknown) {
	return Promise.resolve({
		ok: true,
		json: async () => body,
	});
}

/** The pi_agent_build_model view the backend serves (override swappable per test). */
let buildModelOverride: string | null = null;
let buildModelPullResponses: Array<{ ok: boolean; error?: string }> = [];
const patchBodies: Array<Record<string, string>> = [];
const pullCalls: string[] = [];

function buildModelSettingView() {
	return {
		key: "pi_agent_build_model",
		value: buildModelOverride ?? "kimi-k2.7-code:cloud",
		default: "kimi-k2.7-code:cloud",
		override: buildModelOverride,
		inherited: !buildModelOverride,
		requiresRestart: false,
		description: "Build model used for this repository's implementation sessions.",
		providerDefault: "ollama",
	};
}

describe("RepoSettingsScreen", () => {
	beforeEach(() => {
		fetchSpy.mockReset();
		buildModelOverride = null;
		buildModelPullResponses = [];
		patchBodies.length = 0;
		pullCalls.length = 0;
		Object.defineProperty(window, "confirm", {
			value: vi.fn(() => true),
			writable: true,
			configurable: true,
		});
		fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/repos/mbrooks/yolomatic/settings" && (!init || init.method === undefined)) {
				return jsonResponse({
					settings: [
						{
							key: "github_event_mode",
							value: "polling",
							default: "webhook",
							override: "polling",
							inherited: false,
							requiresRestart: true,
							description: "desc",
							options: ["webhook", "polling", "both"],
						},
						{
							key: "default_branch",
							value: "master",
							default: "main",
							override: "master",
							inherited: false,
							requiresRestart: false,
							description: "branch desc",
						},
						{
							key: "worker_template",
							value: "python",
							default: "node",
							override: "python",
							inherited: false,
							requiresRestart: true,
							description: "worker image",
							options: ["node", "php", "python", "rust"],
							optionLabels: {
								node: "Node.js (workers/node.Dockerfile)",
								php: "PHP (workers/php.Dockerfile)",
								python: "Python (workers/python.Dockerfile)",
								rust: "Rust (workers/rust.Dockerfile)",
							},
						},
					{
						key: "issue_new_comment_enabled",
						value: "false",
						default: "true",
						override: "false",
						inherited: false,
						requiresRestart: false,
						description: "Post an automatic comment on newly opened issues.",
						options: ["true", "false"],
						optionLabels: { true: "Enabled", false: "Disabled" },
					},
					{
						key: "issue_admin_link_in_comments_enabled",
						value: "true",
						default: "true",
						override: null,
						inherited: true,
						requiresRestart: false,
						description: "Include a link to the admin UI in status comments.",
						options: ["true", "false"],
						optionLabels: { true: "Enabled", false: "Disabled" },
					},
					buildModelSettingView(),
					],
				});
			}
			if (url === "/api/repos/mbrooks/yolomatic/settings" && init?.method === "PATCH") {
				patchBodies.push(JSON.parse(String(init.body)) as Record<string, string>);
				const body = JSON.parse(String(init.body)) as Record<string, string>;
				const requirementsRestart = ["github_event_mode"].filter((key) => key in body);
				return jsonResponse({ updated: Object.keys(body), requiresRestart: requirementsRestart });
			}
			if (url === "/api/llm/models?provider=ollama") {
				return jsonResponse({ models: ["llama2", "kimi-k2.7-code:cloud"] });
			}
			if (url === "/api/llm/models?provider=openai") {
				return jsonResponse({ models: ["gpt-5.2"] });
			}
			if (url === "/api/ollama/pull" && init?.method === "POST") {
				pullCalls.push((JSON.parse(String(init.body)) as { model: string }).model);
				return jsonResponse(buildModelPullResponses.shift() ?? { ok: false, error: "pull model manifest: file does not exist" });
			}
			if (url === "/api/repos/mbrooks/yolomatic" && init?.method === "DELETE") {
				return jsonResponse({ removed: true });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
	});

	afterEach(() => {
		window.location.hash = "";
	});

	it("renders repo settings", async () => {
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});
		expect(screen.getByDisplayValue("polling")).toBeDefined();
		expect(screen.getByDisplayValue("master")).toBeDefined();
		const template = screen.getByRole("combobox", { name: /worker_template/ }) as HTMLSelectElement;
		expect(Array.from(template.options, (option) => option.value)).toContain("python");
		expect(screen.getByRole("option", { name: "Python (workers/python.Dockerfile)" })).toBeDefined();
	});

	it("saves repo setting changes", async () => {
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});
		fireEvent.change(screen.getByDisplayValue("polling"), { target: { value: "webhook" } });
		fireEvent.click(screen.getByText("Save Changes"));
		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				"/api/repos/mbrooks/yolomatic/settings",
				expect.objectContaining({ method: "PATCH" }),
			);
		});
		expect(screen.getByText("A restart is required for repository event-mode or worker-template changes to take effect.")).toBeDefined();
	});

		it("renders the comment-setting boolean overrides as true/false/inherit selects", async () => {
			render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
			await waitFor(() => {
				expect(screen.getByText("Repository Settings")).toBeDefined();
			});
			const newCommentSelect = screen.getByRole("combobox", { name: /issue_new_comment_enabled/ }) as HTMLSelectElement;
			expect(Array.from(newCommentSelect.options, (o) => o.value)).toEqual(["", "true", "false"]);
			expect(newCommentSelect.value).toBe("false");
			expect(Array.from(newCommentSelect.options, (o) => o.textContent)).toContain("Disabled");
			const adminLinkSelect = screen.getByRole("combobox", { name: /issue_admin_link_in_comments_enabled/ }) as HTMLSelectElement;
			expect(adminLinkSelect.value).toBe("");
			expect(screen.getAllByText(/Effective:/).length).toBeGreaterThan(0);
		});

		it("saves a cleared comment-setting override back to inherit", async () => {
			render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
			await waitFor(() => {
				expect(screen.getByText("Repository Settings")).toBeDefined();
			});
			const newCommentSelect = screen.getByRole("combobox", { name: /issue_new_comment_enabled/ }) as HTMLSelectElement;
			fireEvent.change(newCommentSelect, { target: { value: "" } });
			fireEvent.click(screen.getByText("Save Changes"));
			await waitFor(() => {
				expect(fetchSpy).toHaveBeenCalledWith(
				"/api/repos/mbrooks/yolomatic/settings",
				expect.objectContaining({ method: "PATCH" }),
				);
			});
			const call = fetchSpy.mock.calls.find((c) => c[0] === "/api/repos/mbrooks/yolomatic/settings" && c[1]?.method === "PATCH");
			const body = JSON.parse((call as any)[1].body);
			expect(body.issue_new_comment_enabled).toBe("");
		});

	it("removes the repository after confirmation and navigates to repos", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		window.location.hash = "#/repos/mbrooks/yolomatic/settings";
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		fireEvent.click(screen.getByRole("button", { name: /remove repository/i }));

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/yolomatic", { method: "DELETE" });
		});
		expect(window.location.hash).toBe("#/repos");
		confirmSpy.mockRestore();
	});

	it("does not remove the repository when confirmation is cancelled", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		fireEvent.click(screen.getByRole("button", { name: /remove repository/i }));

		expect(fetchSpy).not.toHaveBeenCalledWith(
			"/api/repos/mbrooks/yolomatic",
			expect.objectContaining({ method: "DELETE" }),
		);
		confirmSpy.mockRestore();
	});

	it("displays an error when removal fails", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		fetchSpy.mockRejectedValueOnce(new Error("Remove failed"));
		fireEvent.click(screen.getByRole("button", { name: /remove repository/i }));

		await waitFor(() => {
			expect(screen.getByText("Remove failed")).toBeDefined();
		});
		confirmSpy.mockRestore();
	});

	it("renders a provider selector and model dropdown for pi_agent_build_model instead of a text input", async () => {
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		// The model entry is a dropdown (the row's <label> targets a <select>), not a text input.
		const modelSelect = screen.getByLabelText(/pi_agent_build_model/) as HTMLSelectElement;
		expect(modelSelect.tagName).toBe("SELECT");
		await waitFor(() =>
			expect(Array.from(modelSelect.options).some((option) => option.value === "llama2")).toBe(true),
		);
		expect(Array.from(modelSelect.options).some((option) => option.value === "private")).toBe(true);
		// The inherit entry is selectable and labeled with the global build model.
		const options = Array.from(modelSelect.options);
		expect(options[0].disabled).toBe(false);
		expect(options[0].textContent).toBe("Use global default (kimi-k2.7-code:cloud)");
		expect(modelSelect.value).toBe("");

		// A provider selector sits next to the model dropdown.
		const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
		expect(providerSelect.tagName).toBe("SELECT");
		expect(Array.from(providerSelect.options, (option) => option.value)).toEqual(["", "ollama", "openai"]);
		expect(providerSelect.value).toBe("");
		expect(Array.from(providerSelect.options)[0].textContent).toBe("Use global default (ollama)");
	});

	it("decomposes a stored provider/model override into the provider select and custom model input", async () => {
		buildModelOverride = "openai/gpt-4.1";
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
		expect(providerSelect.value).toBe("openai");

		// The model list is fetched for the override's provider.
		const modelSelect = screen.getByLabelText(/pi_agent_build_model/) as HTMLSelectElement;
		await waitFor(() =>
			expect(Array.from(modelSelect.options).some((option) => option.value === "gpt-5.2")).toBe(true),
		);
		// gpt-4.1 is not an OpenAI catalog entry, so it renders as a custom identifier.
		const input = screen.getByLabelText("pi_agent_build_model (custom identifier)") as HTMLInputElement;
		expect(input.value).toBe("gpt-4.1");
	});

	it("composes the provider/model value when a provider and listed model are selected", async () => {
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
		fireEvent.change(providerSelect, { target: { value: "openai" } });

		const modelSelect = screen.getByLabelText(/pi_agent_build_model/) as HTMLSelectElement;
		await waitFor(() =>
			expect(Array.from(modelSelect.options).some((option) => option.value === "gpt-5.2")).toBe(true),
		);
		fireEvent.change(modelSelect, { target: { value: "gpt-5.2" } });

		fireEvent.click(screen.getByText("Save Changes"));
		await waitFor(() => expect(patchBodies).toHaveLength(1));
		expect(patchBodies[0].pi_agent_build_model).toBe("openai/gpt-5.2");
		// A listed OpenAI model needs no Ollama pull.
		expect(pullCalls).toHaveLength(0);
	});

	it("blocks saving when a custom Ollama identifier fails to pull", async () => {
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		const modelSelect = screen.getByLabelText(/pi_agent_build_model/) as HTMLSelectElement;
		await waitFor(() =>
			expect(Array.from(modelSelect.options).some((option) => option.value === "llama2")).toBe(true),
		);
		fireEvent.change(modelSelect, { target: { value: "private" } });
		const input = screen.getByLabelText("pi_agent_build_model (custom identifier)") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "bad-build-model" } });
		fireEvent.click(screen.getByText("Save Changes"));

		await waitFor(() => expect(pullCalls).toContain("bad-build-model"));
		await waitFor(() => {
			const banner = screen.getByText(/Check the model identifier you entered and retry/);
			expect(banner.textContent).toContain("bad-build-model");
		});
		expect(patchBodies).toHaveLength(0);
	});

	it("saves a custom Ollama identifier whose pull succeeds", async () => {
		buildModelPullResponses = [{ ok: true }];
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		const modelSelect = screen.getByLabelText(/pi_agent_build_model/) as HTMLSelectElement;
		await waitFor(() =>
			expect(Array.from(modelSelect.options).some((option) => option.value === "llama2")).toBe(true),
		);
		fireEvent.change(modelSelect, { target: { value: "private" } });
		const input = screen.getByLabelText("pi_agent_build_model (custom identifier)") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "good-build-model" } });
		fireEvent.blur(input);
		await waitFor(() => expect(pullCalls).toContain("good-build-model"));

		fireEvent.click(screen.getByText("Save Changes"));
		await waitFor(() => expect(patchBodies).toHaveLength(1));
		expect(patchBodies[0].pi_agent_build_model).toBe("good-build-model");
	});

	it("validates the decomposed model part of an Ollama override, never the composed provider/model string", async () => {
		buildModelOverride = "ollama/bad:tag";
		buildModelPullResponses = [
			{ ok: false, error: "pull model manifest: file does not exist" },
			{ ok: true },
		];
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		// The stored id is not a listed model, so it renders as a custom identifier.
		const modelSelect = screen.getByLabelText(/pi_agent_build_model/) as HTMLSelectElement;
		await waitFor(() =>
			expect(Array.from(modelSelect.options).some((option) => option.value === "llama2")).toBe(true),
		);
		const input = screen.getByLabelText("pi_agent_build_model (custom identifier)") as HTMLInputElement;
		expect(input.value).toBe("bad:tag");
		fireEvent.change(input, { target: { value: "also-bad:tag" } });
		fireEvent.blur(input);

		await waitFor(() => expect(pullCalls).toContain("also-bad:tag"));
		await waitFor(() => expect(screen.getByText(/Check the model identifier you entered and retry/)).not.toBeNull());
		expect(patchBodies).toHaveLength(0);

		// Correcting the identifier pulls the bare id and saves the composed override.
		fireEvent.change(input, { target: { value: "good:tag" } });
		fireEvent.blur(input);
		// The successful blur pull clears the blocked-save banner; wait for the
		// settled outcome before saving so the save gate does not re-pull.
		await waitFor(() => expect(screen.queryByText(/Check the model identifier you entered and retry/)).toBeNull());
		fireEvent.click(screen.getByText("Save Changes"));

		await waitFor(() => expect(patchBodies).toHaveLength(1));
		expect(patchBodies[0].pi_agent_build_model).toBe("ollama/good:tag");
		expect(pullCalls).not.toContain("ollama/good:tag");
	});

	it("clears the override back to inherit when the inherit entry is selected", async () => {
		buildModelOverride = "openai/gpt-4.1";
		render(<RepoSettingsScreen owner="mbrooks" repo="yolomatic" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		const modelSelect = screen.getByLabelText(/pi_agent_build_model/) as HTMLSelectElement;
		fireEvent.change(modelSelect, { target: { value: "" } });

		fireEvent.click(screen.getByText("Save Changes"));
		await waitFor(() => expect(patchBodies).toHaveLength(1));
		expect(patchBodies[0].pi_agent_build_model).toBe("");
	});
});
