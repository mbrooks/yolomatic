import { describe, expect, it } from "vitest";
import {
	evaluateRefinementRequest,
	evaluateRefinementConflict,
	type RefinementConflictInput,
	type RefinementRequestInput,
} from "./admission.js";

describe("evaluateRefinementRequest", () => {
	const baseInput: RefinementRequestInput = {
		action: "created",
		commentBody: "/yolomatic issue-refinement",
		commentUserLogin: "admin",
		commentUserType: "User",
		issuePullRequest: undefined,
		issueState: "open",
		isRepoManaged: true,
		refinementEnabled: true,
		githubUsername: "yolomatic-bot",
		senderLogin: "admin",
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 1,
	};

	it("ignores non-created actions with a named reason and no command log", () => {
		const decision = evaluateRefinementRequest({ ...baseInput, action: "edited" });
		expect(decision.outcome).toBe("ignore");
		expect(decision.reason).toBe("ignored-action");
		expect(decision.stdout).toContain("ignored: action is edited");
		expect(decision.commandLog).toBeUndefined();
	});

	it("ignores comments that do not match the refinement command", () => {
		const decision = evaluateRefinementRequest({
			...baseInput,
			commentBody: "Please run /yolomatic issue-refinement",
		});
		expect(decision.outcome).toBe("ignore");
		expect(decision.reason).toBe("unmatched-command");
		expect(decision.stdout).toBeUndefined();
		expect(decision.commandLog).toBeUndefined();
	});

	it("admits a matched command and reports the command-received log", () => {
		const decision = evaluateRefinementRequest(baseInput);
		expect(decision.outcome).toBe("admit");
		expect(decision.commandLog).toEqual({
			level: "info",
			message: "Refinement command received from @admin",
		});
		expect(decision.commandStdout).toContain("command received for mbrooks/yolomatic#1");
		expect(decision.steeringPrompt).toBe("");
	});

	it("threads trailing command text as the steering prompt", () => {
		const decision = evaluateRefinementRequest({
			...baseInput,
			commentBody: "/yolomatic issue-refinement Focus on rollback",
		});
		expect(decision.outcome).toBe("admit");
		expect(decision.steeringPrompt).toBe("Focus on rollback");
		expect(decision.commandLog?.details).toEqual({ steeringPrompt: "Focus on rollback" });
	});

	it("ignores comments authored by the Yolomatic bot account", () => {
		const decision = evaluateRefinementRequest({
			...baseInput,
			commentUserLogin: "yolomatic-bot",
		});
		expect(decision.outcome).toBe("ignore");
		expect(decision.reason).toBe("self-comment");
		expect(decision.stdout).toContain("ignored: comment from yolomatic-bot");
		expect(decision.commandLog).toBeDefined();
	});

	it("ignores comments from bot-typed users", () => {
		const decision = evaluateRefinementRequest({
			...baseInput,
			commentUserType: "Bot",
		});
		expect(decision.outcome).toBe("ignore");
		expect(decision.reason).toBe("bot-comment");
	});

	it("ignores refinement commands on pull requests", () => {
		const decision = evaluateRefinementRequest({
			...baseInput,
			issuePullRequest: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/1" },
		});
		expect(decision.outcome).toBe("ignore");
		expect(decision.reason).toBe("pull-request-comment");
	});

	it("ignores refinement commands on closed issues", () => {
		const decision = evaluateRefinementRequest({ ...baseInput, issueState: "closed" });
		expect(decision.outcome).toBe("ignore");
		expect(decision.reason).toBe("closed-issue");
	});

	it("ignores commands for unmanaged repositories", () => {
		const decision = evaluateRefinementRequest({ ...baseInput, isRepoManaged: false });
		expect(decision.outcome).toBe("ignore");
		expect(decision.reason).toBe("unmanaged-repo");
	});

	it("ignores commands when refinement is disabled", () => {
		const decision = evaluateRefinementRequest({ ...baseInput, refinementEnabled: false });
		expect(decision.outcome).toBe("ignore");
		expect(decision.reason).toBe("refinement-disabled");
	});

	it("admits when refinementEnabled is undefined (default enabled)", () => {
		const decision = evaluateRefinementRequest({ ...baseInput, refinementEnabled: undefined });
		expect(decision.outcome).toBe("admit");
	});

	it("ignores closed issues before checking managed/disabled", () => {
		const decision = evaluateRefinementRequest({
			...baseInput,
			issueState: "closed",
			isRepoManaged: false,
			refinementEnabled: false,
		});
		expect(decision.reason).toBe("closed-issue");
	});
});

describe("evaluateRefinementConflict", () => {
	const baseInput: RefinementConflictInput = {
		authorized: true,
		alreadyInFlight: false,
		taskActive: false,
		activeSessionKind: undefined,
		taskRegistered: true,
		senderLogin: "admin",
		key: "github-mbrooks-yolomatic-issue-1",
	};

	it("proceeds when authorized, idle, and registered", () => {
		expect(evaluateRefinementConflict(baseInput).outcome).toBe("proceed");
	});

	it("rejects unauthorized senders with the collaborator comment and a warn log", () => {
		const decision = evaluateRefinementConflict({ ...baseInput, authorized: false, senderLogin: "user" });
		expect(decision.outcome).toBe("reject");
		expect(decision.reason).toBe("unauthorized");
		expect(decision.comment).toBe("Only repository collaborators can run issue refinement.");
		expect(decision.log).toEqual({
			level: "warn",
			message: "Refinement rejected: @user is not a repository collaborator",
		});
		expect(decision.stdout).toContain("user is not a repository collaborator");
	});

	it("rejects when a refinement is already in flight", () => {
		const decision = evaluateRefinementConflict({ ...baseInput, alreadyInFlight: true });
		expect(decision.outcome).toBe("reject");
		expect(decision.reason).toBe("already-in-flight");
		expect(decision.comment).toBe("Refinement is already running for this issue.");
		expect(decision.log).toBeUndefined();
	});

	it("rejects when an implementation task is active", () => {
		const decision = evaluateRefinementConflict({ ...baseInput, taskActive: true });
		expect(decision.outcome).toBe("reject");
		expect(decision.reason).toBe("active-task");
		expect(decision.comment).toBe("Yolomatic is currently working on this issue. Refinement cannot overlap with implementation.");
		expect(decision.log?.level).toBe("warn");
		expect(decision.log?.message).toBe("Refinement skipped: an implementation task is active");
	});

	it("rejects when a working session is active and names its kind in the log", () => {
		const decision = evaluateRefinementConflict({ ...baseInput, activeSessionKind: "refinement" });
		expect(decision.outcome).toBe("reject");
		expect(decision.reason).toBe("active-session");
		expect(decision.comment).toBe("Yolomatic is currently working on this issue. Refinement cannot overlap with implementation.");
		expect(decision.log?.message).toBe("Refinement skipped: an active refinement session exists");
		expect(decision.stdout).toContain("active refinement session");
	});

	it("treats a missing activeSessionKind as no active session", () => {
		const decision = evaluateRefinementConflict({ ...baseInput, activeSessionKind: undefined });
		expect(decision.outcome).toBe("proceed");
	});

	it("rejects when the task key cannot be registered", () => {
		const decision = evaluateRefinementConflict({ ...baseInput, taskRegistered: false });
		expect(decision.outcome).toBe("reject");
		expect(decision.reason).toBe("task-key-claimed");
		expect(decision.comment).toBe("Yolomatic is currently active on this issue. Refinement cannot overlap with implementation.");
		expect(decision.log?.message).toBe("Refinement skipped: task key is already claimed");
	});

	it("checks authorization before in-flight, task, and session conflicts", () => {
		const decision = evaluateRefinementConflict({
			...baseInput,
			authorized: false,
			alreadyInFlight: true,
			taskActive: true,
		});
		expect(decision.reason).toBe("unauthorized");
	});

	it("checks in-flight before task and session conflicts", () => {
		const decision = evaluateRefinementConflict({
			...baseInput,
			alreadyInFlight: true,
			taskActive: true,
		});
		expect(decision.reason).toBe("already-in-flight");
	});
});