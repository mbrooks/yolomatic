// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { LlmModelSelect, PRIVATE_MODEL_VALUE } from "./LlmModelSelect.js";
import type { LlmModelListResult } from "../../api/settings.js";

function mockResult(result: LlmModelListResult): Promise<LlmModelListResult> {
	return Promise.resolve(result);
}

describe("LlmModelSelect", () => {
	let fetcher: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetcher = vi.fn(async (): Promise<LlmModelListResult> => mockResult({ models: [] }));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows a loading placeholder while fetching", async () => {
		fetcher.mockImplementation(() => new Promise(() => {}));
		render(
			<LlmModelSelect
				provider="ollama"
				value=""
				onChange={vi.fn()}
				fetcher={fetcher}
			/>,
		);
		const select = screen.getByLabelText("LLM Model") as HTMLSelectElement;
		expect(select.disabled).toBe(true);
		expect(select.value).toBe("");
		expect(Array.from(select.options)[0].textContent).toBe("Loading models...");
	});

	it("renders fetched models and pre-selects the controlled value", async () => {
		fetcher.mockResolvedValue({ models: ["llama2", "mistral"] });
		render(
			<LlmModelSelect
				provider="ollama"
				value="mistral"
				onChange={vi.fn()}
				fetcher={fetcher}
			/>,
		);

		const select = await screen.findByLabelText("LLM Model") as HTMLSelectElement;
		await waitFor(() => expect(select.value).toBe("mistral"));
		expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "llama2", "mistral", PRIVATE_MODEL_VALUE]);
		expect(screen.queryByLabelText("LLM Model (custom identifier)")).toBeNull();
	});

	it("renders tagged Ollama identifiers and pre-selects a tagged value", async () => {
		fetcher.mockResolvedValue({ models: ["kimi-k2.7-code:cloud", "llama3.2:latest"] });
		render(
			<LlmModelSelect
				provider="ollama"
				value="kimi-k2.7-code:cloud"
				onChange={vi.fn()}
				fetcher={fetcher}
			/>,
		);

		const select = await screen.findByLabelText("LLM Model") as HTMLSelectElement;
		await waitFor(() => expect(select.value).toBe("kimi-k2.7-code:cloud"));
		expect(Array.from(select.options).map((o) => o.value)).toEqual([
			"",
			"kimi-k2.7-code:cloud",
			"llama3.2:latest",
			PRIVATE_MODEL_VALUE,
		]);
		expect(screen.queryByLabelText("LLM Model (custom identifier)")).toBeNull();
	});

	it("shows the private input when the value is not in the model list", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		render(
			<LlmModelSelect
				provider="ollama"
				value="custom-model"
				onChange={vi.fn()}
				fetcher={fetcher}
			/>,
		);

		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));
		await waitFor(() => expect(select.value).toBe(PRIVATE_MODEL_VALUE));
		const input = screen.getByLabelText("LLM Model (custom identifier)") as HTMLInputElement;
		expect(input.value).toBe("custom-model");
	});

	it("switches to private and reveals the manual input when private is selected", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const onChange = vi.fn();
		render(
			<LlmModelSelect
				provider="ollama"
				value="llama2"
				onChange={onChange}
				fetcher={fetcher}
			/>,
		);

		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));
		fireEvent.change(select, { target: { value: PRIVATE_MODEL_VALUE } });
		const input = (await screen.findByLabelText("LLM Model (custom identifier)")) as HTMLInputElement;
		expect(input.value).toBe("llama2");
		expect(onChange).toHaveBeenCalledWith("llama2");
	});

	it("calls onChange with the typed custom model identifier", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const onChange = vi.fn();
		render(
			<LlmModelSelect
				provider="ollama"
				value="llama2"
				onChange={onChange}
				fetcher={fetcher}
			/>,
		);

		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));
		fireEvent.change(select, { target: { value: PRIVATE_MODEL_VALUE } });
		const input = (await screen.findByLabelText("LLM Model (custom identifier)")) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "custom:tag" } });
		expect(onChange).toHaveBeenLastCalledWith("custom:tag");
	});

	it("shows a disabled placeholder and keeps the form usable when the prerequisite is missing", async () => {
		fetcher.mockResolvedValue({ models: [], error: "Enter an OpenAI API key to load models" });
		render(
			<LlmModelSelect
				provider="openai"
				value=""
				onChange={vi.fn()}
				fetcher={fetcher}
			/>,
		);

		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		expect(select.value).toBe("");
		const firstOption = select.options[0];
		expect(firstOption.disabled).toBe(true);
		expect(firstOption.textContent).toBe("Enter an OpenAI API key to load models");
		expect(select.options[select.options.length - 1].value).toBe(PRIVATE_MODEL_VALUE);
		expect(screen.queryByLabelText("LLM Model (custom identifier)")).toBeNull();
	});

	it("re-fetches when the provider changes", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const { rerender } = render(
			<LlmModelSelect
				provider="ollama"
				value=""
				onChange={vi.fn()}
				fetcher={fetcher}
			/>,
		);
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

		fetcher.mockResolvedValue({ models: ["gpt-4"] });
		rerender(
			<LlmModelSelect
				provider="openai"
				value=""
				onChange={vi.fn()}
				fetcher={fetcher}
				apiKey="sk-test"
			/>,
		);
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		expect(fetcher).toHaveBeenLastCalledWith("openai", "sk-test");
	});

	it("clears the old model list when the provider changes", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const { rerender } = render(
			<LlmModelSelect provider="ollama" value="" onChange={vi.fn()} fetcher={fetcher} />,
		);

		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		await waitFor(() => expect(Array.from(select.options).some((o) => o.value === "llama2")).toBe(true));

		// Switch provider and keep the request hanging so we can assert the UI
		// does not keep rendering stale options while loading.
		fetcher.mockImplementation(() => new Promise(() => {}));
		rerender(
			<LlmModelSelect provider="openai" value="" onChange={vi.fn()} fetcher={fetcher} apiKey="sk-test" />,
		);

		await waitFor(() => {
			expect(select.disabled).toBe(true);
			expect(Array.from(select.options).some((o) => o.value === "llama2")).toBe(false);
			// Placeholder remains present.
			expect(select.options[0].value).toBe("");
		});
	});

	it("attempts to pull a custom Ollama model and shows a non-blocking warning when pulling fails", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const puller = vi.fn(async () => ({ ok: false, error: "pull model manifest: file does not exist" }));
		render(
			<LlmModelSelect
				provider="ollama"
				value="llama2"
				onChange={vi.fn()}
				fetcher={fetcher}
				puller={puller}
			/>,
		);

		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));
		fireEvent.change(select, { target: { value: PRIVATE_MODEL_VALUE } });

		await waitFor(() => expect(puller).toHaveBeenCalledWith("llama2"));
		const warning = await screen.findByText(/Could not pull Ollama model/i);
		expect(warning.textContent).toContain("pull model manifest");

		// Warning is informational; the input remains usable.
		const input = (await screen.findByLabelText("LLM Model (custom identifier)")) as HTMLInputElement;
		expect(input.disabled).toBe(false);
	});

	it("clears the pull warning once a later pull attempt succeeds", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const puller = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, error: "manifest missing" })
			.mockResolvedValueOnce({ ok: true });
		render(
			<LlmModelSelect
				provider="ollama"
				value="llama2"
				onChange={vi.fn()}
				fetcher={fetcher}
				puller={puller}
			/>,
		);

		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));
		fireEvent.change(select, { target: { value: PRIVATE_MODEL_VALUE } });

		await screen.findByText(/Could not pull Ollama model/i);

		const input = (await screen.findByLabelText("LLM Model (custom identifier)")) as HTMLInputElement;
		fireEvent.blur(input);

		await waitFor(() => expect(puller).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.queryByText(/Could not pull Ollama model/i)).toBeNull());
	});

	it("does not fetch for an unsupported provider", async () => {
		render(
			<LlmModelSelect
				provider="anthropic"
				value=""
				onChange={vi.fn()}
				fetcher={fetcher}
			/>,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fetcher).not.toHaveBeenCalled();
	});
});
