import { useEffect, useState } from "react";

export const SETTINGS_CATEGORY_TABS = [
	{ slug: "github-integration", label: "GitHub Integration" },
	{ slug: "authentication", label: "Authentication" },
	{ slug: "server", label: "Server" },
	{ slug: "file-system", label: "File System" },
	{ slug: "git-worktrees", label: "Git & Worktrees" },
	{ slug: "agent-behavior", label: "Agent Behavior" },
	{ slug: "ai-llm", label: "AI / LLM" },
	{ slug: "logging", label: "Logging" },
] as const;

export type SettingsCategoryTab = typeof SETTINGS_CATEGORY_TABS[number]["slug"];

export const SETTINGS_TAB_SLUGS: readonly SettingsCategoryTab[] = SETTINGS_CATEGORY_TABS.map((t) => t.slug);

export const DEFAULT_SETTINGS_TAB: SettingsCategoryTab = SETTINGS_CATEGORY_TABS[0].slug;

export type Route =
	| { screen: "dashboard" }
	| { screen: "repos" }
	| { screen: "repo"; owner: string; repo: string; issueNumber?: number; tab?: "sessions" | "skills" | "issues" | "settings" }
	| { screen: "working"; owner?: string; repo?: string; issueNumber?: number }
	| { screen: "new-issue"; owner?: string; repo?: string }
	| { screen: "settings"; tab?: "skills" | "invitations" | SettingsCategoryTab };

export function parseHash(hash: string): Route {
	const path = hash.replace(/^#/, "").replace(/^\//, "").split("/").filter(Boolean);
	if (path[0] === "new-issue") {
		if (path.length >= 3) {
			return { screen: "new-issue", owner: decodeURIComponent(path[1]), repo: decodeURIComponent(path[2]) };
		}
		return { screen: "new-issue" };
	}
	if (path[0] === "settings") {
		const slug = path[1];
		if (slug === "skills" || slug === "invitations") {
			return { screen: "settings", tab: slug };
		}
		if (slug && SETTINGS_TAB_SLUGS.includes(slug as SettingsCategoryTab)) {
			return { screen: "settings", tab: slug as SettingsCategoryTab };
		}
		return { screen: "settings", tab: DEFAULT_SETTINGS_TAB };
	}
	if (path[0] === "dashboard") {
		return { screen: "dashboard" };
	}
	if (path[0] === "repos") {
		if (path.length >= 3) {
			const owner = decodeURIComponent(path[1]);
			const repo = decodeURIComponent(path[2]);
			let issueNumber: number | undefined;
			let tab: "sessions" | "skills" | "issues" | "settings" = "sessions";
			if (path[3]) {
				if (path[3] === "skills" || path[3] === "issues" || path[3] === "sessions" || path[3] === "settings") {
					tab = path[3];
					if (path[4]) {
						const num = Number.parseInt(path[4], 10);
						if (!Number.isNaN(num)) {
							issueNumber = num;
						}
					}
				} else {
					issueNumber = Number.parseInt(path[3], 10);
					if (Number.isNaN(issueNumber)) {
						issueNumber = undefined;
					}
				}
			}
			return { screen: "repo", owner, repo, issueNumber, tab };
		}
		return { screen: "repos" };
	}
	if (path[0] === "working") {
		const owner = path[1] ? decodeURIComponent(path[1]) : undefined;
		const repo = path[2] ? decodeURIComponent(path[2]) : undefined;
		const issueNumber = path[3] ? Number.parseInt(path[3], 10) : undefined;
		return { screen: "working", owner, repo, issueNumber: Number.isNaN(issueNumber) ? undefined : issueNumber };
	}
	return { screen: "dashboard" };
}

export function buildHash(route: Route): string {
	if (route.screen === "settings") {
		if (route.tab === "skills") return "#/settings/skills";
		if (route.tab === "invitations") return "#/settings/invitations";
		if (route.tab && SETTINGS_TAB_SLUGS.includes(route.tab)) {
			return `#/settings/${route.tab}`;
		}
		return "#/settings";
	}
	if (route.screen === "dashboard") return "#/dashboard";
	if (route.screen === "repos") return "#/repos";
	if (route.screen === "new-issue") {
		if (route.owner && route.repo) {
			return `#/new-issue/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`;
		}
		return "#/new-issue";
	}
	if (route.screen === "repo") {
		const base = `#/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`;
		const tab = route.tab === "skills" ? "/skills" : route.tab === "issues" ? "/issues" : route.tab === "settings" ? "/settings" : "";
		if (route.issueNumber !== undefined) {
			return `${base}${tab}/${route.issueNumber}`;
		}
		return `${base}${tab}`;
	}
	if (route.screen === "working") {
		const base = "#/working";
		if (route.owner && route.repo && route.issueNumber !== undefined) {
			return `${base}/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/${route.issueNumber}`;
		}
		return base;
	}
	return "#/dashboard";
}

export function navigate(route: Route): void {
	window.location.hash = buildHash(route);
}

export function useRoute(): Route {
	const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

	useEffect(() => {
		const handler = () => setRoute(parseHash(window.location.hash));
		window.addEventListener("hashchange", handler);
		return () => window.removeEventListener("hashchange", handler);
	}, []);

	return route;
}
