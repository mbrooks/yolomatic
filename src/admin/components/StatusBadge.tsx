import React from "react";
import { labelAgentStatus } from "../lib/format.js";
import type { AgentStatus } from "../app/types.js";

const STATUS_CLASS_NAMES: Record<AgentStatus, string> = {
	online: "text-green",
	busy: "animate-pulse text-yellow",
	feedback: "text-blue",
	offline: "text-red",
};

export function StatusBadge({ status }: { status: AgentStatus }): React.ReactElement {
	return (
		<span
			className={[
				"inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1",
				"text-xs font-semibold uppercase tracking-[0.04em]",
				STATUS_CLASS_NAMES[status],
			].join(" ")}
		>
			{labelAgentStatus(status)}
		</span>
	);
}
