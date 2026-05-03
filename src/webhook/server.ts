import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { WebhookHandlers } from "./handlers.js";
import type { SessionState, SessionStore } from "../session/store.js";

export async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

export function verifySignature(secret: string, payload: Buffer, signatureHeader: string | undefined): boolean {
	if (!signatureHeader) {
		return false;
	}

	const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
	const actual = Buffer.from(signatureHeader);
	const target = Buffer.from(expected);

	if (actual.length !== target.length) {
		return false;
	}

	return timingSafeEqual(actual, target);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, statusCode: number, body: string): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "text/plain; charset=utf-8");
	response.end(body);
}

function sendHtml(response: ServerResponse, statusCode: number, body: string): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "text/html; charset=utf-8");
	response.end(body);
}

function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const parts: string[] = [];
	if (d > 0) parts.push(`${d}d`);
	if (h > 0) parts.push(`${h}h`);
	if (m > 0) parts.push(`${m}m`);
	if (s > 0 || parts.length === 0) parts.push(`${s}s`);
	return parts.join(" ");
}

function computeAgentStatus(sessions: SessionState[]): "online" | "busy" | "feedback" {
	const hasWorking = sessions.some((s) => s.status === "working");
	if (hasWorking) return "busy";
	const hasFeedback = sessions.some((s) => s.status === "waiting-feedback");
	if (hasFeedback) return "feedback";
	return "online";
}

function buildStatusResponse(sessions: SessionState[]) {
	return {
		agent: computeAgentStatus(sessions),
		uptime: formatUptime(process.uptime()),
		sessions: sessions.map((s) => ({
			owner: s.owner,
			repo: s.repo,
			issueNumber: s.issueNumber,
			status: s.status,
			workspacePath: s.workspacePath,
			branch: `tars/issue-${s.issueNumber}`,
			lastActivity: s.lastActivity,
			prUrl: s.prUrl ?? null,
			prNumber: s.prNumber ?? null,
		})),
	};
}

function adminHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TARS Admin</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#c9d1d9;--muted:#8b949e;--green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;line-height:1.5;padding:1rem}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
h1{font-size:1.25rem}
.badge{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .6rem;border-radius:999px;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;background:var(--surface);border:1px solid var(--border)}
.badge.online{color:var(--green)}
.badge.busy{color:var(--yellow);animation:pulse 2s infinite}
.badge.feedback{color:var(--blue)}
.badge.offline{color:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
table{width:100%;border-collapse:collapse;font-size:.875rem;margin-top:1rem}
th,td{padding:.6rem .5rem;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
td{color:var(--text)}
tr:hover td{background:var(--surface)}
.status-badge{font-size:.75rem;padding:.15rem .4rem;border-radius:4px;background:var(--surface);border:1px solid var(--border)}
.status-badge.pending{color:var(--muted)}
.status-badge.working{color:var(--yellow)}
.status-badge.waiting-feedback{color:var(--blue)}
.status-badge.complete{color:var(--green)}
.status-badge.failed{color:var(--red)}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
.empty{color:var(--muted);padding:2rem 0;text-align:center}
.last-updated{color:var(--muted);font-size:.75rem;margin-top:.5rem}
@media(max-width:600px){th,td{white-space:normal}td:nth-child(3),td:nth-child(4),th:nth-child(3),th:nth-child(4){display:none}}
</style>
</head>
<body>
<header>
<h1>TARS Admin</h1>
<span id="agent-badge" class="badge offline">Offline</span>
</header>
<div id="session-list"></div>
<div class="last-updated" id="last-updated">Loading…</div>
<script>
const $=id=>document.getElementById(id);
const fmtRelative=(iso)=>{const s=(Date.now()-new Date(iso).getTime())/1e3|0;if(s<60)return s+'s ago';const m=s/60|0;if(m<60)return m+'m ago';const h=m/60|0;if(h<24)return h+'h ago';return(h/24|0)+'d ago'};
const badgeClass={online:'online',busy:'busy',feedback:'feedback',offline:'offline'};
const sessionClass={pending:'pending',working:'working','waiting-feedback':'waiting-feedback',complete:'complete',failed:'failed'};
async function load(){try{const res=await fetch('/api/status');if(!res.ok)throw new Error('HTTP '+res.status);const data=await res.json();$('agent-badge').className='badge '+(badgeClass[data.agent]||'offline');$('agent-badge').textContent=data.agent==='online'?'Online':data.agent==='busy'?'Busy':data.agent==='feedback'?'Feedback':'Offline';const list=$('session-list');if(!data.sessions.length){list.innerHTML='<div class="empty">No active sessions</div>';}else{const cols=['Repo','Issue','Status','Workspace','Last Activity','PR'];const rows=data.sessions.map(s=>{\nconst repoLink=s.owner+'/'+s.repo;\nconst issueLink='<a href="https://github.com/'+s.owner+'/'+s.repo+'/issues/'+s.issueNumber+'" target="_blank">#'+s.issueNumber+'</a>';\nconst prLink=s.prUrl?'<a href="'+s.prUrl+'" target="_blank">#'+s.prNumber+'</a>':'—';\nreturn '<tr><td>'+repoLink+'</td><td>'+issueLink+'</td><td><span class="status-badge '+sessionClass[s.status]+'">'+s.status+'</span></td><td>'+s.workspacePath+'</td><td>'+fmtRelative(s.lastActivity)+'</td><td>'+prLink+'</td></tr>';}).join('');list.innerHTML='<table><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table>';}const now=new Date();$('last-updated').textContent='Last updated: '+now.toLocaleTimeString();}catch(e){$('agent-badge').className='badge offline';$('agent-badge').textContent='Offline';$('session-list').innerHTML='<div class="empty">Unable to reach API</div>';$('last-updated').textContent='Error: '+e.message;}}
load();
setInterval(load,5000);
</script>
</body>
</html>`;
}

export function createWebhookServer(secret: string, handlers: WebhookHandlers, sessionStore: SessionStore) {
	return createServer(async (request, response) => {
		process.stdout.write(
			`[webhook] ${new Date().toISOString()} ${request.method ?? "UNKNOWN"} ${request.url ?? ""}\n`,
		);

		if (request.method === "GET" && request.url === "/admin") {
			sendHtml(response, 200, adminHtml());
			return;
		}

		if (request.method === "GET" && request.url === "/api/status") {
			try {
				const sessions = await sessionStore.getAll();
				sendJson(response, 200, buildStatusResponse(sessions));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[webhook] status error: ${message}\n`);
				sendJson(response, 500, { error: message });
			}
			return;
		}

		if (request.method !== "POST" || request.url !== "/webhook") {
			process.stdout.write("[webhook] rejected request: route mismatch\n");
			sendText(response, 404, "Not found");
			return;
		}

		const body = await readBody(request);
		const signature = request.headers["x-hub-signature-256"] as string | undefined;

		if (!verifySignature(secret, body, signature)) {
			process.stdout.write("[webhook] rejected request: invalid signature\n");
			sendText(response, 401, "Invalid signature");
			return;
		}

		const event = request.headers["x-github-event"] as string | undefined;
		const delivery = request.headers["x-github-delivery"] as string | undefined;

		const payload = JSON.parse(body.toString("utf8")) as unknown;
		process.stdout.write(
			`[webhook] accepted delivery=${delivery ?? "unknown"} event=${event ?? "unknown"}\n`,
		);

		try {
			if (event === "issues") {
				await handlers.handleIssueEvent(payload);
			} else if (event === "issue_comment") {
				await handlers.handleCommentEvent(payload);
			} else if (event === "pull_request_review_comment") {
				await handlers.handlePullRequestReviewCommentEvent(payload);
			} else if (event === "pull_request_review") {
				await handlers.handlePullRequestReviewEvent(payload);
			} else {
				process.stdout.write(`[webhook] ignored unsupported event=${event ?? "unknown"}\n`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] handler error: ${message}\n`);
			sendText(response, 500, message);
			return;
		}

		process.stdout.write("[webhook] handled successfully\n");
		sendText(response, 200, "OK");
	});
}
