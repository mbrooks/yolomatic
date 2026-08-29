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

	it("keeps the empty placeholder disabled when no emptyOptionLabel is provided", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		render(
			<LlmModelSelect
				provider="ollama"
				value=""
				onChange={vi.fn()}
				fetcher={fetcher}
				/>,
		);

		const select = await screen.findByLabelText("LLM Model") as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));
		expect(select.options[0].disabled).toBe(true);
		expect(select.options[0].textContent).toBe("Select a model…");
	});

	it("renders an inherit option and calls onChange with an empty value when emptyOptionLabel is provided", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const onChange = vi.fn();
		render(
			<LlmModelSelect
				provider="ollama"
				value=""
				onChange={onChange}
				fetcher={fetcher}
				emptyOptionLabel="Use global default (ollama)"
				/>,
		);

		const select = await screen.findByLabelText("LLM Model") as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));
		const options = Array.from(select.options);
		expect(options.map((o) => o.value)).toEqual(["", "llama2", PRIVATE_MODEL_VALUE]);
		expect(options[0].disabled).toBe(false);
		expect(options[0].textContent).toBe("Use global default (ollama)");

		// Re-selecting the inherit entry reports clearing the value upward.
		fireEvent.change(select, { target: { value: "llama2" } });
		expect(onChange).toHaveBeenCalledWith("llama2");
		fireEvent.change(select, { target: { value: "" } });
		expect(onChange).toHaveBeenLastCalledWith("");
		// The custom identifier input must not appear for the inherit selection.
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

	it("reports settled pull outcomes upstream for listed selections and custom pulls", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const puller = vi
			.fn()
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: false, error: "pull model manifest: file does not exist" });
		const onPullResult = vi.fn();
		render(
			<LlmModelSelect
				provider="ollama"
				value="llama2"
				onChange={vi.fn()}
				fetcher={fetcher}
				puller={puller}
				onPullResult={onPullResult}
			/>,
		);

		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));

		// Re-selecting the listed model reports ok without any pull call.
		fireEvent.change(select, { target: { value: "llama2" } });
		expect(puller).not.toHaveBeenCalled();
		expect(onPullResult).toHaveBeenCalledWith({ model: "llama2", ok: true });

		// Selecting private triggers a pull of the current value that succeeds.
		fireEvent.change(select, { target: { value: PRIVATE_MODEL_VALUE } });
		await waitFor(() => expect(puller).toHaveBeenCalledWith("llama2"));
		await waitFor(() => expect(onPullResult).toHaveBeenNthCalledWith(2, { model: "llama2", ok: true }));

		// Blurring a failed custom identifier reports the failure with the error.
		const input = (await screen.findByLabelText("LLM Model (custom identifier)")) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "custom:tag" } });
		fireEvent.blur(input);
		await waitFor(() => expect(puller).toHaveBeenNthCalledWith(2, "custom:tag"));
		await screen.findByText(/Could not pull Ollama model/i);
		await waitFor(() =>
			expect(onPullResult).toHaveBeenNthCalledWith(3, {
				model: "custom:tag",
				ok: false,
				error: "pull model manifest: file does not exist",
			}),
		);
	});

	it("does not pull or report outcomes when no puller is wired", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const onPullResult = vi.fn();
		render(
			<LlmModelSelect
				provider="ollama"
				value="llama2"
				onChange={vi.fn()}
				fetcher={fetcher}
				onPullResult={onPullResult}
			/>,
		);
		const select = (await screen.findByLabelText("LLM Model")) as HTMLSelectElement;
		await waitFor(() => expect(select.disabled).toBe(false));
		fireEvent.change(select, { target: { value: "llama2" } });
		expect(onPullResult).not.toHaveBeenCalled();
	});

	it("keeps a failed-pull warning when the parent value round-trips through a stale listed value", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const puller = vi.fn(async () => ({ ok: false, error: "pull model manifest: file does not exist" }));
		const { rerender } = render(
			<LlmModelSelect
				provider="ollama"
				value="custom-model"
				onChange={vi.fn()}
				fetcher={fetcher}
				puller={puller}
			/>,
		);

		const input = (await screen.findByLabelText("LLM Model (custom identifier)")) as HTMLInputElement;
		fireEvent.blur(input);
		await screen.findByText(/Could not pull Ollama model/i);

		// A parent refresh briefly renders a stale listed value: the private
		// input hides, but the warning must not be discarded.
		rerender(
			<LlmModelSelect
				provider="ollama"
				value="llama2"
				onChange={vi.fn()}
				fetcher={fetcher}
				puller={puller}
			/>,
		);
		await waitFor(() => expect(screen.queryByLabelText("LLM Model (custom identifier)")).toBeNull());

		// When the parent returns to the custom value, the warning is still there.
		rerender(
			<LlmModelSelect
				provider="ollama"
				value="custom-model"
				onChange={vi.fn()}
				fetcher={fetcher}
				puller={puller}
			/>,
		);
		await waitFor(() => expect(screen.getByLabelText("LLM Model (custom identifier)")).not.toBeNull());
		expect(screen.getByText(/Could not pull Ollama model/i)).not.toBeNull();
	});

	it("clears a failed-pull warning when the provider changes away from ollama", async () => {
		fetcher.mockResolvedValue({ models: ["llama2"] });
		const puller = vi.fn(async () => ({ ok: false, error: "pull model manifest: file does not exist" }));
		const { rerender } = render(
			<LlmModelSelect
				provider="ollama"
				value="custom-model"
				onChange={vi.fn()}
				fetcher={fetcher}
				puller={puller}
			/>,
		);

		const input = (await screen.findByLabelText("LLM Model (custom identifier)")) as HTMLInputElement;
		fireEvent.blur(input);
		await screen.findByText(/Could not pull Ollama model/i);

		fetcher.mockResolvedValue({ models: ["gpt-5.2-codex"] });
		rerender(
			<LlmModelSelect
				provider="openai"
				value="gpt-5.2-codex"
				onChange={vi.fn()}
				fetcher={fetcher}
				apiKey="sk-test"
			/>,
		);
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
