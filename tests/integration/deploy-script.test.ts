import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BASH =
	process.env.BASH_PATH ??
	execFileSync("/bin/sh", ["-lc", "command -v bash"], { encoding: "utf8" }).trim();

async function withMockCurl(
	responses: string[],
	fn: (extraEnv: Record<string, string>) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "tars-mock-curl-"));
	try {
		const mockCurl = join(dir, "curl");
		const counterFile = join(dir, "counter");
		const script = `#!/bin/bash
for arg in "\$@"; do
  if [ "\$arg" = "POST" ]; then
    echo '{"draining":true}'
    exit 0
  fi
done
COUNTER_FILE="${counterFile}"
COUNT=\$(cat "\$COUNTER_FILE" 2>/dev/null || echo 0)
echo \$((COUNT + 1)) > "\$COUNTER_FILE"
${responses
			.map(
				(r, i) =>
					`if [ "\$COUNT" -eq "${i}" ]; then echo '${r}'; exit 0; fi`,
			)
			.join("\n")}
echo '${responses[responses.length - 1] ?? '{"working":false,"count":0}'}'
`;
		await writeFile(mockCurl, script, "utf8");
		await chmod(mockCurl, 0o755);
		await fn({ PATH: `${dir}:${process.env.PATH ?? ""}` });
	} finally {
		// cleanup is best-effort; OS tmp reaper handles the rest
	}
}

describe("update-tars-if-needed.sh", () => {
	it("polls working status and proceeds when no sessions are working", async () => {
		await withMockCurl(
			['{"working":true,"count":1}', '{"working":false,"count":0}'],
			async (extraEnv) => {
				const { stdout } = await execFileAsync(BASH, ["scripts/update-tars-if-needed.sh"], {
					cwd: process.cwd(),
					env: {
						...process.env,
						...extraEnv,
						SKIP_GIT: "1",
						SKIP_DOCKER: "1",
						PORT: "6767",
						ADMIN_USERNAME: "admin",
						ADMIN_PASSWORD: "secret",
						SLEEP_DURATION: "0.1",
						MAX_TRIES: "5",
					},
				});
				expect(stdout).toContain("Entering maintenance mode...");
				expect(stdout).toContain("Working sessions active. Waiting 0.1s... (attempt 1/5)");
				expect(stdout).toContain("No working sessions. Proceeding with deploy.");
			},
		);
	});

	it("proceeds after max tries even if sessions remain working", async () => {
		await withMockCurl(
			['{"working":true,"count":1}', '{"working":true,"count":1}'],
			async (extraEnv) => {
				const { stdout } = await execFileAsync(BASH, ["scripts/update-tars-if-needed.sh"], {
					cwd: process.cwd(),
					env: {
						...process.env,
						...extraEnv,
						SKIP_GIT: "1",
						SKIP_DOCKER: "1",
						PORT: "6767",
						ADMIN_USERNAME: "admin",
						ADMIN_PASSWORD: "secret",
						SLEEP_DURATION: "0.1",
						MAX_TRIES: "2",
					},
				});
				expect(stdout).toContain("Max attempts (2) reached. Proceeding with deploy anyway.");
			},
		);
	});

	it("skips drain check when admin credentials are missing", async () => {
		const { stdout } = await execFileAsync(BASH, ["scripts/update-tars-if-needed.sh"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				SKIP_GIT: "1",
				SKIP_DOCKER: "1",
				PORT: "6767",
				ADMIN_USERNAME: "",
				ADMIN_PASSWORD: "",
				SLEEP_DURATION: "0.1",
				MAX_TRIES: "2",
			},
		});
		expect(stdout).toContain("Admin credentials not configured. Skipping working-session drain check.");
	});

	it("proceeds when curl is not available", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tars-no-curl-"));
		try {
			const { stdout } = await execFileAsync(BASH, ["scripts/update-tars-if-needed.sh"], {
				cwd: process.cwd(),
				env: {
					...process.env,
					PATH: dir,
					SKIP_GIT: "1",
					SKIP_DOCKER: "1",
					PORT: "6767",
					ADMIN_USERNAME: "admin",
					ADMIN_PASSWORD: "secret",
					SLEEP_DURATION: "0.1",
					MAX_TRIES: "1",
				},
			});
			expect(stdout).toContain("Warning: could not reach TARS status API. Proceeding with deploy.");
		} finally {
			// temp dir cleaned by OS
		}
	});
});
