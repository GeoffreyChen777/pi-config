import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import {
	getCompactMarkdownTheme,
	normalizeCompactCodeBlockLines,
} from "../compact-mode/index.ts";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import {
	createMessageRouter,
	ENV_ROLE,
	MAIN_AGENT,
	registerChildMessaging,
	writeReply,
	channelDir,
	removeRequestFile,
	type MessageRequest,
} from "./message.ts";
import { SubagentPool } from "./pool.ts";
import type { SubagentSessionHandle } from "./session.ts";
import { openSubagentSessionOverlay } from "./session-ui.ts";
import { getFinalOutput, spawnInteractiveSubagent } from "./spawn.ts";

const MESSAGE_ROOT_BASE = "/tmp/pi-subagents-messages";
const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 6 * 60 * 60;
const MIN_SUBAGENT_TIMEOUT_SECONDS = 10;
const MAX_SUBAGENT_TIMEOUT_SECONDS = 3 * 24 * 60 * 60;
const RUNNING_WIDGET_KEY = "subagents-running";
const RUNNING_WIDGET_MAX_ITEMS = 4;
const RUNNING_WIDGET_SUMMARY_MAX_WIDTH = 40;
const RUNNING_WIDGET_TICK_MS = 250;
const RUNNING_WIDGET_NAV_DEBOUNCE_MS = 150;
const RUNNING_WIDGET_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INCOMING_MESSAGE_TYPE = "pi_message_request";
const BACKGROUND_EVENT_TYPE = "pi_subagent_background_event";

interface IncomingMessageDetails {
	id?: string;
	from?: string;
	expectsReply?: boolean;
	content?: string;
	createdAt?: number;
}

interface BackgroundEventDetails {
	agent?: string;
	status?: "done" | "error";
	body?: string;
	elapsedMs?: number;
	runId?: string;
}

type TranscriptEventKind = "message" | "done" | "error";

function customMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

function legacyIncomingMessageBody(content: unknown): string {
	const text = customMessageText(content).trim();
	if (!text) return "";
	return text
		.replace(/^\[message from [^\]]+\]\s+message_id=[^\n]+\n*/i, "")
		.replace(/\n*Reply with the reply_message tool, using message_id=[^\n.]+\.?\s*$/i, "")
		.trim();
}

function formatEventDuration(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
	if (minutes > 0) return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
	return `${seconds}s`;
}

class SubagentTranscriptEventComponent implements Component {
	private readonly markdown: Markdown | undefined;

	constructor(
		private readonly kind: TranscriptEventKind,
		private readonly agent: string,
		private readonly body: string,
		private readonly theme: any,
		private readonly replyRequested = false,
		private readonly elapsedMs?: number,
	) {
		const content = body.trim();
		if (content) {
			this.markdown = new Markdown(
				content,
				0,
				0,
				getCompactMarkdownTheme(),
				{ color: (text) => this.theme?.fg?.("text", text) ?? text },
			);
		}
	}

	private renderHeader(width: number): string {
		const fg = (color: string, text: string) => this.theme?.fg?.(color, text) ?? text;
		const bold = this.theme?.bold ? this.theme.bold.bind(this.theme) : (text: string) => text;
		const icon = this.kind === "message" ? "←" : this.kind === "done" ? "✓" : "✗";
		const iconColor = this.kind === "message" ? "accent" : this.kind === "done" ? "success" : "error";
		const mode = this.kind === "message" ? "[msg]" : "[bg]";
		const status =
			this.kind === "message"
				? this.replyRequested
					? "reply requested"
					: "message"
				: this.kind === "done"
					? "completed"
					: "failed";
		const statusColor =
			this.kind === "message"
				? this.replyRequested
					? "warning"
					: "muted"
				: iconColor;
		const elapsed =
			this.elapsedMs === undefined
				? ""
				: fg("muted", ` · ${formatEventDuration(this.elapsedMs)}`);
		const header =
			`${fg(iconColor, icon)} ${fg("toolTitle", bold(this.agent))}` +
			`${fg("muted", ` ${mode} `)}${fg(statusColor, `• ${status}`)}${elapsed}`;
		return truncateToWidth(header, Math.max(1, width), "…");
	}

	render(width: number): string[] {
		const padding = " ".repeat(Math.min(1, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - padding.length);
		const lines = [padding + this.renderHeader(contentWidth)];
		if (this.markdown) {
			const railWidth = contentWidth >= 2 ? 1 : 0;
			const railGap = contentWidth >= 3 ? 1 : 0;
			const bodyWidth = Math.max(1, contentWidth - railWidth - railGap);
			const bodyLines = normalizeCompactCodeBlockLines(
				this.markdown.render(bodyWidth),
				bodyWidth,
				0,
			);
			for (let index = 0; index < bodyLines.length; index++) {
				const connector = index === bodyLines.length - 1 ? "└" : "│";
				const rail =
					railWidth > 0
						? `${this.theme?.fg?.("dim", connector) ?? connector}${" ".repeat(railGap)}`
						: "";
				lines.push(padding + rail + truncateToWidth(bodyLines[index]!, bodyWidth, "…"));
			}
		}
		return lines;
	}

	invalidate(): void {
		this.markdown?.invalidate();
	}
}

function sessionRoot(sessionId: string): string {
	return `${MESSAGE_ROOT_BASE}/${sessionId.replace(/[^\w.-]+/g, "_")}`;
}

// ============================================================================
// Orchestrator mode (/orchestrate command)
// ============================================================================

const ORCHESTRATOR_MODE_ENTRY = "orchestrator-mode";
const ORCHESTRATOR_PROMPT_MARKER = "# You are the Orchestrator";
const SUBAGENT_USAGE_GUARD = [
	"# Subagent Usage Gate",
	"",
	"Do not use subagents unless at least one of these conditions is true:",
	"1. The user's current request explicitly asks you to use, call, spawn, delegate to, or communicate with a subagent.",
	"2. Orchestrator mode is enabled.",
	"",
	"When neither condition is true:",
	"- Do not call the `subagent` tool.",
	"- Do not call `send_message` to contact or assign work to a subagent.",
	"- Do not initiate or continue a planner/actor/reviewer workflow.",
	"- Perform the task yourself using the normal tools available to the main agent.",
	"",
	"Task complexity, convenience, a desire for planning/review, the availability of subagent tools, or prior subagent use are not authorization.",
	"A generic request to plan, review, test, or implement something is not authorization unless the user explicitly requests subagent involvement.",
].join("\n");

function orchestratorPromptPath(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "orchestrator.md");
}

let orchestratorPromptCache: string | undefined;
function readOrchestratorPrompt(): string {
	if (orchestratorPromptCache !== undefined) return orchestratorPromptCache;
	orchestratorPromptCache = "";
	try {
		const content = fs.readFileSync(orchestratorPromptPath(), "utf-8");
		// strip YAML frontmatter, keep only the prompt body
		const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
		orchestratorPromptCache = (match ? match[1] : content).trim();
	} catch {
		/* ignore */
	}
	return orchestratorPromptCache;
}

/** Read the current session's orchestrator-mode flag (the last entry wins) */
function isOrchestratorMode(ctx: { sessionManager?: { getEntries?: () => unknown[] } }): boolean {
	try {
		const entries = (ctx.sessionManager?.getEntries?.() ?? []) as Array<{
			type?: string;
			customType?: string;
			data?: { enabled?: boolean };
		}>;
		let enabled = false;
		for (const e of entries) {
			if (e.type === "custom" && e.customType === ORCHESTRATOR_MODE_ENTRY && typeof e.data?.enabled === "boolean") {
				enabled = e.data.enabled;
			}
		}
		return enabled;
	} catch {
		return false;
	}
}

/** Path of a built-in agent definition file */
function agentFilePath(agentName: string): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "agents", `${agentName}.md`);
}

/** Available model ids (provider/model) for the current session */
function availableModelIds(ctx: {
	scopedModels?: Array<{ model?: { provider?: string; id?: string } }>;
	modelRegistry?: { getAvailable?: () => Array<{ provider?: string; id?: string }> };
}): string[] {
	const scoped = ctx.scopedModels;
	if (Array.isArray(scoped) && scoped.length > 0) {
		return scoped
			.map((e) => (e.model?.provider && e.model?.id ? `${e.model.provider}/${e.model.id}` : ""))
			.filter(Boolean);
	}
	const avail = ctx.modelRegistry?.getAvailable?.() ?? [];
	return avail
		.map((m) => (m.provider && m.id ? `${m.provider}/${m.id}` : ""))
		.filter(Boolean);
}

/** Update a `model` or `thinking` line in an agent's frontmatter */
function updateAgentConfig(agentName: string, key: "model" | "thinking", value: string): boolean {
	const file = agentFilePath(agentName);
	if (!fs.existsSync(file)) return false;
	try {
		let content = fs.readFileSync(file, "utf-8");
		const lineRe = new RegExp(`^(${key}:).*$`, "m");
		if (lineRe.test(content)) {
			content = content.replace(lineRe, `${key}: ${value}`);
		} else {
			// insert after the opening frontmatter marker
			content = content.replace(/^---\r?\n/, `---\n${key}: ${value}\n`);
		}
		fs.writeFileSync(file, content, "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Background async tasks (one-shot process per task; result injected on completion)
// ============================================================================

interface AsyncTask {
	runId: string;
	agent: string;
	status: "running" | "done" | "error";
	startedAt: number;
}

export interface RunningSubagentActivity {
	id: string;
	agent: string;
	summary: string;
	mode: "task" | "background" | "message";
	startedAt: number;
}

function summarizeActivity(value: string): string {
	const summary = String(value ?? "")
		.replace(/```[\w-]*\s*/g, "")
		.replace(/[`*_#>]+/g, "")
		.replace(/^Task:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!summary) return "working…";
	return summary.length > 500 ? `${summary.slice(0, 499)}…` : summary;
}

function formatActivityElapsed(startedAt: number): string {
	const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

export class RunningSubagentWidgetController {
	private activities = new Map<string, RunningSubagentActivity>();
	private selectedId: string | undefined;
	private ui: any;
	private tui: any;
	private installed = false;
	private timer: ReturnType<typeof setInterval> | undefined;

	get size(): number {
		return this.activities.size;
	}

	getSelected(): RunningSubagentActivity | undefined {
		return this.selectedId ? this.activities.get(this.selectedId) : undefined;
	}

	moveSelection(delta: -1 | 1): RunningSubagentActivity | undefined {
		const activities = [...this.activities.values()].sort((a, b) => a.startedAt - b.startedAt);
		if (activities.length === 0) {
			this.selectedId = undefined;
			return undefined;
		}
		const current = activities.findIndex((activity) => activity.id === this.selectedId);
		const next =
			current < 0
				? delta > 0
					? 0
					: activities.length - 1
				: (current + delta + activities.length) % activities.length;
		this.selectedId = activities[next]!.id;
		this.tui?.requestRender?.();
		return activities[next];
	}

	clearSelection(): void {
		if (!this.selectedId) return;
		this.selectedId = undefined;
		this.tui?.requestRender?.();
	}

	attach(ctx: { mode?: string; ui?: any }): void {
		this.removeWidget();
		this.ui = ctx.mode === "tui" ? ctx.ui : undefined;
		if (this.activities.size > 0) this.ensureWidget();
	}

	shutdown(): void {
		this.activities.clear();
		this.selectedId = undefined;
		this.removeWidget();
		this.ui = undefined;
	}

	start(id: string, agent: string, task: string, mode: RunningSubagentActivity["mode"]): void {
		this.activities.set(id, {
			id,
			agent,
			summary: summarizeActivity(task),
			mode,
			startedAt: Date.now(),
		});
		this.ensureWidget();
	}

	finish(id: string): void {
		const before = [...this.activities.values()].sort((a, b) => a.startedAt - b.startedAt);
		const removedIndex = before.findIndex((activity) => activity.id === id);
		this.activities.delete(id);
		if (this.selectedId === id) {
			const after = before.filter((activity) => activity.id !== id);
			this.selectedId = after.length > 0 ? after[Math.min(Math.max(0, removedIndex), after.length - 1)]!.id : undefined;
		}
		if (this.activities.size === 0) this.removeWidget();
		else {
			this.ensureWidget();
			this.tui?.requestRender?.();
		}
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private removeWidget(): void {
		this.stopTimer();
		this.tui = undefined;
		if (this.ui && this.installed) {
			try {
				this.ui.setWidget(RUNNING_WIDGET_KEY, undefined);
			} catch {
				/* session may already be closed */
			}
		}
		this.installed = false;
	}

	private ensureWidget(): void {
		if (!this.ui || this.activities.size === 0) {
			if (this.activities.size === 0) this.removeWidget();
			return;
		}
		if (!this.installed) {
			try {
				this.ui.setWidget(
					RUNNING_WIDGET_KEY,
					(tui: any, theme: any) => {
						this.tui = tui;
						return {
							render: (width: number): string[] => this.render(width, theme),
							invalidate(): void {},
						};
					},
					{ placement: "aboveEditor" },
				);
				this.installed = true;
			} catch {
				// A missing/closing TUI must never prevent a subagent from running.
				this.installed = false;
				return;
			}
		}
		if (!this.timer) {
			this.timer = setInterval(() => {
				if (this.activities.size === 0) {
					this.removeWidget();
					return;
				}
				this.tui?.requestRender?.();
			}, RUNNING_WIDGET_TICK_MS);
			this.timer.unref?.();
		}
		this.tui?.requestRender?.();
	}

	private render(width: number, theme: any): string[] {
		const safeWidth = Math.max(1, width);
		const padding = safeWidth > 1 ? " " : "";
		const contentWidth = Math.max(1, safeWidth - padding.length);
		const activities = [...this.activities.values()].sort((a, b) => a.startedAt - b.startedAt);
		if (activities.length === 0) return [];
		const frame =
			RUNNING_WIDGET_SPINNER[
				Math.floor(Date.now() / RUNNING_WIDGET_TICK_MS) % RUNNING_WIDGET_SPINNER.length
			]!;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const bold = theme?.bold ? (text: string) => theme.bold(text) : (text: string) => text;
		const title =
			`${fg("accent", frame)} ${fg("accent", bold("Subagents"))} ` +
			fg("muted", `· ${activities.length} running`);
		const hasSelection = this.selectedId !== undefined;
		const shortcutCandidates = hasSelection
			? ["⇧+↑/↓ move · Enter open · Esc clear", "⇧+↑/↓ · Enter · Esc", "⇧+↑/↓"]
			: ["⇧+↑/↓ select · Enter open", "⇧+↑/↓ · Enter", "⇧+↑/↓"];
		let titleWithShortcuts = title;
		for (const shortcut of shortcutCandidates) {
			const suffix = fg("dim", ` · ${shortcut}`);
			if (visibleWidth(title + suffix) <= contentWidth) {
				titleWithShortcuts = title + suffix;
				break;
			}
		}
		const lines = [titleWithShortcuts];
		const selectedIndex = activities.findIndex((activity) => activity.id === this.selectedId);
		const windowStart =
			selectedIndex >= RUNNING_WIDGET_MAX_ITEMS
				? Math.min(
						selectedIndex - RUNNING_WIDGET_MAX_ITEMS + 1,
						Math.max(0, activities.length - RUNNING_WIDGET_MAX_ITEMS),
					)
				: 0;
		const visible = activities.slice(windowStart, windowStart + RUNNING_WIDGET_MAX_ITEMS);
		for (let index = 0; index < visible.length; index++) {
			const activity = visible[index]!;
			const isLast = index === visible.length - 1 && activities.length <= RUNNING_WIDGET_MAX_ITEMS;
			const rail = isLast ? "└" : "├";
			const selected = activity.id === this.selectedId;
			const indicator = selected ? fg("accent", "›") : fg("dim", rail);
			const mode = activity.mode === "background" ? " [bg]" : activity.mode === "message" ? " [msg]" : "";
			const prefix = `${indicator} ${fg("toolTitle", bold(activity.agent))}${fg("muted", mode)} ${fg("muted", `· ${formatActivityElapsed(activity.startedAt)} ·`)}`;
			const availableSummaryWidth = Math.max(
				0,
				Math.min(RUNNING_WIDGET_SUMMARY_MAX_WIDTH, contentWidth - visibleWidth(prefix) - 1),
			);
			const summary =
				availableSummaryWidth > 0 ? truncateToWidth(activity.summary, availableSummaryWidth, "…") : "";
			lines.push(`${prefix}${summary ? ` ${fg("dim", summary)}` : ""}`);
		}
		if (activities.length > RUNNING_WIDGET_MAX_ITEMS) {
			lines.push(fg("muted", `└ … +${activities.length - RUNNING_WIDGET_MAX_ITEMS} more`));
		}
		return lines.map((line) => padding + truncateToWidth(line, contentWidth, "…"));
	}
}

export default function (pi: ExtensionAPI) {
	const isChild = process.env[ENV_ROLE] === "child";

	if (isChild) {
		// ===== subagent mode: register generic messaging tools =====
		registerChildMessaging(pi);
		return;
	}

	// ===== main-agent mode =====
	pi.registerMessageRenderer<IncomingMessageDetails>(
		INCOMING_MESSAGE_TYPE,
		(message, _options, theme) => {
			const details = message.details ?? {};
			const agent = String(details.from || "subagent");
			const body =
				typeof details.content === "string"
					? details.content
					: legacyIncomingMessageBody(message.content);
			return new SubagentTranscriptEventComponent(
				"message",
				agent,
				body,
				theme,
				Boolean(details.expectsReply),
			);
		},
	);
	pi.registerMessageRenderer<BackgroundEventDetails>(
		BACKGROUND_EVENT_TYPE,
		(message, _options, theme) => {
			const details = message.details ?? {};
			const kind: TranscriptEventKind = details.status === "error" ? "error" : "done";
			const agent = String(details.agent || "subagent");
			const body =
				typeof details.body === "string"
					? details.body
					: customMessageText(message.content);
			const elapsedMs =
				typeof details.elapsedMs === "number" && Number.isFinite(details.elapsedMs)
					? Math.max(0, details.elapsedMs)
					: undefined;
			return new SubagentTranscriptEventComponent(
				kind,
				agent,
				body,
				theme,
				false,
				elapsedMs,
			);
		},
	);

	let cwd = process.cwd();
	let messageRoot = sessionRoot("ephemeral");
	const tasks = new Map<string, AsyncTask>();
	const pool = new SubagentPool(messageRoot);
	const runningWidget = new RunningSubagentWidgetController();
	const sessionHandles = new Map<string, SubagentSessionHandle>();
	let sessionContext: any;
	let terminalInputUnsubscribe: (() => void) | undefined;
	let sessionOverlayOpen = false;
	let pendingOpenActivityId: string | undefined;
	let lastNavigation: { direction: -1 | 1; at: number } | undefined;

	function moveWidgetSelection(direction: -1 | 1): void {
		const now = Date.now();
		if (
			lastNavigation?.direction === direction &&
			now - lastNavigation.at < RUNNING_WIDGET_NAV_DEBOUNCE_MS
		) {
			return;
		}
		lastNavigation = { direction, at: now };
		pendingOpenActivityId = undefined;
		runningWidget.moveSelection(direction);
	}

	function registerSessionHandle(activityId: string, session: SubagentSessionHandle): void {
		sessionHandles.set(activityId, session);
		if (pendingOpenActivityId === activityId) {
			queueMicrotask(() => openSelectedSession());
		}
	}

	function openSelectedSession(): void {
		if (sessionOverlayOpen || !sessionContext) return;
		const selected = runningWidget.getSelected();
		if (!selected) return;
		const session = sessionHandles.get(selected.id);
		if (!session) {
			pendingOpenActivityId = selected.id;
			sessionContext.ui.notify(`Opening ${selected.agent} session when it is ready…`, "info");
			return;
		}
		pendingOpenActivityId = undefined;
		runningWidget.clearSelection();
		sessionOverlayOpen = true;
		void openSubagentSessionOverlay(sessionContext, session)
			.catch((error) => {
				sessionContext?.ui?.notify?.(
					`Failed to open ${selected.agent} session: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			})
			.finally(() => {
				sessionOverlayOpen = false;
			});
	}

	pi.on("session_start", (event, ctx) => {
		cwd = ctx.cwd;
		const sessionId =
			ctx.sessionManager?.getSessionId?.() ??
			(event as any).sessionId ??
			"ephemeral";
		messageRoot = sessionRoot(sessionId);
		fs.mkdirSync(messageRoot, { recursive: true });
		pool.setIntercomRoot(messageRoot);
		pool.setWorkingDirectory(cwd);
		runningWidget.attach(ctx);
		sessionContext = ctx.mode === "tui" ? ctx : undefined;
		lastNavigation = undefined;
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe =
			ctx.mode === "tui"
				? ctx.ui.onTerminalInput((data: string) => {
						if (runningWidget.size === 0 || sessionOverlayOpen) return;
						if (matchesKey(data, Key.shift("up"))) {
							moveWidgetSelection(-1);
							return { consume: true };
						}
						if (matchesKey(data, Key.shift("down"))) {
							moveWidgetSelection(1);
							return { consume: true };
						}
						if (matchesKey(data, Key.enter) && runningWidget.getSelected()) {
							openSelectedSession();
							return { consume: true };
						}
						if (matchesKey(data, Key.escape) && runningWidget.getSelected()) {
							pendingOpenActivityId = undefined;
							runningWidget.clearSelection();
							return { consume: true };
						}
					})
				: undefined;
	});

	pi.on("session_shutdown", () => {
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = undefined;
		sessionContext = undefined;
		pendingOpenActivityId = undefined;
		sessionHandles.clear();
		runningWidget.shutdown();
		pool.dispose();
	});

	// ---- message router: subagent -> main injects into main session; subagent -> subagent forwards to a resident process ----
	let router: ReturnType<typeof createMessageRouter> | undefined;
	pi.on("session_start", () => {
		router?.dispose();
		router = createMessageRouter(pi, {
			root: messageRoot,
			matchesContext: () => true,
			// to main: inject into the main session; the main model replies with reply_message
			onMainMessage: (msg: MessageRequest) => {
				try {
					const protocolInstruction = msg.expectsReply
						? `Reply with the reply_message tool, using message_id=${msg.id}.`
						: "This is a fire-and-forget message; no reply is required.";
					pi.sendMessage(
						{
							customType: INCOMING_MESSAGE_TYPE,
							content: [
								`[message from ${msg.from}] message_id=${msg.id}`,
								msg.content,
								protocolInstruction,
							].join("\n\n"),
							display: true,
							details: {
								id: msg.id,
								from: msg.from,
								expectsReply: msg.expectsReply,
								content: msg.content,
								createdAt: msg.createdAt,
							},
						},
						{ triggerTurn: true },
					);
					if (!msg.expectsReply) removeRequestFile(msg);
				} catch {
					/* session may be closed */
				}
			},
			// to another subagent: route to its resident process, collect its reply, write it back
			onChildMessage: async (msg: MessageRequest, signal?: AbortSignal) => {
				const agents = discoverAgents(cwd);
				const target = agents.find((a) => a.name === msg.to);
				if (!target) {
					const reply = `Unknown subagent "${msg.to}"`;
					completeRoutedMessage(msg, reply);
					if (msg.from === MAIN_AGENT) throw new Error(reply);
					return reply;
				}
				const activityId = `message:${msg.id}`;
				runningWidget.start(activityId, target.name, msg.content, "message");
				try {
					await pool.ensureProcess(target);
					registerSessionHandle(activityId, pool.getSessionHandle(target));
					const timeoutMs = Math.min(
						MAX_SUBAGENT_TIMEOUT_SECONDS * 1000,
						Math.max(MIN_SUBAGENT_TIMEOUT_SECONDS * 1000, msg.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS * 1000),
					);
					const result = await pool.runTask(
						target,
						[
							`You received a message from ${msg.from === MAIN_AGENT ? "the main agent" : `subagent ${msg.from}`} (message id ${msg.id}):`,
							``,
							msg.content,
							``,
							`Process this message and give your reply. Your reply will be sent back to ${msg.from === MAIN_AGENT ? "the main agent" : msg.from}.`,
						].join("\n"),
						timeoutMs,
						undefined,
						signal,
					);
					const replyText = getFinalOutput(result.messages) || `(subagent ${msg.to} gave no reply)`;
					completeRoutedMessage(msg, replyText);
					return replyText;
				} catch (e) {
					const reply = `Target subagent failed to process the message: ${e instanceof Error ? e.message : String(e)}`;
					completeRoutedMessage(msg, reply);
					if (msg.from === MAIN_AGENT) throw new Error(reply);
					return reply;
				} finally {
					if (pendingOpenActivityId === activityId) pendingOpenActivityId = undefined;
					sessionHandles.delete(activityId);
					runningWidget.finish(activityId);
				}
			},
		});
		router.start();
	});

	pi.on("session_shutdown", () => {
		router?.dispose();
		router = undefined;
	});

	/** Write a reply back to the message sender */
	function writeReplyTo(msg: MessageRequest, content: string) {
		try {
			const dir = channelDir(messageRoot, msg.fromRunId, msg.fromAgent, msg.fromChildIndex);
			writeReply(dir, msg.id, content);
			removeRequestFile(msg);
		} catch {
			/* ignore */
		}
	}

	function completeRoutedMessage(msg: MessageRequest, content: string) {
		if (msg.from === MAIN_AGENT) return;
		if (msg.expectsReply) writeReplyTo(msg, content);
		else removeRequestFile(msg);
	}

	// ---- background task persistence ----
	function persistTasks() {
		try {
			pi.appendEntry(
				"subagent-async-task",
				[...tasks.values()].map((t) => ({
					runId: t.runId,
					agent: t.agent,
					status: t.status,
					startedAt: t.startedAt,
				})),
			);
		} catch {
			/* ignore */
		}
	}

	function launchBackground(agent: AgentConfig, taskText: string, cwdOverride?: string, timeoutMs?: number): string {
		const runId = randomUUID();
		tasks.set(runId, { runId, agent: agent.name, status: "running", startedAt: Date.now() });
		persistTasks();
		runningWidget.start(runId, agent.name, taskText, "background");

		spawnInteractiveSubagent({
			agent,
			task: taskText,
			cwd: cwdOverride,
			messageRoot,
			runId,
			childIndex: 0,
			timeoutMs,
			onSession: (session) => registerSessionHandle(runId, session),
		})
			.then((result) => {
				const task = tasks.get(runId);
				if (!task) return;
				const finalStatus: "done" | "error" =
					result.exitCode === 0 && result.stopReason !== "error" ? "done" : "error";
				task.status = finalStatus;
				persistTasks();
				const output = getFinalOutput(result.messages) || "(no text output)";
				const failureReason =
					result.exitCode !== 0
						? result.stderr || result.errorMessage || `process exited with code ${result.exitCode}`
						: result.stopReason === "error"
							? result.errorMessage || "subagent reported an error"
							: "";
				const head =
					finalStatus === "done"
						? `Subagent ${agent.name} done (run ${runId.slice(0, 8)})`
						: `Subagent ${agent.name} failed: ${failureReason}`;
				const displayBody =
					finalStatus === "done"
						? output
						: [
								failureReason,
								output === "(no text output)" ? "" : `**Partial result**\n\n${output}`,
							]
								.filter(Boolean)
								.join("\n\n");
				try {
					pi.sendMessage(
						{
							customType: BACKGROUND_EVENT_TYPE,
							content: `[background subagent ${finalStatus}] ${head}\n\n--- result ---\n${output}`,
							display: true,
							details: {
								agent: agent.name,
								status: finalStatus,
								body: displayBody,
								elapsedMs: Date.now() - task.startedAt,
								runId,
							},
						},
						{ triggerTurn: true, deliverAs: "steer" },
					);
				} catch {
					/* session is closed */
				}
			})
			.catch((err) => {
				const task = tasks.get(runId);
				if (task) {
					task.status = "error";
					persistTasks();
				}
				const errorText = err instanceof Error ? err.message : String(err);
				try {
					pi.sendMessage(
						{
							customType: BACKGROUND_EVENT_TYPE,
							content: `[background subagent error] ${agent.name} (run ${runId.slice(0, 8)}): ${errorText}`,
							display: true,
							details: {
								agent: agent.name,
								status: "error",
								body: errorText,
								elapsedMs: task ? Date.now() - task.startedAt : undefined,
								runId,
							},
						},
						{ triggerTurn: true, deliverAs: "steer" },
					);
				} catch {
					/* ignore */
				}
			})
			.finally(() => {
				if (pendingOpenActivityId === runId) pendingOpenActivityId = undefined;
				sessionHandles.delete(runId);
				runningWidget.finish(runId);
			});

		return runId;
	}

	// ---- system prompt gate: subagents require explicit user authorization or orchestrator mode ----
	pi.on("before_agent_start", (event, ctx) => {
		// Treat an explicitly appended orchestrator prompt (CLI
		// --append-system-prompt) as orchestrator mode too.
		const alreadyOrchestrating = event.systemPrompt.includes(ORCHESTRATOR_PROMPT_MARKER);
		if (isOrchestratorMode(ctx) || alreadyOrchestrating) {
			if (alreadyOrchestrating) return;
			const prompt = readOrchestratorPrompt();
			if (!prompt) return;
			return { systemPrompt: event.systemPrompt + "\n\n" + prompt };
		}
		return { systemPrompt: event.systemPrompt + "\n\n" + SUBAGENT_USAGE_GUARD };
	});

	// ---- subagent tool ----
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a task to a subagent (isolated context, separate process).",
			"agent: subagent name (defined in the agents directory, e.g. planner/reviewer/actor); task: task description; cwd: optional;",
			"async=true: run in background, return a runId immediately, inject the result into the conversation when done (non-blocking);",
			"async=false (default): wait synchronously for the result.",
			`timeoutSeconds: optional; omit unless the user explicitly requested a time. Default ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}s (6 hours), range ${MIN_SUBAGENT_TIMEOUT_SECONDS}-${MAX_SUBAGENT_TIMEOUT_SECONDS};`,
			"While running, a subagent may send_message (to=main) to reach you, or contact other subagents — reply promptly with reply_message.",
		].join(" "),
		parameters: Type.Object({
			agent: Type.String({ description: "Subagent name" }),
			task: Type.String({ description: "Task description for the subagent" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
			async: Type.Optional(Type.Boolean({ description: "true=run in background without blocking (default false)" })),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					minimum: MIN_SUBAGENT_TIMEOUT_SECONDS,
					maximum: MAX_SUBAGENT_TIMEOUT_SECONDS,
					description: `Task timeout in seconds. Omit unless the user explicitly requested a time; default ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}s (6 hours).`,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agents = discoverAgents(ctx.cwd);
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.agent}". Available: ${available}` }],
				};
			}
			const timeoutSeconds = Math.min(
				MAX_SUBAGENT_TIMEOUT_SECONDS,
				Math.max(MIN_SUBAGENT_TIMEOUT_SECONDS, params.timeoutSeconds ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS),
			);
			const timeoutMs = timeoutSeconds * 1000;

			if (params.async) {
				try {
					const runId = launchBackground(agent, params.task, params.cwd, timeoutMs);
					return {
						content: [
							{
								type: "text",
								text: `Started background subagent ${params.agent} (run ${runId.slice(0, 8)}). The main session can keep doing other things; the result will be injected when done.`,
							},
						],
						details: { mode: "async", runId },
					};
				} catch (e) {
					return {
						content: [{ type: "text", text: `Failed to start background subagent: ${e instanceof Error ? e.message : String(e)}` }],
					};
				}
			}

			onUpdate?.({ content: [{ type: "text", text: `Starting ${params.agent} subagent...` }] });
			const runId = randomUUID();
			runningWidget.start(runId, agent.name, params.task, "task");
			const result = await spawnInteractiveSubagent({
				agent,
				task: params.task,
				cwd: params.cwd,
				messageRoot,
				runId,
				childIndex: 0,
				signal,
				timeoutMs,
				onSession: (session) => registerSessionHandle(runId, session),
			}).finally(() => {
				if (pendingOpenActivityId === runId) pendingOpenActivityId = undefined;
				sessionHandles.delete(runId);
				runningWidget.finish(runId);
			});
			const output = getFinalOutput(result.messages);

			if (result.exitCode !== 0) {
				return {
					content: [{ type: "text", text: `Subagent ${params.agent} failed (exit ${result.exitCode}): ${result.stderr || result.errorMessage || "unknown error"}` }],
					details: { result },
				};
			}
			if (result.stopReason === "error") {
				return {
					content: [{ type: "text", text: `Subagent ${params.agent} errored: ${result.errorMessage || "unknown error"}` }],
					details: { result },
				};
			}
			return {
				content: [{ type: "text", text: output || `(subagent ${params.agent} produced no text output)` }],
				details: { result },
			};
		},
	});

	// ---- commands ----
	pi.registerCommand("orchestrate", {
		description: "Turn multi-agent orchestration mode on/off (on|off|status, default on)",
		handler: async (args, ctx) => {
			const first = Array.isArray(args) ? (args[0] ?? "on") : String(args ?? "on").trim().split(/\s+/)[0] ?? "on";
			const arg = String(first).toLowerCase();

			if (arg === "status") {
				const on = isOrchestratorMode(ctx);
				ctx.ui.notify(
					on
						? "Orchestrator mode: ON (runs as orchestrator each turn; use /orchestrate off to disable)"
						: "Orchestrator mode: OFF (use /orchestrate on to enable)",
					"info",
				);
				return;
			}

			const enabled = arg !== "off";
			try {
				pi.appendEntry(ORCHESTRATOR_MODE_ENTRY, { enabled });
			} catch {
				/* ignore */
			}
			ctx.ui.notify(
				enabled
					? "Orchestrator mode enabled — every turn will run as the orchestrator (triage + orchestrate subagents)"
					: "Orchestrator mode disabled",
				"info",
			);
		},
	});

	pi.registerCommand("subagents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const agents = discoverAgents(ctx.cwd);
			const lines = agents.map(
				(a) =>
					`- ${a.name}: ${a.description}${a.model ? ` (${a.model})` : ""}${a.thinking ? ` [thinking: ${a.thinking}]` : ""}${a.tools ? ` [tools: ${a.tools.join(",")}]` : ""}`,
			);
			ctx.ui.notify(lines.length ? `Available subagents:\n${lines.join("\n")}` : "No subagents found", "info");
		},
	});

	pi.registerCommand("subagent-config", {
		description: "Configure a subagent (model / thinking) via interactive menu",
		handler: async (_args, ctx) => {
			const agents = discoverAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify("No subagents found", "info");
				return;
			}
			const agentName = await ctx.ui.select("Select subagent:", agents.map((a) => a.name));
			if (!agentName) return;
			const field = await ctx.ui.select(`Configure ${agentName}:`, ["model", "thinking"]);
			if (!field) return;

			if (field === "thinking") {
				const level = await ctx.ui.select(
					`Thinking level for ${agentName}:`,
					["off", "minimal", "low", "medium", "high", "xhigh", "max"],
				);
				if (!level) return;
				if (!updateAgentConfig(agentName, "thinking", level)) {
					ctx.ui.notify(`No built-in agent named "${agentName}"`, "warning");
					return;
				}
				ctx.ui.notify(`Subagent ${agentName}: thinking -> ${level}`, "info");
			} else {
				const choices = availableModelIds(ctx);
				if (choices.length === 0) {
					ctx.ui.notify("No models available", "warning");
					return;
				}
				const model = await ctx.ui.select(`Model for ${agentName}:`, choices);
				if (!model) return;
				if (!updateAgentConfig(agentName, "model", model)) {
					ctx.ui.notify(`No built-in agent named "${agentName}"`, "warning");
					return;
				}
				ctx.ui.notify(`Subagent ${agentName}: model -> ${model}`, "info");
			}
		},
	});

	pi.registerCommand("subagent-status", {
		description: "Show background subagent tasks and resident processes",
		handler: async (_args, ctx) => {
			const list = [...tasks.values()];
			const lines = list.map((t) => {
				const age = Math.round((Date.now() - t.startedAt) / 1000);
				return `- run ${t.runId.slice(0, 8)} ${t.agent} ${t.status} (${age}s ago)`;
			});
			const alive = [...poolAliveNames(pool)];
			ctx.ui.notify(
				[
					lines.length ? `Background tasks:\n${lines.join("\n")}` : "Background tasks: none",
					`Resident processes: ${alive.length ? alive.join(", ") : "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

function* poolAliveNames(pool: SubagentPool): Generator<string> {
	for (const n of ["planner", "reviewer", "actor"]) {
		if (pool.isAlive(n)) yield n;
	}
}
