import React from "react";
import { labelAgentStatus } from "../lib/format.js";
import type { AgentStatus } from "../app/types.js";

export function StatusBadge({ status }: { status: AgentStatus }): React.ReactElement {
	return <span className={`badge ${status}`}>{labelAgentStatus(status)}</span>;
}
