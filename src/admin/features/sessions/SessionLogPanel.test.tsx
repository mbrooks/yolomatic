// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { SessionLogPanel } from "./SessionLogPanel.js";
import type { LogEntry } from "../../app/types.js";

const modelRunEntry: LogEntry = {
	timestamp: "2026-04-23T10:00:00.000Z",
	level: "info",
	message:
		"Running on deepseek-v4-flash:0731-cloud, served through Ollama (openai-completions API). " +
		"Reasoning is enabled at medium effort, with a 1M-token context window and 64K max output tokens.",
	details: { type: "model", provider: "ollama", modelId: "deepseek-v4-flash:0731-cloud" },
};

describe("SessionLogPanel", () => {
	it("renders an empty feed when there are no logs", () => {
		const { container } = render(
			<SessionLogPanel state={{ status: "ready", logs: [], error: null, refreshing: false }} paused={false} onPauseToggle={() => {}} />,
		);
		expect(container.querySelector(".log-feed")?.textContent).toContain("No logs");
	});

	it("renders the model run line with context size, output tokens, and reasoning effort", () => {
		const { container } = render(
			<SessionLogPanel state={{ status: "ready", logs: [modelRunEntry], error: null, refreshing: false }} paused={false} onPauseToggle={() => {}} />,
		);

		const feed = container.querySelector(".log-feed");
		expect(feed).not.toBeNull();
		expect(feed?.textContent).toContain("Running on deepseek-v4-flash:0731-cloud");
		expect(feed?.textContent).toContain("1M-token context window");
		expect(feed?.textContent).toContain("64K max output tokens");
		expect(feed?.textContent).toContain("Reasoning is enabled at medium effort");
	});
});