import { describe, expect, it, vi } from "vitest";
import {
	checkOllamaSignInStatus,
	parseOllamaSignInOutput,
	DefaultOllamaSignInService,
	createOllamaDebugLogger,
	DEFAULT_OLLAMA_CONTAINER_NAME,
	DEFAULT_OLLAMA_SIGNIN_TIMEOUT_MS,
	DEBUG_LOG_ENV,
	type OllamaExecFile,
} from "./signin-status.js";

function fakeExec(resolved: boolean, stdout = "", stderr = ""): OllamaExecFile {
	return vi.fn(async () => {
		if (resolved) {
			return { stdout, stderr };
		}
		throw new Error("should not be called");
	}) as unknown as OllamaExecFile;
}

function failingExec(error: unknown): OllamaExecFile {
	return vi.fn(async () => {
		throw error;
	}) as unknown as OllamaExecFile;
}

describe("parseOllamaSignInOutput", () => {
	it("detects the signed-in shape and extracts the username", () => {
		const text = "You are already signed in as user 'alice'";
		const result = parseOllamaSignInOutput(text);
		expect(result.signedIn).toBe(true);
		expect(result.user).toBe("alice");
		expect(result.signInUrl).toBeUndefined();
		expect(result.message).toBe(text);
	});

	it("detects the not-signed-in shape with a connect URL", () => {
		const text =
			"You need to be signed in to Ollama to run Cloud models.\n\nIf your browser did not open, navigate to:\n    https://ollama.com/connect?name=dev&key=abc";
		const result = parseOllamaSignInOutput(text);
		expect(result.signedIn).toBe(false);
		expect(result.user).toBeUndefined();
		expect(result.signInUrl).toBe("https://ollama.com/connect?name=dev&key=abc");
		expect(result.message).toBe(text);
	});

	it("treats a needs-sign-in message without a URL as not signed in", () => {
		const text = "You need to be signed in to Ollama to run Cloud models.";
		const result = parseOllamaSignInOutput(text);
		expect(result.signedIn).toBe(false);
		expect(result.signInUrl).toBeUndefined();
		expect(result.message).toBe(text);
	});

	it("returns an empty message for blank output", () => {
		expect(parseOllamaSignInOutput("   ")).toEqual({ signedIn: false, message: "" });
	});

	it("returns the raw text for unknown output", () => {
		const result = parseOllamaSignInOutput("something unexpected");
		expect(result).toEqual({ signedIn: false, message: "something unexpected" });
	});
});

describe("checkOllamaSignInStatus", () => {
	it("rejects an empty container name without invoking docker", async () => {
		const exec = fakeExec(true);
		const result = await checkOllamaSignInStatus({ containerName: "  ", execFile: exec });
		expect(result.signedIn).toBe(false);
		expect(result.error).toBe("missing container name");
		expect(exec).not.toHaveBeenCalled();
	});

	it("returns signed-in when the command prints the already-signed-in line", async () => {
		const exec = fakeExec(true, "You are already signed in as user 'bob'\n");
		const result = await checkOllamaSignInStatus({ containerName: "yeetomatic-ollama", execFile: exec });
		expect(result.signedIn).toBe(true);
		expect(result.user).toBe("bob");
		expect(result.error).toBeUndefined();
		expect(exec).toHaveBeenCalledWith("docker", ["exec", "-it", "yeetomatic-ollama", "ollama", "login"], expect.objectContaining({ timeout: DEFAULT_OLLAMA_SIGNIN_TIMEOUT_MS }));
	});

	it("returns the connect URL when the account is not signed in", async () => {
		const exec = fakeExec(true, "You need to be signed in to Ollama to run Cloud models.\n    https://ollama.com/connect?name=x&key=y");
		const result = await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec });
		expect(result.signedIn).toBe(false);
		expect(result.signInUrl).toBe("https://ollama.com/connect?name=x&key=y");
	});

	it("parses stdout from a non-zero exit (rejection) when the URL is present", async () => {
		const exec = failingExec(Object.assign(new Error("Command failed"), {
			stdout: "You need to be signed in to Ollama to run Cloud models.\n    https://ollama.com/connect?name=x&key=y",
			stderr: "",
			code: 1,
		}));
		const result = await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec });
		expect(result.signedIn).toBe(false);
		expect(result.signInUrl).toBe("https://ollama.com/connect?name=x&key=y");
	});

	it("surfaces the connect URL when the command blocks and is killed by the timeout", async () => {
		const exec = failingExec(Object.assign(new Error("Command timed out"), {
			killed: true,
			signal: "SIGTERM",
			stdout: "",
			stderr: "You need to be signed in to Ollama to run Cloud models.\n    https://ollama.com/connect?name=x&key=y",
		}));
		const result = await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec, timeoutMs: 1500 });
		expect(result.signedIn).toBe(false);
		expect(result.signInUrl).toBe("https://ollama.com/connect?name=x&key=y");
		expect(result.error).toBeUndefined();
	});

	it("reports a timeout when the exec is killed with SIGTERM", async () => {
		const exec = failingExec(Object.assign(new Error("Command timed out"), {
			killed: true,
			signal: "SIGTERM",
			stdout: "",
			stderr: "",
		}));
		const result = await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec, timeoutMs: 1500 });
		expect(result.signedIn).toBe(false);
		expect(result.error).toBe("timeout");
		expect(result.message).toContain("1500");
	});

	it("reports a timeout when the error message mentions timed out", async () => {
		const exec = failingExec(Object.assign(new Error("Command timed out after 8s"), {
			stdout: "",
			stderr: "",
		}));
		const result = await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec });
		expect(result.error).toBe("timeout");
	});

	it("reports docker unavailable on ENOENT", async () => {
		const exec = failingExec(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
		const result = await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec });
		expect(result.error).toBe("docker unavailable");
		expect(result.message).toContain("Docker is not available");
	});

	it("reports a missing container from stderr", async () => {
		const exec = failingExec(Object.assign(new Error("exit 1"), {
			stdout: "",
			stderr: "Error: No such container: yeetomatic-ollama",
			code: 1,
		}));
		const result = await checkOllamaSignInStatus({ containerName: "yeetomatic-ollama", execFile: exec });
		expect(result.signedIn).toBe(false);
		expect(result.error).toContain("No such container");
		expect(result.message).toContain("was not found");
	});

	it("falls back to a generic error for unrecognised failure output", async () => {
		const exec = failingExec(Object.assign(new Error("boom"), { stdout: "", stderr: "unexpected failure" }));
		const result = await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec });
		expect(result.signedIn).toBe(false);
		expect(result.error).toBe("unexpected failure");
	});

	it("falls back to the error message when no stdout/stderr is present", async () => {
		const exec = failingExec(new Error("something broke"));
		const result = await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec });
		expect(result.error).toBe("something broke");
		expect(result.message).toBe("something broke");
	});

	describe("debug logging", () => {
		it("logs the issued command and the successful result", async () => {
			const exec = fakeExec(true, "You are already signed in as user 'bob'\n");
			const debug = vi.fn();
			await checkOllamaSignInStatus({ containerName: "yeetomatic-ollama", execFile: exec, debug });
			expect(debug).toHaveBeenCalledWith(
				expect.stringContaining("issuing: docker exec -it yeetomatic-ollama ollama login"),
			);
			expect(debug).toHaveBeenCalledWith(
				expect.stringContaining("result: exit 0"),
			);
			const resultLine = debug.mock.calls.find((c) => String(c[0]).startsWith("result:"))?.[0] as string;
			expect(resultLine).toContain("already signed in as user 'bob'");
		});

		it("logs the issued command and the failure details", async () => {
			const exec = failingExec(Object.assign(new Error("Command failed"), {
				stdout: "",
				stderr: "Error: No such container: yeetomatic-ollama",
				code: 1,
				signal: undefined,
				killed: false,
			}));
			const debug = vi.fn();
			await checkOllamaSignInStatus({ containerName: "yeetomatic-ollama", execFile: exec, debug });
			expect(debug).toHaveBeenCalledWith(
				expect.stringContaining("issuing: docker exec -it yeetomatic-ollama ollama login"),
			);
			const resultLine = debug.mock.calls.find((c) => String(c[0]).startsWith("result:"))?.[0] as string;
			expect(resultLine).toContain("code=1");
			expect(resultLine).toContain("No such container");
			expect(resultLine).toContain("Command failed");
		});

		it("includes the timeout value in the issued-command line", async () => {
			const exec = fakeExec(true, "You are already signed in as user 'bob'\n");
			const debug = vi.fn();
			await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec, timeoutMs: 1500, debug });
			expect(debug).toHaveBeenCalledWith(expect.stringContaining("timeout 1500ms"));
		});

		it("truncates long output in debug lines", async () => {
			const long = "x".repeat(5000);
			const exec = fakeExec(true, long, "");
			const debug = vi.fn();
			await checkOllamaSignInStatus({ containerName: "ollama", execFile: exec, debug });
			const resultLine = debug.mock.calls.find((c) => String(c[0]).startsWith("result:"))?.[0] as string;
			expect(resultLine.length).toBeLessThan(long.length);
			expect(resultLine).toContain("...");
		});
	});
});

describe("createOllamaDebugLogger", () => {
	it("writes a prefixed line to stdout when the env var is enabled", () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = createOllamaDebugLogger({ [DEBUG_LOG_ENV]: "1" } as NodeJS.ProcessEnv);
			logger("hello");
			expect(write).toHaveBeenCalledWith("[ollama-signin] hello\n");
		} finally {
			write.mockRestore();
		}
	});

	it("is a no-op when the env var is unset", () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = createOllamaDebugLogger({} as NodeJS.ProcessEnv);
			logger("hello");
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});

	it("is a no-op when the env var is a non-truthy value", () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = createOllamaDebugLogger({ [DEBUG_LOG_ENV]: "false" } as NodeJS.ProcessEnv);
			logger("hello");
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});
});

describe("DefaultOllamaSignInService", () => {
	function makeStore(getValue?: string) {
		return {
			getString: vi.fn((_key: string, fallback?: string) => getValue ?? fallback ?? DEFAULT_OLLAMA_CONTAINER_NAME),
		} as unknown as import("../settings/store.js").SettingsStore;
	}

	it("reads the container name from settings when none is passed", async () => {
		const exec = fakeExec(true, "You are already signed in as user 'carol'\n");
		const store = makeStore("custom-ollama");
		const service = new DefaultOllamaSignInService(store, exec);
		const result = await service.checkSignInStatus();
		expect(result.signedIn).toBe(true);
		expect(result.user).toBe("carol");
		expect(store.getString).toHaveBeenCalledWith("ollama_container_name", DEFAULT_OLLAMA_CONTAINER_NAME);
		expect(exec).toHaveBeenCalledWith("docker", ["exec", "-it", "custom-ollama", "ollama", "login"], expect.anything());
	});

	it("prefers an explicitly provided container name over settings", async () => {
		const exec = fakeExec(true, "You are already signed in as user 'carol'\n");
		const store = makeStore("settings-ollama");
		const service = new DefaultOllamaSignInService(store, exec);
		await service.checkSignInStatus({ containerName: "explicit-ollama" });
		expect(exec).toHaveBeenCalledWith("docker", ["exec", "-it", "explicit-ollama", "ollama", "login"], expect.anything());
	});

	it("uses the configured container name from settings when the passed value is empty", async () => {
		const exec = fakeExec(true, "You are already signed in as user 'carol'\n");
		const store = makeStore("settings-ollama");
		const service = new DefaultOllamaSignInService(store, exec);
		await service.checkSignInStatus({ containerName: "   " });
		expect(exec).toHaveBeenCalledWith("docker", ["exec", "-it", "settings-ollama", "ollama", "login"], expect.anything());
	});

	it("forwards the injected debug logger to the check", async () => {
		const exec = fakeExec(true, "You are already signed in as user 'carol'\n");
		const store = makeStore();
		const debug = vi.fn();
		const service = new DefaultOllamaSignInService(store, exec, debug);
		await service.checkSignInStatus();
		expect(debug).toHaveBeenCalledWith(
			expect.stringContaining("issuing: docker exec -it"),
		);
		expect(debug).toHaveBeenCalledWith(expect.stringContaining("result: exit 0"));
	});
});
