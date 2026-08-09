import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useServerState } from "../hooks/useServerState.js";
import { useRoute, navigate, DEFAULT_SETTINGS_TAB, type Route } from "./routes.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { RestartBanner } from "../components/RestartBanner.js";
import { RepoInventoryScreen } from "../features/repos/RepoInventoryScreen.js";
import { SessionScreen } from "../features/sessions/SessionScreen.js";
import { DashboardScreen } from "../features/dashboard/DashboardScreen.js";
import { SettingsScreen } from "../features/settings/SettingsScreen.js";
import { RepoSkillsScreen } from "../features/skills/RepoSkillsScreen.js";
import { IssuesScreen } from "../features/issues/IssuesScreen.js";
import { RepoSettingsScreen } from "../features/repos/RepoSettingsScreen.js";
import { LoginScreen } from "../features/auth/LoginScreen.js";
import { fetchMe, logout, type AuthUser } from "../api/auth.js";
import { isInProgressStatus } from "../lib/status-helpers.js";
import type { AgentStatus, RepoSummary, Session } from "./types.js";

export function App({ onRerunOnboarding }: { onRerunOnboarding?: () => void } = {}): React.ReactElement {
	const [tick, setTick] = useState(0);
	const serverState = useServerState(tick);
	const route = useRoute();
	const [authUser, setAuthUser] = useState<AuthUser | null | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		fetchMe()
			.then((result) => {
				if (!cancelled) setAuthUser(result.user);
			})
			.catch(() => {
				if (!cancelled) setAuthUser(null);
			});
		return () => {
				cancelled = true;
			};
	}, [tick]);

	const handleLogout = useCallback(async () => {
		try {
			await logout();
		} catch {
			// ignore
		}
		setAuthUser(null);
	}, []);

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
					s.owner === route.owner &&
					s.repo === route.repo &&
					s.issueNumber === route.issueNumber &&
					(s.kind ?? "implementation") === (route.kind ?? "implementation"),
			) ?? null
		);
	}, [sessions, route]);

	const handleSelectRepo = useCallback((owner: string, repo: string) => {
		navigate({ screen: "repo", owner, repo, tab: "sessions" });
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
					? { screen: "repo", owner: route.owner, repo: route.repo, issueNumber: session.issueNumber, kind: session.kind, tab: route.tab }
					: route.screen === "working"
						? {
							screen: "working",
							owner: session.owner,
							repo: session.repo,
							issueNumber: session.issueNumber,
							kind: session.kind,
						}
							: {
								screen: "repo",
								owner: session.owner,
								repo: session.repo,
								issueNumber: session.issueNumber,
								kind: session.kind,
								tab: "sessions",
							};
			navigate(next);
		},
		[route],
	);

	const handleSelectTab = useCallback(
		(tab: "sessions" | "skills" | "issues" | "settings") => {
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

	const lastUpdated = useMemo(() => {
		if (serverState.status === "loading") return "Loading...";
		if (serverState.status === "error") return `Error: ${serverState.error}`;
		return `Last updated: ${serverState.updatedAt.toLocaleTimeString()}`;
	}, [serverState]);

	const repoSessions = useMemo(() => {
		if (route.screen !== "repo") return [];
		return sessions.filter((s) => s.owner === route.owner && s.repo === route.repo);
	}, [sessions, route]);

	if (authUser === null) {
		return <LoginScreen onLoggedIn={() => setTick((t) => t + 1)} />;
	}
	if (authUser === undefined) {
		return <div className="empty">Loading...</div>;
	}

	return (
		<div className="app">
			{serverState.status === "ready" && serverState.data.draining && <RestartBanner />}
			<AppHeader
				agentStatus={agentStatus}
				isSettingsActive={isSettingsActive}
				onSettings={handleSelectSettings}
				onLogout={handleLogout}
				authUser={authUser ?? undefined}
			/>

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
						onRerunOnboarding={onRerunOnboarding}
					/>
			)}

			<div className="last-updated">{lastUpdated}</div>
		</div>
	);
}

function AppHeader({
	agentStatus,
	isSettingsActive,
	onSettings,
	onLogout,
	authUser,
}: {
	agentStatus: AgentStatus;
	isSettingsActive: boolean;
	onSettings: () => void;
	onLogout: () => void;
	authUser?: AuthUser;
}): React.ReactElement {
	return (
		<header>
			<h1>Yolomatic Admin</h1>
			<div className="header-actions">
				{authUser ? (
					<span style={{ color: "var(--muted)", fontSize: "0.875rem", marginRight: "0.5rem" }}>
						Signed in as {authUser.username}
					</span>
				) : null}
				<button
					className={`global-tab${isSettingsActive ? " active" : ""}`}
					onClick={onSettings}
					type="button"
				>
					Settings
				</button>
				<button
					className="global-tab"
					onClick={onLogout}
					type="button"
				>
					Sign out
				</button>
			</div>
		</header>
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
	onRerunOnboarding,
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
	onSelectTab: (tab: "sessions" | "skills" | "issues" | "settings") => void;
	onSelectSettings: () => void;
	onRerunOnboarding?: () => void;
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
				onMutate={onMutate}
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
		if (route.tab === "settings") {
			return (
				<RepoSettingsScreen
					owner={route.owner}
					repo={route.repo}
					onSelectTab={onSelectTab}
					onBack={onBack}
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
		return (
			<SettingsScreen
				onBack={onBack}
				onRerunOnboarding={onRerunOnboarding}
				tab={route.tab ?? DEFAULT_SETTINGS_TAB}
			/>
		);
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
