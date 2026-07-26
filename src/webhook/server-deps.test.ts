import { describe, expect, it, vi } from "vitest";

import { createWebhookServerDeps } from "./server-deps.js";
import type { SessionState } from "../session/store.js";

function createSessionStore() {
	return {
		get: vi.fn(async () => null),
		getAll: vi.fn(async () => [] as SessionState[]),
		set: vi.fn(async (state: SessionState) => state),
		delete: vi.fn(async () => undefined),
		archive: vi.fn(async () => undefined),
		getSessionPath: vi.fn(() => "/tmp/session.jsonl"),
	} as never;
}

describe("createWebhookServerDeps", () => {
	it("provides working fallback services when optional deps are omitted", async () => {
		const deps = createWebhookServerDeps(createSessionStore(), "admin", "secret");
		const fallbackTaskController = deps.taskController;
		const fallbackWorkspaceService = (deps.cleanupCommand as any).workspaces;

		expect(fallbackTaskController.cancel("mbrooks/tars#1")).toBe(false);
		expect(fallbackTaskController.isActive("mbrooks/tars#1")).toBe(false);
		await expect(fallbackTaskController.steer("mbrooks/tars#1", "comment")).resolves.toBe(false);
		expect(fallbackTaskController.register("mbrooks/tars#1", vi.fn())).not.toBeNull();
		expect(fallbackTaskController.unregister("mbrooks/tars#1")).toBeUndefined();
		expect(fallbackTaskController.isDraining()).toBe(false);
		expect(fallbackTaskController.setDraining(true)).toBeUndefined();

		await expect(fallbackWorkspaceService.createOrGetWorktree("mbrooks", "tars", 1)).resolves.toEqual({
			path: "",
			branch: "",
		});
		await expect(fallbackWorkspaceService.removeWorktree("mbrooks", "tars", 1)).resolves.toBeUndefined();
		await expect(fallbackWorkspaceService.commitAndPush("mbrooks", "tars", 1, "msg")).resolves.toBe(false);
		await expect(fallbackWorkspaceService.commitAndPushPath("/tmp/ws", "branch", "msg", "main")).resolves.toBe(false);
		await expect(fallbackWorkspaceService.hasChanges("/tmp/ws", true)).resolves.toBe(false);
		expect(fallbackWorkspaceService.getWorktreePath("mbrooks", "tars", 1)).toBe("");
		await expect(fallbackWorkspaceService.getGitStatus("mbrooks", "tars", 1)).resolves.toBe("");
		await expect(fallbackWorkspaceService.getGitDiff("mbrooks", "tars", 1)).resolves.toBe("");

		const status = await deps.getAdminStatus.execute();
		expect(status.success).toBe(true);
		if (status.success) {
			expect(status.data.draining).toBe(false);
		}
	});

	it("wraps provided services with the appropriate adapters", async () => {
		const sessionStore = createSessionStore();
		const taskController = {
			cancel: vi.fn(() => true),
			isActive: vi.fn(() => true),
			steer: vi.fn(async () => true),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => true),
			setDraining: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "tars/issue-1" })),
			removeWorktree: vi.fn(async () => undefined),
			commitAndPush: vi.fn(async () => true),
			commitAndPushPath: vi.fn(async () => true),
			hasChanges: vi.fn(async () => true),
			getWorktreePath: vi.fn(() => "/tmp/ws"),
			getGitStatus: vi.fn(async () => "status"),
			getGitDiff: vi.fn(async () => "diff"),
		};
		const staleDetector = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const githubService = { postComment: vi.fn() };
		const settingsStore = {
			get: vi.fn((key: string) => {
				if (key === "github_username") return "tars-bot";
				if (key === "default_branch") return "main";
				if (key === "self_report_enabled") return "true";
				return undefined;
			}),
			getString: vi.fn((key: string, defaultValue?: string) => {
				if (key === "github_username") return "tars-bot";
				if (key === "default_branch") return "main";
				return defaultValue ?? "";
			}),
			getBoolean: vi.fn((key: string, defaultValue?: boolean) => {
				if (key === "self_report_enabled") return true;
				return defaultValue ?? false;
			}),
			getAll: vi.fn(async () => []),
		};
		const executor = { execute: vi.fn() };
		const prebuiltStartIssueSession = { execute: vi.fn() } as never;

		const deps = createWebhookServerDeps(
			sessionStore,
			"admin",
			"secret",
			taskController as never,
			workspaceManager as never,
			staleDetector as never,
			"/tmp/archive",
			"/tmp/admin-assets",
			githubService as never,
			settingsStore as never,
			executor as never,
			prebuiltStartIssueSession,
		);

		const wrappedWorkspaceService = (deps.cleanupCommand as any).workspaces;
		await expect(wrappedWorkspaceService.commitAndPushPath("/tmp/ws", "branch", "msg", "main")).resolves.toBe(true);
		expect(workspaceManager.commitAndPushPath).toHaveBeenCalledWith("/tmp/ws", "branch", "msg", "main");

		expect(deps.taskController.cancel("mbrooks/tars#1")).toBe(true);
		expect(deps.taskController.isActive("mbrooks/tars#1")).toBe(true);
		await expect(deps.taskController.steer("mbrooks/tars#1", "comment")).resolves.toBe(true);
		deps.taskController.register("mbrooks/tars#1", vi.fn());
		deps.taskController.unregister("mbrooks/tars#1");
		expect(deps.taskController.isDraining()).toBe(true);
		deps.taskController.setDraining(false);

		expect(taskController.cancel).toHaveBeenCalledWith("mbrooks/tars#1");
		expect(taskController.isActive).toHaveBeenCalledWith("mbrooks/tars#1");
		expect(taskController.steer).toHaveBeenCalledWith("mbrooks/tars#1", "comment");
		expect(taskController.register).toHaveBeenCalledWith("mbrooks/tars#1", expect.any(Function));
		expect(taskController.unregister).toHaveBeenCalledWith("mbrooks/tars#1");
		expect(taskController.isDraining).toHaveBeenCalled();
		expect(taskController.setDraining).toHaveBeenCalledWith(false);

		const status = await deps.getAdminStatus.execute();
		expect(status.success).toBe(true);
		expect(staleDetector.detectStaleSessions).toHaveBeenCalled();
		expect(deps.githubService).toBe(githubService);
		expect(deps.adminUsername).toBe("admin");
		expect(deps.adminPassword).toBe("secret");
		expect(deps.adminAssetsDir).toBe("/tmp/admin-assets");
		expect(deps.settingsStore).toBe(settingsStore);
		expect(deps.startIssueSession).toBe(prebuiltStartIssueSession);
	});

	it("exposes repositoryStore on the admin router deps when provided", () => {
		const repositoryStore = { listSync: vi.fn(() => []) } as never;
		const deps = createWebhookServerDeps(
			createSessionStore(),
			"admin",
			"secret",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			repositoryStore,
		);

		expect(deps.repositoryStore).toBe(repositoryStore);
	});

	it("reuses a prebuilt StartIssueSession command when provided", () => {
		const prebuiltStartIssueSession = {
			execute: vi.fn(),
		} as never;

		const deps = createWebhookServerDeps(
			createSessionStore(),
			"admin",
			"secret",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			prebuiltStartIssueSession,
		);

		expect(deps.startIssueSession).toBe(prebuiltStartIssueSession);
	});
});
