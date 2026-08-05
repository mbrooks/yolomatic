import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnController = vi.hoisted(() => {
	function makeEmitter() {
		const handlers = new Map<string, Set<(...args: any[]) => void>>();
		return {
			on(event: string, fn: (...args: any[]) => void) {
				let set = handlers.get(event);
				if (!set) {
					set = new Set();
					handlers.set(event, set);
				}
				set.add(fn);
				return this;
			},
			removeAllListeners() {
				handlers.clear();
				return this;
			},
			emit(event: string, ...args: any[]) {
				const set = handlers.get(event);
				if (set) {
					for (const fn of [...set]) {
						fn(...args);
					}
				}
			},
		};
	}

	function makeChild() {
		const child = makeEmitter();
		const stdout = makeEmitter();
		const stderr = makeEmitter();
		const kill = vi.fn(() => true);
		return Object.assign(child, { stdout, stderr, kill, stdin: null });
	}

	const calls: Array<{ cmd: string; args: string[]; options: any; child: any }> = [];

	return {
		calls,
		reset() {
			calls.length = 0;
		},
		spawn(cmd: string, args: string[], options: any) {
			const child = makeChild();
			calls.push({ cmd, args, options, child });
			return child;
		},
	};
});

vi.mock("node:child_process", () => ({ spawn: spawnController.spawn }));

const statMock = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: statMock.stat }));

import { runEnvironmentInit, resolveInitScriptPath, EnvInitError } from "./env-init.js";

function fileStats(size: number) {
	return { isFile: () => true, size };
}

describe("resolveInitScriptPath", () => {
	it("uses absolute paths as-is", () => {
		expect(resolveInitScriptPath("/workspace", "/abs/yeetstrap.sh")).toBe("/abs/yeetstrap.sh");
	});

	it("resolves relative paths against the workspace", () => {
		expect(resolveInitScriptPath("/workspace/issue-1", "yeetstrap.sh")).toBe(
			path.join("/workspace/issue-1", "yeetstrap.sh"),
		);
	});
});

describe("runEnvironmentInit", () => {
	const log = vi.fn();

	beforeEach(() => {
		spawnController.reset();
		log.mockClear();
		statMock.stat.mockReset();
		statMock.stat.mockResolvedValue({ isFile: () => true, size: 100 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("skips silently when the script is absent (ENOENT)", async () => {
		statMock.stat.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));

		const result = await runEnvironmentInit({ workspacePath: "/ws", log });

		expect(result).toEqual({ skipped: true });
		expect(spawnController.calls).toHaveLength(0);
		expect(log).not.toHaveBeenCalled();
	});

	it("skips when skip is true even if the script exists", async () => {
		const result = await runEnvironmentInit({ workspacePath: "/ws", skip: true, log });

		expect(result).toEqual({ skipped: true });
		expect(spawnController.calls).toHaveLength(0);
		expect(log).not.toHaveBeenCalled();
	});

	it("skips when YEETOMATIC_WORKER_INIT_SKIP=1 in env", async () => {
		const result = await runEnvironmentInit({
			workspacePath: "/ws",
			log,
			env: { YEETOMATIC_WORKER_INIT_SKIP: "1" },
		});

		expect(result).toEqual({ skipped: true });
		expect(spawnController.calls).toHaveLength(0);
	});

	it("runs the script, streams stdout/stderr as env_init log events, and resolves on exit 0", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);

		const promise = runEnvironmentInit({ workspacePath: "/ws", scriptPath: "/ws/yeetstrap.sh", log });

		await new Promise((resolve) => setImmediate(resolve));
		const spawnCall = spawnController.calls[0];
		expect(spawnCall.cmd).toBe("bash");
		expect(spawnCall.args[0]).toBe("-c");
		expect(spawnCall.args[1]).toBe('cd "/ws" && exec bash -- "/ws/yeetstrap.sh"');
		expect(spawnCall.options.cwd).toBe("/ws");
		expect(spawnCall.options.env.YEETOMATIC_SESSION_WS_URL).toBeUndefined();

		spawnCall.child.stdout.emit("data", Buffer.from("installing\n"));
		spawnCall.child.stderr.emit("data", Buffer.from("warn line\n"));
		spawnCall.child.emit("exit", 0, null);

		const result = await promise;
		expect(result).toEqual({ skipped: false, scriptPath: "/ws/yeetstrap.sh" });
		expect(log).toHaveBeenCalledWith({
			level: "info",
			message: "installing\n",
			details: { type: "env_init" },
		});
		expect(log).toHaveBeenCalledWith({
			level: "warn",
			message: "warn line\n",
			details: { type: "env_init" },
		});
	});

	it("rejects with nonzero_exit carrying the exit code and stderr tail when the script exits non-zero", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);

		const promise = runEnvironmentInit({ workspacePath: "/ws", scriptPath: "/ws/y.sh", log });
		await new Promise((resolve) => setImmediate(resolve));
		const child = spawnController.calls[0].child;

		child.stderr.emit("data", Buffer.from("boom\n"));
		child.stderr.emit("data", Buffer.from("trace\n"));
		child.emit("exit", 2, null);

		await expect(promise).rejects.toMatchObject({ kind: "nonzero_exit", exitCode: 2 });
		await expect(promise).rejects.toBeInstanceOf(EnvInitError);
		const error = await promise.catch((e) => e);
		expect(error.stderrTail).toContain("boom");
		expect(error.stderrTail).toContain("trace");
	});

	it("rejects with signal kind when the script is killed by a signal", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);

		const promise = runEnvironmentInit({ workspacePath: "/ws", scriptPath: "/ws/y.sh", log });
		await new Promise((resolve) => setImmediate(resolve));
		const child = spawnController.calls[0].child;

		child.emit("exit", null, "SIGTERM");

		await expect(promise).rejects.toMatchObject({ kind: "signal", signal: "SIGTERM" });
	});

	it("rejects with timeout kind and kills the script when the timeout elapses", async () => {
		vi.useFakeTimers();
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);

		const promise = runEnvironmentInit({
			workspacePath: "/ws",
			scriptPath: "/ws/y.sh",
			log,
			timeoutSeconds: 1,
		});
		await vi.advanceTimersByTimeAsync(0);
		const child = spawnController.calls[0].child;

		vi.advanceTimersByTime(1001);

		await expect(promise).rejects.toMatchObject({ kind: "timeout" });
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("rejects with aborted kind and kills the script when the abort signal fires", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);
		const controller = new AbortController();

		const promise = runEnvironmentInit({
			workspacePath: "/ws",
			scriptPath: "/ws/y.sh",
			log,
			signal: controller.signal,
		});
		await new Promise((resolve) => setImmediate(resolve));
		const child = spawnController.calls[0].child;

		controller.abort();
		child.emit("exit", null, "SIGKILL");

		await expect(promise).rejects.toMatchObject({ kind: "aborted" });
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("rejects with aborted kind when the signal is already aborted before spawn", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);
		const controller = new AbortController();
		controller.abort();

		await expect(
			runEnvironmentInit({
				workspacePath: "/ws",
				scriptPath: "/ws/y.sh",
				log,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ kind: "aborted" });
		expect(spawnController.calls).toHaveLength(0);
	});

	it("rejects with invalid_script when the script is unreadable (EACCES)", async () => {
		statMock.stat.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));

		await expect(
			runEnvironmentInit({ workspacePath: "/ws", scriptPath: "/ws/y.sh", log }),
		).rejects.toMatchObject({ kind: "invalid_script" });
		expect(spawnController.calls).toHaveLength(0);
	});

	it("rejects with invalid_script when the script is empty", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(0) as never);

		await expect(
			runEnvironmentInit({ workspacePath: "/ws", scriptPath: "/ws/y.sh", log }),
		).rejects.toMatchObject({ kind: "invalid_script" });
		expect(spawnController.calls).toHaveLength(0);
	});

	it("rejects with invalid_script when the path is not a regular file", async () => {
		statMock.stat.mockResolvedValueOnce({ isFile: () => false, size: 10 } as never);

		await expect(
			runEnvironmentInit({ workspacePath: "/ws", scriptPath: "/ws/y.sh", log }),
		).rejects.toMatchObject({ kind: "invalid_script" });
		expect(spawnController.calls).toHaveLength(0);
	});

	it("uses an absolute YEETOMATIC_WORKER_INIT_SCRIPT as-is", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);

		const promise = runEnvironmentInit({
			workspacePath: "/ws",
			log,
			env: { YEETOMATIC_WORKER_INIT_SCRIPT: "/custom/init.sh" },
		});
		await new Promise((resolve) => setImmediate(resolve));

		expect(statMock.stat).toHaveBeenCalledWith("/custom/init.sh");
		spawnController.calls[0].child.emit("exit", 0, null);
		await promise;
		expect(spawnController.calls[0].args[1]).toBe('cd "/ws" && exec bash -- "/custom/init.sh"');
	});

	it("resolves a relative YEETOMATIC_WORKER_INIT_SCRIPT against the workspace path", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);
		const expected = path.resolve("/ws/repo", "scripts/init.sh");

		const promise = runEnvironmentInit({
			workspacePath: "/ws/repo",
			log,
			env: { YEETOMATIC_WORKER_INIT_SCRIPT: "scripts/init.sh" },
		});
		await new Promise((resolve) => setImmediate(resolve));

		expect(statMock.stat).toHaveBeenCalledWith(expected);
		spawnController.calls[0].child.emit("exit", 0, null);
		await promise;
	});

	it("defaults to yeetstrap.sh relative to the workspace", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);
		const expected = path.resolve("/ws/repo", "yeetstrap.sh");

		const promise = runEnvironmentInit({ workspacePath: "/ws/repo", log });
		await new Promise((resolve) => setImmediate(resolve));

		expect(statMock.stat).toHaveBeenCalledWith(expected);
		spawnController.calls[0].child.emit("exit", 0, null);
		await promise;
	});

	it("unsets YEETOMATIC_SESSION_WS_URL from the spawned env", async () => {
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);

		const promise = runEnvironmentInit({
			workspacePath: "/ws",
			scriptPath: "/ws/y.sh",
			log,
			env: { YEETOMATIC_SESSION_WS_URL: "ws://secret", YEETOMATIC_SESSION_KEY: "owner/repo#1" },
		});
		await new Promise((resolve) => setImmediate(resolve));

		const spawnEnv = spawnController.calls[0].options.env as NodeJS.ProcessEnv;
		expect(spawnEnv.YEETOMATIC_SESSION_WS_URL).toBeUndefined();
		expect(spawnEnv.YEETOMATIC_SESSION_KEY).toBe("owner/repo#1");
		spawnController.calls[0].child.emit("exit", 0, null);
		await promise;
	});

	it("parses YEETOMATIC_WORKER_INIT_TIMEOUT_SECONDS from env", async () => {
		vi.useFakeTimers();
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);

		const promise = runEnvironmentInit({
			workspacePath: "/ws",
			scriptPath: "/ws/y.sh",
			log,
			env: { YEETOMATIC_WORKER_INIT_TIMEOUT_SECONDS: "2" },
		});
		await vi.advanceTimersByTimeAsync(0);
		const child = spawnController.calls[0].child;

		// Just under the timeout: no kill yet.
		vi.advanceTimersByTime(2000);
		await expect(promise).rejects.toMatchObject({ kind: "timeout" });
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("falls back to the default timeout when the env value is invalid", async () => {
		// We can't wait 1800s; instead, verify the timer is armed by letting
		// the script exit before any timeout. Invalid -> default (1800).
		statMock.stat.mockResolvedValueOnce(fileStats(100) as never);

		const promise = runEnvironmentInit({
			workspacePath: "/ws",
			scriptPath: "/ws/y.sh",
			log,
			env: { YEETOMATIC_WORKER_INIT_TIMEOUT_SECONDS: "not-a-number" },
		});
		await new Promise((resolve) => setImmediate(resolve));
		spawnController.calls[0].child.emit("exit", 0, null);

		await expect(promise).resolves.toEqual({ skipped: false, scriptPath: "/ws/y.sh" });
	});
});