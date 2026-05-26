import React, { useCallback, useMemo, useState } from "react";
import { useServerState } from "../hooks/useServerState.js";
import { useRoute, navigate, type Route } from "./routes.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { RestartBanner } from "../components/RestartBanner.js";
import { RepoInventoryScreen } from "../features/repos/RepoInventoryScreen.js";
import { SessionScreen } from "../features/sessions/SessionScreen.js";
import { CronScreen } from "../features/crons/CronScreen.js";
import { DashboardScreen } from "../features/dashboard/DashboardScreen.js";
import { NewIssueScreen } from "../features/new-issue/NewIssueScreen.js";
import { SettingsScreen } from "../features/settings/SettingsScreen.js";
import { isInProgressStatus } from "../lib/status-helpers.js";
import type { AgentStatus, RepoSummary, Session } from "./types.js";

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
		if (route.screen === "dashboard" || route.screen === "repos" || route.screen === "new-issue" || route.screen === "settings") return null;
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

	const handleBackToDashboard = useCallback(() => {
		navigate({ screen: "dashboard" });
	}, []);

	const handleSelectReposList = useCallback(() => {
		navigate({ screen: "repos" });
	}, []);

	const handleSelectSession = useCallback(
		(session: Session) => {
			const next: Route =
				route.screen === "repo"
					? { screen: "repo", owner: route.owner, repo: route.repo, issueNumber: session.issueNumber, tab: route.tab }
					: route.screen === "working"
						? {
								screen: "working",
								owner: session.owner,
								repo: session.repo,
								issueNumber: session.issueNumber,
							}
							: {
									screen: "repo",
									owner: session.owner,
									repo: session.repo,
									issueNumber: session.issueNumber,
									tab: "sessions",
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

	const isNewIssueActive = route.screen === "new-issue";
	const isSettingsActive = route.screen === "settings";

	const handleNewIssue = useCallback(() => {
		navigate({ screen: "new-issue" });
	}, []);

	const handleSelectSettings = useCallback(() => {
		navigate({ screen: "settings" });
	}, []);

	const handleNewIssueForRepo = useCallback(() => {
		if (route.screen === "repo") {
			navigate({ screen: "new-issue", owner: route.owner, repo: route.repo });
		} else {
			navigate({ screen: "new-issue" });
		}
	}, [route]);

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
			<AppHeader
				agentStatus={agentStatus}
				isNewIssueActive={isNewIssueActive}
				isSettingsActive={isSettingsActive}
				onNewIssue={handleNewIssue}
				onSettings={handleSelectSettings}
			/>

			{serverState.status === "error" ? (
				<div className="empty">Unable to reach API</div>
			) : (
				<AppContent
					route={route}
					repos={repos}
					inProgressCount={inProgressCount}
					workingSessions={workingSessions}
					repoSessions={repoSessions}
					selectedSession={selectedSession}
					sessions={sessions}
					agentStatus={agentStatus}
					uptime={serverState.status === "ready" ? serverState.data.uptime : ""}
					draining={serverState.status === "ready" ? serverState.data.draining : false}
					onSelectRepo={handleSelectRepo}
					onSelectWorking={handleSelectWorking}
					onSelectSession={handleSelectSession}
					onMutate={handleMutate}
					onBack={handleBackToDashboard}
					onSelectRepos={handleSelectReposList}
					onSelectTab={handleSelectTab}
					onNewIssueForRepo={handleNewIssueForRepo}
					onSelectSettings={handleSelectSettings}
				/>
			)}

			<div className="last-updated">{lastUpdated}</div>
		</div>
	);
}

function AppHeader({
	agentStatus,
	isNewIssueActive,
	isSettingsActive,
	onNewIssue,
	onSettings,
}: {
	agentStatus: AgentStatus;
	isNewIssueActive: boolean;
	isSettingsActive: boolean;
	onNewIssue: () => void;
	onSettings: () => void;
}): React.ReactElement {
	return (
		<header>
			<h1>TARS Admin</h1>
			<div className="header-actions">
				<button
					className={`global-tab${isSettingsActive ? " active" : ""}`}
					onClick={onSettings}
					type="button"
				>
					Settings
				</button>
				<button
					className={`global-tab${isNewIssueActive ? " active" : ""}`}
					onClick={onNewIssue}
					type="button"
				>
					Create New Issue
				</button>
				<StatusBadge status={agentStatus} />
			</div>
		</header>
	);
}

function AppContent({
	route,
	repos,
	inProgressCount,
	workingSessions,
	repoSessions,
	selectedSession,
	agentStatus,
	uptime,
	draining,
	sessions,
	onSelectRepo,
	onSelectWorking,
	onSelectSession,
	onMutate,
	onBack,
	onSelectRepos,
	onSelectTab,
	onNewIssueForRepo,
	onSelectSettings,
}: {
	route: Route;
	repos: RepoSummary[];
	inProgressCount: number;
	workingSessions: Session[];
	repoSessions: Session[];
	selectedSession: Session | null;
	agentStatus: AgentStatus;
	uptime: string;
	draining: boolean;
	sessions: Session[];
	onSelectRepo: (owner: string, repo: string) => void;
	onSelectWorking: () => void;
	onSelectSession: (session: Session) => void;
	onMutate: () => void;
	onBack: () => void;
	onSelectRepos: () => void;
	onSelectTab: (tab: "sessions" | "crons") => void;
	onNewIssueForRepo: () => void;
	onSelectSettings: () => void;
}): React.ReactElement {
	if (route.screen === "dashboard") {
		return (
			<DashboardScreen
				agentStatus={agentStatus}
				uptime={uptime}
				draining={draining}
				repos={repos}
				sessions={sessions}
				onSelectWorking={onSelectWorking}
				onSelectRepos={onSelectRepos}
				onNewIssue={onNewIssueForRepo}
				onSelectSession={onSelectSession}
			/>
		);
	}

	if (route.screen === "repos") {
		return (
			<RepoInventoryScreen
				repos={repos}
				inProgressCount={inProgressCount}
				onSelectRepo={onSelectRepo}
				onSelectWorking={onSelectWorking}
				onBack={onBack}
			/>
		);
	}

	if (route.screen === "working") {
		return (
			<SessionScreen
				sessions={workingSessions}
				selected={selectedSession}
				onSelect={onSelectSession}
				onMutate={onMutate}
				breadcrumbLabel="Active Tasks"
				onBack={onBack}
				emptyMessage="No active tasks."
			/>
		);
	}

	if (route.screen === "repo") {
		return route.tab === "crons" ? (
			<CronScreen
				owner={route.owner}
				repo={route.repo}
				activeTab={route.tab ?? "sessions"}
				onSelectTab={onSelectTab}
				onBack={onBack}
				onNewIssue={onNewIssueForRepo}
			/>
		) : (
			<SessionScreen
				sessions={repoSessions}
				selected={selectedSession}
				onSelect={onSelectSession}
				onMutate={onMutate}
				breadcrumbLabel={`${route.owner}/${route.repo}`}
				onBack={onBack}
				emptyMessage="No sessions for this repository."
				activeTab={route.tab ?? "sessions"}
				onSelectTab={onSelectTab}
				onNewIssue={onNewIssueForRepo}
			/>
		);
	}

	if (route.screen === "settings") {
		return <SettingsScreen onBack={onBack} />;
	}

	return <NewIssueScreen onBack={onBack} prefillOwner={route.owner} prefillRepo={route.repo} />;
}
