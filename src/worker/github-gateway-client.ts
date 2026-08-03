/**
 * Worker-side client for the control-plane GitHub gateway.
 *
 * The disposable worker never holds the GitHub token. Tools registered by the
 * `github-issues` pi extension call {@link callGitHubGateway}, which routes the
 * request over the worker session WebSocket to the control-plane
 * {@link WorkerGitHubGateway} and awaits the matching `tool_response`.
 *
 * The worker runtime ({@link ../worker/runtime.js}) installs a transport before
 * the agent session starts; the extension calls through the same process-wide
 * registry even when its TypeScript source and the compiled worker load separate
 * instances of this module.
 */

export interface GatewayCallResult {
	ok: boolean;
	data?: unknown;
	error?: string;
	scopeError?: boolean;
}

export interface GatewayTransport {
	call(request: { tool: string; params: Record<string, unknown> }): Promise<GatewayCallResult>;
}

const GATEWAY_TRANSPORT_KEY = Symbol.for("yeetomatic.worker.github-gateway-transport");

type GatewayTransportRegistry = typeof globalThis & {
	[key: symbol]: GatewayTransport | undefined;
};

function getTransportRegistry(): GatewayTransportRegistry {
	return globalThis as GatewayTransportRegistry;
}

/**
 * Install the transport used to reach the control-plane gateway. Called once
 * by the worker runtime after the session WebSocket is established.
 */
export function setGitHubGatewayTransport(next: GatewayTransport | undefined): void {
	const registry = getTransportRegistry();
	if (next) {
		registry[GATEWAY_TRANSPORT_KEY] = next;
		return;
	}
	delete registry[GATEWAY_TRANSPORT_KEY];
}

/**
 * Invoke a scoped GitHub gateway tool on the control plane. Throws if no
 * transport has been installed (e.g. when the extension is loaded outside a
 * worker session), or when the gateway reports a failure.
 */
export async function callGitHubGateway(
	tool: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	const transport = getTransportRegistry()[GATEWAY_TRANSPORT_KEY];
	if (!transport) {
		throw new Error(
			`GitHub gateway transport is not available; cannot call ${tool} outside a worker session`,
		);
	}
	const result = await transport.call({ tool, params });
	if (!result.ok) {
		const prefix = result.scopeError ? "GitHub scope error" : "GitHub gateway error";
		throw new Error(result.error ? `${prefix}: ${result.error}` : prefix);
	}
	return result.data;
}
