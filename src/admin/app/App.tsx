import React, { useCallback, useMemo, useState } from "react";
import { useServerState } from "../hooks/useServerState.js";
import { useRoute, navigate, type Route } from "./routes.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { RestartBanner } from "../components/RestartBanner.js";
import { RepoListScreen } from "../features/repos/RepoListScreen.js";
import { SessionScreen } from "../features/sessions/SessionScreen.js";
import { CronScreen } from "../features/crons/CronScreen.js";
import { isInProgressStatus } from "../lib/status-helpers.js";
import type { AgentStatus, Session } from "./types.js";

export function App(): React.ReactElement {
	const [tick, setTick] = useState(0);
	const serverState = useServerState(tick);
	const route = useRoute();

	const agentStatus: AgentStatus = serverState.status === "ready" ? serverState.data.agent : "offline";
	const sessions = serverState.status === "ready" ? serverState.data.sessions : [];
	const repos = serverState.status === "ready" ? serverState.data.repos : [];

	const workingSessions = useMemo(() => sessions.filter((s) => isInProgressStatus(s.status)), [sessions]);
	const inProgressCount = workingSessions.length;

	const handleMutate = useCallback(() => {
		setTick((t) => t + 1);
	}, []);

	const selectedSession = useMemo(() => {
		if (route.screen === "repos") return null;
		if (route.issueNumber === undefined) return null;
		return (
			sessions.find(
				(s) =>
					s.owner === route.owner && s.repo === route.repo && s.issueNumber === route.issueNumber,
			) ?? null
		);
	}, [sessions, route]);

	const handleSelectRepo = useCallback((owner: string, repo: string) => {
		navigate({ screen: "repo", owner, repo });
	}, []);

	const handleSelectWorking = useCallback(() => {
		navigate({ screen: "working" });
	}, []);

	const handleBackToRepos = useCallback(() => {
		navigate({ screen: "repos" });
	}, []);

	const handleSelectSession = useCallback(
		(session: Session) => {
			const next: Route =
				route.screen === "repo"
					? { screen: "repo", owner: route.owner, repo: route.repo, issueNumber: session.issueNumber, tab: route.tab }
					: {
							screen: "working",
							owner: session.owner,
							repo: session.repo,
							issueNumber: session.issueNumber,
						};
			navigate(next);
		},
		[route],
	);

	const handleSelectTab = useCallback(
		(tab: "sessions" | "crons") => {
			if (route.screen === "repo") {
				navigate({ screen: "repo", owner: route.owner, repo: route.repo, tab });
			}
		},
		[route],
	);

	const lastUpdated = useMemo(() => {
		if (serverState.status === "loading") return "Loading...";
		if (serverState.status === "error") return `Error: ${serverState.error}`;
		return `Last updated: ${serverState.updatedAt.toLocaleTimeString()}`;
	}, [serverState]);

	const repoSessions = useMemo(() => {
		if (route.screen !== "repo") return [];
		return sessions.filter((s) => s.owner === route.owner && s.repo === route.repo);
	}, [sessions, route]);

	return (
		<div className="app">
			{serverState.status === "ready" && serverState.data.draining && <RestartBanner />}
			<header>
				<h1>TARS Admin</h1>
				<div className="header-actions">
					<StatusBadge status={agentStatus} />
				</div>
			</header>

			{serverState.status === "error" ? (
				<div className="empty">Unable to reach API</div>
			) : (
				<>
					{route.screen === "repos" && (
						<RepoListScreen
							repos={repos}
							inProgressCount={inProgressCount}
							onSelectRepo={handleSelectRepo}
							onSelectWorking={handleSelectWorking}
						/>
					)}

					{route.screen === "working" && (
						<SessionScreen
							sessions={workingSessions}
							selected={selectedSession}
							onSelect={handleSelectSession}
							onMutate={handleMutate}
							breadcrumbLabel="Active Tasks"
							onBack={handleBackToRepos}
							emptyMessage="No active tasks."
						/>
					)}

					{route.screen === "repo" && (
						<>
							{route.tab === "crons" ? (
								<CronScreen
									owner={route.owner}
									repo={route.repo}
									activeTab={route.tab ?? "sessions"}
									onSelectTab={handleSelectTab}
									onBack={handleBackToRepos}
								/>
							) : (
								<SessionScreen
									sessions={repoSessions}
									selected={selectedSession}
									onSelect={handleSelectSession}
									onMutate={handleMutate}
									breadcrumbLabel={`${route.owner}/${route.repo}`}
									onBack={handleBackToRepos}
									emptyMessage="No sessions for this repository."
									activeTab={route.tab ?? "sessions"}
									onSelectTab={handleSelectTab}
								/>
							)}
						</>
					)}
				</>
			)}

			<div className="last-updated">{lastUpdated}</div>
		</div>
	);
}
