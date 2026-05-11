import type { AgentStatus } from "../app/types.js";

export function formatRelative(iso: string): string {
	const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export function labelAgentStatus(status: AgentStatus): string {
	if (status === "online") return "Online";
	if (status === "busy") return "Busy";
	if (status === "feedback") return "Feedback";
	return "Offline";
}
