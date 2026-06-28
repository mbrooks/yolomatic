import React, { useCallback, useMemo, useState } from "react";
import { useServerState } from "../hooks/useServerState.js";
import { useRoute, navigate, DEFAULT_SETTINGS_TAB, type Route } from "./routes.js";
import { RestartBanner } from "../components/RestartBanner.js";
import { RepoInventoryScreen } from "../features/repos/RepoInventoryScreen.js";
import { SessionScreen } from "../features/sessions/SessionScreen.js";
import { DashboardScreen } from "../features/dashboard/DashboardScreen.js";
import { SettingsScreen } from "../features/settings/SettingsScreen.js";
import { RepoSkillsScreen } from "../features/skills/RepoSkillsScreen.js";
import { IssuesScreen } from "../features/issues/IssuesScreen.js";
import { isInProgressStatus } from "../lib/status-helpers.js";
import type { AgentStatus, RepoSummary, Session } from "./types.js";

const SIDEBAR_PREVIEW_LIMIT = 10;

export function App(): React.ReactElement {
	const [tick, setTick] = useState(0);
	const [showAllRepos, setShowAllRepos] = useState(false);
	const serverState = useServerState(tick);
	const route = useRoute();

	const agentStatus: AgentStatus = serverState.status === "ready" ? serverState.data.agent : "offline";
	const sessions = serverState.status === "ready" ? serverState.data.sessions : [];
	const repos = serverState.status === "ready" ? serverState.data.repos : [];

	const workingSessions = useMemo(() => sessions.filter((s) => isInProgressStatus(s.status)), [sessions]);

	const handleMutate = useCallback(() => {
		setTick((t) => t + 1);
	}, []);

	const selectedSession = useMemo(() => {
		if (route.screen === "dashboard" || route.screen === "repos" || route.screen === "settings" || route.screen === "new-issue") return null;
		if (route.issueNumber === undefined) return null;
		return (
			sessions.find(
				(s) =>
					s.owner === route.owner && s.repo === route.repo && s.issueNumber === route.issueNumber,
			) ?? null
		);
	}, [sessions, route]);

	const handleSelectRepo = useCallback((owner: string, repo: string) => {
		navigate({ screen: "repo", owner, repo, tab: "sessions" });
	}, []);

	const handleSelectWorking = useCallback(() => {
		navigate({ screen: "working" });
	}, []);

	const handleSelectSessionPage = useCallback((session: Session) => {
		navigate({
			screen: "working",
			owner: session.owner,
			repo: session.repo,
			issueNumber: session.issueNumber,
		});
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
		(tab: "sessions" | "skills" | "issues") => {
			if (route.screen === "repo") {
				navigate({ screen: "repo", owner: route.owner, repo: route.repo, tab });
			}
		},
		[route],
	);

	const isSettingsActive = route.screen === "settings";

	const handleSelectSettings = useCallback(() => {
		navigate({ screen: "settings" });
	}, []);

	const recentSessions = useMemo(
		() =>
			[...sessions]
				.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime())
				.slice(0, SIDEBAR_PREVIEW_LIMIT),
		[sessions],
	);

	const sortedRepos = useMemo(() => [...repos].sort(compareRepoActivity), [repos]);
	const repoPreview = useMemo(
		() => (showAllRepos ? sortedRepos : sortedRepos.slice(0, SIDEBAR_PREVIEW_LIMIT)),
		[showAllRepos, sortedRepos],
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

	const pageTitle = useMemo(() => {
		if (route.screen === "working") return "Active Sessions";
		if (route.screen === "repos") return "Repositories";
		if (route.screen === "repo") return `${route.owner}/${route.repo}`;
		if (route.screen === "settings") return "Settings";
		return "Dashboard";
	}, [route]);

	return (
		<div className="app-shell">
			{serverState.status === "ready" && serverState.data.draining && <RestartBanner />}
			<AppSidebar
				route={route}
				recentSessions={recentSessions}
				repos={repoPreview}
				hasMoreRepos={sortedRepos.length > SIDEBAR_PREVIEW_LIMIT}
				showAllRepos={showAllRepos}
				onToggleRepos={() => setShowAllRepos((current) => !current)}
				onSelectWorking={handleSelectWorking}
				onSelectSession={handleSelectSessionPage}
				onSelectRepo={handleSelectRepo}
				onSelectRepos={handleSelectReposList}
				onSelectSettings={handleSelectSettings}
				onSelectDashboard={handleBackToDashboard}
			/>

			<div className="app-frame">
				<AppHeader pageTitle={pageTitle} agentStatus={agentStatus} lastUpdated={lastUpdated} />

				<div className="app-content">
					{serverState.status === "error" ? (
						<div className="empty">Unable to reach API</div>
					) : (
						<AppContent
							route={route}
							repos={repos}
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
							onSelectSettings={handleSelectSettings}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

function AppHeader({
	pageTitle,
	agentStatus,
	lastUpdated,
}: {
	pageTitle: string;
	agentStatus: AgentStatus;
	lastUpdated: string;
}): React.ReactElement {
	return (
		<header className="app-header">
			<div>
				<p className="eyebrow">Windmill Admin</p>
				<h1>{pageTitle}</h1>
			</div>
			<div className="header-meta">
				<div className="header-status">
					<span className="header-status-dot" data-status={agentStatus} />
					<span>{agentStatus === "offline" ? "Offline" : `Agent ${agentStatus}`}</span>
				</div>
				<div className="last-updated">{lastUpdated}</div>
			</div>
		</header>
	);
}

function AppSidebar({
	route,
	recentSessions,
	repos,
	hasMoreRepos,
	showAllRepos,
	onToggleRepos,
	onSelectWorking,
	onSelectSession,
	onSelectRepo,
	onSelectRepos,
	onSelectSettings,
	onSelectDashboard,
}: {
	route: Route;
	recentSessions: Session[];
	repos: RepoSummary[];
	hasMoreRepos: boolean;
	showAllRepos: boolean;
	onToggleRepos: () => void;
	onSelectWorking: () => void;
	onSelectSession: (session: Session) => void;
	onSelectRepo: (owner: string, repo: string) => void;
	onSelectRepos: () => void;
	onSelectSettings: () => void;
	onSelectDashboard: () => void;
}): React.ReactElement {
	return (
		<aside className="sidebar">
			<button className="sidebar-brand" onClick={onSelectDashboard} type="button">
				<span className="sidebar-brand-mark">T</span>
				<span>
					<strong>TARS</strong>
					<small>Windmill Admin</small>
				</span>
			</button>

			<nav className="sidebar-nav" aria-label="Primary">
				<SidebarNavButton
					active={route.screen === "working"}
					label="Active Sessions"
					onClick={onSelectWorking}
				/>
				<SidebarNavButton
					active={route.screen === "repos" || route.screen === "repo"}
					label="Repos"
					onClick={onSelectRepos}
				/>
				<SidebarNavButton
					active={route.screen === "settings"}
					label="Settings"
					onClick={onSelectSettings}
				/>
			</nav>

			<section className="sidebar-section">
				<div className="sidebar-section-header">
					<h2>Active Sessions</h2>
				</div>
				<div className="sidebar-list">
					{recentSessions.length === 0 ? (
						<p className="sidebar-empty">No recent sessions.</p>
					) : (
						recentSessions.map((session) => (
							<button
								key={`${session.owner}/${session.repo}#${session.issueNumber}`}
								className="sidebar-list-item"
								onClick={() => onSelectSession(session)}
								type="button"
							>
								<span className="sidebar-item-title">{session.owner}/{session.repo}</span>
								<span className="sidebar-item-meta">Issue #{session.issueNumber}</span>
							</button>
						))
					)}
				</div>
				<button className="sidebar-link" onClick={onSelectWorking} type="button">
					View all sessions
				</button>
			</section>

			<section className="sidebar-section">
				<div className="sidebar-section-header">
					<h2>Repos</h2>
				</div>
				<div className="sidebar-list">
					{repos.length === 0 ? (
						<p className="sidebar-empty">No repositories yet.</p>
					) : (
						repos.map((repo) => (
							<button
								key={`${repo.owner}/${repo.repo}`}
								className="sidebar-list-item"
								onClick={() => onSelectRepo(repo.owner, repo.repo)}
								type="button"
							>
								<span className="sidebar-item-title">{repo.owner}/{repo.repo}</span>
								<span className="sidebar-item-meta">
									{repo.activeCount} active · {repo.sessionCount} sessions
								</span>
							</button>
						))
					)}
				</div>
				{hasMoreRepos ? (
					<button className="sidebar-link" onClick={onToggleRepos} type="button">
						{showAllRepos ? "Show top 10" : "Show all repos"}
					</button>
				) : null}
			</section>
		</aside>
	);
}

function SidebarNavButton({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}): React.ReactElement {
	return (
		<button
			className={`sidebar-nav-button${active ? " active" : ""}`}
			onClick={onClick}
			type="button"
		>
			{label}
		</button>
	);
}

function AppContent({
	route,
	repos,
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
	onSelectSettings,
}: {
	route: Route;
	repos: RepoSummary[];
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
	onSelectTab: (tab: "sessions" | "skills" | "issues") => void;
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
				onSelectSession={onSelectSession}
			/>
		);
	}

	if (route.screen === "repos") {
		return (
			<RepoInventoryScreen
				repos={repos}
				onSelectRepo={onSelectRepo}
				onBack={onBack}
				onRescanComplete={onMutate}
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
		if (route.tab === "skills") {
			return (
				<RepoSkillsScreen
					owner={route.owner}
					repo={route.repo}
					activeTab={route.tab ?? "sessions"}
					onSelectTab={onSelectTab}
					onBack={onBack}
				/>
			);
		}
		if (route.tab === "sessions") {
			return (
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
				/>
			);
		}
		return (
			<IssuesScreen
				owner={route.owner}
				repo={route.repo}
				onSelectTab={onSelectTab}
				onBack={onBack}
			/>
		);
	}

	if (route.screen === "settings") {
		return <SettingsScreen onBack={onBack} tab={route.tab ?? DEFAULT_SETTINGS_TAB} />;
	}

	navigate({ screen: "dashboard" });
	return (
		<DashboardScreen
			agentStatus={agentStatus}
			uptime={uptime}
			draining={draining}
			repos={repos}
			sessions={sessions}
			onSelectWorking={onSelectWorking}
			onSelectRepos={onSelectRepos}
			onSelectSession={onSelectSession}
		/>
	);
}

function compareRepoActivity(a: RepoSummary, b: RepoSummary): number {
	const activeCount = b.activeCount - a.activeCount;
	if (activeCount !== 0) return activeCount;

	const sessionCount = b.sessionCount - a.sessionCount;
	if (sessionCount !== 0) return sessionCount;

	const lastActivity = (b.lastActivity ? new Date(b.lastActivity).getTime() : 0)
		- (a.lastActivity ? new Date(a.lastActivity).getTime() : 0);
	if (lastActivity !== 0) return lastActivity;

	return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
}
