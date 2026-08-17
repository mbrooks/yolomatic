import React from "react";
import type { MetricsBucket, MetricsResponse, SessionMetric } from "../../app/types.js";
import { formatMs } from "../../lib/format.js";

/**
 * Dashboard metrics panel. Renders persisted per-execution metrics as three
 * lightweight SVG graphs (no charting dependency): token usage over time,
 * execution runtime over time, and session outcomes (complete/failed/
 * cancelled) over time. Token graphs render "unknown" when no bucket in the
 * window reported provider usage.
 */
export function MetricsSection({ metrics }: { metrics: MetricsResponse | null }): React.ReactElement {
	const buckets = metrics && Array.isArray(metrics.buckets) ? metrics.buckets : [];
	if (!metrics || buckets.length === 0) {
		return (
			<div className="dashboard-section metrics-section">
				<h2>Metrics</h2>
				<div className="empty-state">
					<p>No metrics recorded yet. Graphs will populate as sessions complete.</p>
				</div>
			</div>
		);
	}

	const windowDays = metrics?.windowDays ?? 0;
	const windowLabel = windowDays > 0 ? `Last ${windowDays} day${windowDays === 1 ? "" : "s"}` : "Recent";
	const anyTokenUsage = buckets.some((b) => b.tokens.available);
	const totalTokens = buckets.reduce((sum, b) => sum + b.tokens.total, 0);
	const totalRuntimeMs = buckets.reduce((sum, b) => sum + b.runtimeMs, 0);
	const totalSessions = buckets.reduce((sum, b) => sum + b.sessions.total, 0);
	const totalCost = buckets.reduce((sum, b) => sum + b.tokens.cost, 0);

	return (
		<div className="dashboard-section metrics-section">
			<h2>
				Metrics <span className="metrics-window">{windowLabel}</span>
			</h2>
			<div className="metrics-summary">
				<div className="metric-summary-card">
					<div className="metric-summary-label">Sessions</div>
					<div className="metric-summary-value">{totalSessions}</div>
				</div>
				<div className="metric-summary-card">
					<div className="metric-summary-label">Total Runtime</div>
					<div className="metric-summary-value">{formatMs(totalRuntimeMs)}</div>
				</div>
				<div className="metric-summary-card">
					<div className="metric-summary-label">Total Tokens</div>
					<div className="metric-summary-value">
						{anyTokenUsage ? totalTokens.toLocaleString() : "unknown"}
					</div>
				</div>
				<div className="metric-summary-card">
					<div className="metric-summary-label">Est. Cost</div>
					<div className="metric-summary-value">
						{anyTokenUsage ? `$${totalCost.toFixed(4)}` : "unknown"}
					</div>
				</div>
			</div>

			<div className="metrics-charts">
				<TokenUsageChart buckets={buckets} anyAvailable={anyTokenUsage} />
				<RuntimeChart buckets={buckets} />
				<OutcomesChart buckets={buckets} />
			</div>

			<RecentMetricsTable recent={Array.isArray(metrics.recent) ? metrics.recent : []} />
		</div>
	);
}

interface ChartProps {
	buckets: MetricsBucket[];
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 160;
const CHART_PADDING = 28;

function scaleLinear(domain: [number, number], range: [number, number]): (v: number) => number {
	const [d0, d1] = domain;
	const [r0, r1] = range;
	if (d1 === d0) return () => (r0 + r1) / 2;
	return (v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

function bucketXs(buckets: MetricsBucket[]): number[] {
	const innerWidth = CHART_WIDTH - CHART_PADDING * 2;
	if (buckets.length === 1) return [CHART_PADDING + innerWidth / 2];
	const step = innerWidth / (buckets.length - 1);
	return buckets.map((_, i) => CHART_PADDING + i * step);
}

function shortDate(iso: string): string {
	// YYYY-MM-DD -> MM-DD
	const parts = iso.split("-");
	if (parts.length !== 3) return iso;
	return `${parts[1]}-${parts[2]}`;
}

function TokenUsageChart({ buckets, anyAvailable }: ChartProps & { anyAvailable: boolean }): React.ReactElement {
	const xs = bucketXs(buckets);
	const maxTokens = Math.max(1, ...buckets.map((b) => b.tokens.total));
	const y = scaleLinear([0, maxTokens], [CHART_HEIGHT - CHART_PADDING, CHART_PADDING]);
	const points = buckets.map((b, i) => `${xs[i]},${y(b.tokens.total)}`);
	const areaPath = [
		`M ${CHART_PADDING},${y(0)}`,
		...buckets.map((b, i) => `L ${xs[i]},${y(b.tokens.total)}`),
		`L ${xs[buckets.length - 1]},${y(0)}`,
		"Z",
	].join(" ");
	const linePath = buckets.map((b, i) => `${i === 0 ? "M" : "L"} ${xs[i]},${y(b.tokens.total)}`).join(" ");

	return (
		<div className="metrics-chart-card" data-testid="metrics-token-chart">
			<div className="metrics-chart-title">
				Token Usage
				{!anyAvailable && <span className="metrics-unknown">unknown</span>}
			</div>
			<svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="metrics-chart" role="img" aria-label="Token usage over time">
				<AxisLine y={CHART_HEIGHT - CHART_PADDING} />
				{anyAvailable && (
					<>
						<path d={areaPath} className="metrics-area" />
						<path d={linePath} className="metrics-line" />
						{buckets.map((b, i) => (
							<circle key={b.date} cx={xs[i]} cy={y(b.tokens.total)} r={2.5} className="metrics-point" />
						))}
					</>
				)}
				{buckets.map((b, i) => (
					<text key={b.date} x={xs[i]} y={CHART_HEIGHT - 8} className="metrics-tick" textAnchor="middle">
						{shortDate(b.date)}
					</text>
				))}
			</svg>
			{!anyAvailable && (
				<div className="metrics-empty-overlay">Provider did not report token usage.</div>
			)}
			{/* Keep points reference for test access */}
			<span hidden>{points.join(" ")}</span>
		</div>
	);
}

function RuntimeChart({ buckets }: ChartProps): React.ReactElement {
	const xs = bucketXs(buckets);
	const maxMs = Math.max(1, ...buckets.map((b) => b.runtimeMs));
	const y = scaleLinear([0, maxMs], [CHART_HEIGHT - CHART_PADDING, CHART_PADDING]);
	const barWidth = buckets.length > 1 ? Math.max(4, (CHART_WIDTH - CHART_PADDING * 2) / buckets.length - 6) : 12;
	return (
		<div className="metrics-chart-card" data-testid="metrics-runtime-chart">
			<div className="metrics-chart-title">Execution Runtime</div>
			<svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="metrics-chart" role="img" aria-label="Execution runtime over time">
				<AxisLine y={CHART_HEIGHT - CHART_PADDING} />
				{buckets.map((b, i) => (
					<rect
						key={b.date}
						x={xs[i] - barWidth / 2}
						y={y(b.runtimeMs)}
						width={barWidth}
						height={CHART_HEIGHT - CHART_PADDING - y(b.runtimeMs)}
						className="metrics-bar runtime"
					/>
				))}
				{buckets.map((b, i) => (
					<text key={b.date} x={xs[i]} y={CHART_HEIGHT - 8} className="metrics-tick" textAnchor="middle">
						{shortDate(b.date)}
					</text>
				))}
			</svg>
		</div>
	);
}

function OutcomesChart({ buckets }: ChartProps): React.ReactElement {
	const xs = bucketXs(buckets);
	const maxSessions = Math.max(1, ...buckets.map((b) => b.sessions.total));
	const y = scaleLinear([0, maxSessions], [CHART_HEIGHT - CHART_PADDING, CHART_PADDING]);
	const barWidth = buckets.length > 1 ? Math.max(6, (CHART_WIDTH - CHART_PADDING * 2) / buckets.length - 4) : 16;
	return (
		<div className="metrics-chart-card" data-testid="metrics-outcomes-chart">
			<div className="metrics-chart-title">Session Outcomes</div>
			<svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="metrics-chart" role="img" aria-label="Session outcomes over time">
				<AxisLine y={CHART_HEIGHT - CHART_PADDING} />
				{buckets.map((b, i) => {
					const base = CHART_HEIGHT - CHART_PADDING;
					const completeH = base - y(b.sessions.complete);
					const failedH = base - y(b.sessions.failed);
					const cancelledH = base - y(b.sessions.cancelled);
					let yOffset = 0;
					return (
						<g key={b.date} transform={`translate(${xs[i] - barWidth / 2},0)`}>
							<rect x={0} y={base - completeH - yOffset} width={barWidth} height={completeH} className="metrics-bar complete" />
							{yOffset += completeH}
							<rect x={0} y={base - failedH - yOffset} width={barWidth} height={failedH} className="metrics-bar failed" />
							{yOffset += failedH}
							<rect x={0} y={base - cancelledH - yOffset} width={barWidth} height={cancelledH} className="metrics-bar cancelled" />
						</g>
					);
				})}
				{buckets.map((b, i) => (
					<text key={b.date} x={xs[i]} y={CHART_HEIGHT - 8} className="metrics-tick" textAnchor="middle">
						{shortDate(b.date)}
					</text>
				))}
			</svg>
			<div className="metrics-legend">
				<span className="legend-swatch complete" /> Complete
				<span className="legend-swatch failed" /> Failed
				<span className="legend-swatch cancelled" /> Cancelled
			</div>
		</div>
	);
}

function AxisLine({ y }: { y: number }): React.ReactElement {
	return <line x1={CHART_PADDING} y1={y} x2={CHART_WIDTH - CHART_PADDING} y2={y} className="metrics-axis" />;
}

function RecentMetricsTable({ recent }: { recent: SessionMetric[] }): React.ReactElement | null {
	if (recent.length === 0) {
		return null;
	}
	return (
		<div className="metrics-recent">
			<div className="metrics-recent-title">Recent Executions</div>
			<div className="metrics-recent-header">
				<div>Repo</div>
				<div>Issue</div>
				<div>Type</div>
				<div>Status</div>
				<div>Runtime</div>
				<div>Tokens</div>
			</div>
			{recent.map((metric) => (
				<div
					key={`${metric.sessionKey}:${metric.startedAt}`}
					className={`metrics-recent-row ${metric.status}`}
				>
					<div>{metric.owner}/{metric.repo}</div>
					<div>#{metric.issueNumber}</div>
					<div>{metric.kind === "refinement" ? "Refinement" : "Issue"}</div>
					<div>{metric.status}</div>
					<div>{formatMs(metric.durationMs)}</div>
					<div>{metric.tokenUsage.available ? metric.tokenUsage.totalTokens.toLocaleString() : "unknown"}</div>
				</div>
			))}
		</div>
	);
}