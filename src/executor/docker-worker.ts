import type { ExecutionResult, RefinementResult } from "./results.js";
import {
	buildFeedbackPrompt,
	buildIssuePrompt,
	buildIssueRefinementPrompt,
	buildPRReviewPrompt,
	type PRReviewComment,
	type PriorDiscussionComment,
} from "./prompts.js";
import type { ExecutionService, LiveExecutionSession } from "../ports/execution-service.js";
import { sessionStorageKey, type SessionState } from "../session/store.js";
import type { WorkerRpcServer } from "../worker/rpc-server.js";
import type { WorkerGitHubGateway } from "../worker/github-gateway.js";
import type { RuntimeSettings, RuntimeSettingsProvider } from "../runtime-settings.js";

import { DockerWorkerLauncher } from "./docker-worker/docker-worker-launcher.js";
import { WorkerSessionSupervisor } from "./docker-worker/worker-session-supervisor.js";

export interface DockerWorkerExecutorOptions {
	projectRoot: string;
	workspacesDir: string;
	/** @deprecated Legacy image override retained for a rolling upgrade only. */
	workerImage?: string;
	defaultWorkerTemplate?: string;
	resolveWorkerTemplate?: (owner: string, repo: string) => string;
	workerWorkspaceMountSource: string;
	workerControlBaseUrl: string;
	workerDockerNetworkMode?: string;
	workerRpcServer: WorkerRpcServer;
	workerOllamaHost?: string;
	/** Optional OpenAI platform API key forwarded to workers as OPENAI_API_KEY. */
	workerOpenAiApiKey?: string;
	soulPath: string;
	/** Scoped GitHub gateway used to serve worker tool_request calls. */
	githubGateway?: WorkerGitHubGateway;
	/**
	 * Runtime settings provider (or static snapshot) supplying the model
	 * provider/model and OpenAI API key forwarded into worker containers.
	 */
	runtimeSettings?: RuntimeSettingsProvider | (() => RuntimeSettings);
}

export class DockerWorkerExecutor implements ExecutionService {
	private readonly launcher: DockerWorkerLauncher;
	private readonly supervisor: WorkerSessionSupervisor;

	constructor(private readonly options: DockerWorkerExecutorOptions) {
		this.launcher = new DockerWorkerLauncher({
			projectRoot: options.projectRoot,
			workspacesDir: options.workspacesDir,
			workerImage: options.workerImage,
			defaultWorkerTemplate: options.defaultWorkerTemplate,
			resolveWorkerTemplate: options.resolveWorkerTemplate,
			workerWorkspaceMountSource: options.workerWorkspaceMountSource,
			workerDockerNetworkMode: options.workerDockerNetworkMode,
			workerOllamaHost: options.workerOllamaHost,
			workerOpenAiApiKey: options.workerOpenAiApiKey,
			soulPath: options.soulPath,
			runtimeSettings: options.runtimeSettings,
		});

		this.supervisor = new WorkerSessionSupervisor({
			workerRpcServer: options.workerRpcServer,
			workerControlBaseUrl: options.workerControlBaseUrl,
			githubGateway: () => this.options.githubGateway,
			launcher: this.launcher,
		});
	}

	execute(
		state: SessionState,
		comment?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
		priorComments?: PriorDiscussionComment[],
	): Promise<ExecutionResult> {
		const prompt = comment ? buildFeedbackPrompt(comment, priorComments ?? []) : buildIssuePrompt(state);
		return this.runWorker(state, { kind: comment ? "comment" : "issue", text: prompt }, abortSignal, onSessionCreated, onActivity) as Promise<ExecutionResult>;
	}

	executePRReview(
		state: SessionState,
		prReview: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		const prompt = buildPRReviewPrompt(state, prReview.comments, prReview.reviewBody);
		return this.runWorker(state, { kind: "pr-review", text: prompt }, abortSignal, onSessionCreated, onActivity) as Promise<ExecutionResult>;
	}

	executeRefinement(
		state: SessionState,
		repoSkillContent: string | undefined,
		steeringPrompt?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<RefinementResult> {
		const prompt = buildIssueRefinementPrompt(state, repoSkillContent, steeringPrompt);
		return this.runWorker(
			{ ...state, kind: "refinement" },
			{ kind: "issue-refinement", text: prompt },
			abortSignal,
			onSessionCreated,
			onActivity,
		) as Promise<RefinementResult>;
	}

	/**
	 * Public startup hook that begins building the worker image eagerly.
	 * The returned promise resolves when the build finishes, but callers should
	 * generally fire it and forget it so startup is not blocked.
	 */
	async prebuildWorkerImage(): Promise<void> {
		await this.launcher.prebuildWorkerImage();
	}

	private async runWorker(
		state: SessionState,
		prompt: { kind: "issue" | "comment" | "pr-review" | "issue-refinement"; text: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult | RefinementResult> {
		const sessionKey = sessionStorageKey(state.owner, state.repo, state.issueNumber, state.kind ?? "implementation");
		const workerTemplate = this.launcher.resolveTemplate(state.owner, state.repo);
		await this.launcher.ensureWorkerImage(workerTemplate, sessionKey);

		const containerName = this.launcher.buildContainerName(state, prompt.kind);
		const workspacePathInWorker = this.launcher.resolveWorkerWorkspacePath(state.workspacePath);
		await this.launcher.validateLaunch(state.workspacePath);

		return this.launcher.runWithNameConflictRetry(containerName, sessionKey, () =>
			this.supervisor.runSession({
				state,
				prompt,
				sessionKey,
				containerName,
				workspacePathInWorker,
				workerTemplate,
				abortSignal,
				onSessionCreated,
				onActivity,
			}),
		);
	}
}
