import { useEffect, useState } from "react";

export type Route =
	| { screen: "repos" }
	| { screen: "repo"; owner: string; repo: string; issueNumber?: number }
	| { screen: "working"; owner?: string; repo?: string; issueNumber?: number };

export function parseHash(hash: string): Route {
	const path = hash.replace(/^#/, "").replace(/^\//, "").split("/").filter(Boolean);
	if (path[0] === "repos") {
		if (path.length >= 3) {
			const owner = decodeURIComponent(path[1]);
			const repo = decodeURIComponent(path[2]);
			const issueNumber = path[3] ? Number.parseInt(path[3], 10) : undefined;
			return { screen: "repo", owner, repo, issueNumber: Number.isNaN(issueNumber) ? undefined : issueNumber };
		}
		return { screen: "repos" };
	}
	if (path[0] === "working") {
		const owner = path[1] ? decodeURIComponent(path[1]) : undefined;
		const repo = path[2] ? decodeURIComponent(path[2]) : undefined;
		const issueNumber = path[3] ? Number.parseInt(path[3], 10) : undefined;
		return { screen: "working", owner, repo, issueNumber: Number.isNaN(issueNumber) ? undefined : issueNumber };
	}
	return { screen: "repos" };
}

export function buildHash(route: Route): string {
	if (route.screen === "repos") return "#/repos";
	if (route.screen === "repo") {
		const base = `#/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`;
		return route.issueNumber !== undefined ? `${base}/${route.issueNumber}` : base;
	}
	if (route.screen === "working") {
		const base = "#/working";
		if (route.owner && route.repo && route.issueNumber !== undefined) {
			return `${base}/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/${route.issueNumber}`;
		}
		return base;
	}
	return "#/repos";
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
