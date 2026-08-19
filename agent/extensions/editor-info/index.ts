import {
	CustomEditor,
	type ExtensionAPI,
	type ThemeColor,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const BORDER_COLOR: ThemeColor = "muted";
const FAST_MODE_REGISTRY_KEY = Symbol.for("@pi-plugins/statusline-registry");
const PLUGIN_STATUS_WIDGET_KEY = "pi-plugins:statusline";
const USER_MESSAGE_PROMPT_PATCH_KEY = Symbol.for("pi-editor-info:user-message-prompt-patch");
const MAX_SPEED_SAMPLES = 8;
const SPEED_REFRESH_INTERVAL_MS = 800;

type SpeedSample = { tokens: number; seconds: number };
type PluginStatusSegment = { text: string; align: "left" | "right" };
type UserMessagePromptPatch = {
	refs: number;
	originalRebuild: (this: any) => void;
	getTheme?: () => any;
};

type EditorInfo = {
	model: string;
	isGpt: boolean;
	fastMode: boolean;
	thinking: string;
	contextPercent: number | null;
	contextWindow: number | null;
	speed: number | null;
};

function formatModelName(id: string | undefined): string {
	if (!id) return "no-model";
	const base = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	return base.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) {
		const n = value / 1_000_000;
		return n >= 10 ? `${Math.round(n)}M` : `${n.toFixed(1)}M`;
	}
	if (value >= 1_000) {
		const n = value / 1_000;
		return n >= 10 ? `${Math.round(n)}K` : `${n.toFixed(1)}K`;
	}
	return String(Math.round(value));
}

function formatRate(rate: number): string {
	if (rate >= 1_000) {
		const value = rate / 1_000;
		return value >= 10 ? `${Math.round(value)}K` : `${value.toFixed(1)}K`;
	}
	return rate.toFixed(1);
}

function messageOutputTokens(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const record = message as Record<string, unknown>;
	const usage = record.usage;
	if (usage && typeof usage === "object") {
		const output = (usage as Record<string, unknown>).output;
		if (typeof output === "number" && Number.isFinite(output) && output > 0) return output;
	}
	const content = record.content;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const part = block as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") chars += part.text.length;
		else if (part.type === "thinking" && typeof part.thinking === "string") chars += part.thinking.length;
	}
	return Math.ceil(chars / 4);
}

function fastModeActive(): boolean {
	const registry = (globalThis as Record<PropertyKey, unknown>)[FAST_MODE_REGISTRY_KEY];
	if (!(registry instanceof Map)) return false;
	const segment = registry.get("fast-mode");
	return Boolean(segment && typeof segment === "object" && (segment as { text?: unknown }).text);
}

function pluginStatusSegmentsWithoutFastMode(): Array<[string, PluginStatusSegment]> {
	const registry = (globalThis as Record<PropertyKey, unknown>)[FAST_MODE_REGISTRY_KEY];
	if (!(registry instanceof Map)) return [];
	const segments: Array<[string, PluginStatusSegment]> = [];
	for (const [key, value] of registry.entries()) {
		if (key === "fast-mode" || !value || typeof value !== "object") continue;
		const segment = value as Partial<PluginStatusSegment>;
		if (
			typeof key === "string" &&
			typeof segment.text === "string" &&
			(segment.align === "left" || segment.align === "right")
		) {
			segments.push([key, segment as PluginStatusSegment]);
		}
	}
	return segments.sort(([a], [b]) => a.localeCompare(b));
}

function renderPluginStatuslineWithoutFastMode(width: number, theme: any): string[] {
	if (width <= 0) return [];
	const segments = pluginStatusSegmentsWithoutFastMode();
	if (segments.length === 0) return [];
	const left = segments
		.filter(([, segment]) => segment.align === "left")
		.map(([, segment]) => segment.text)
		.join(" · ");
	const right = segments
		.filter(([, segment]) => segment.align === "right")
		.map(([, segment]) => segment.text)
		.join(" · ");
	const margin = Math.min(1, width);
	const innerWidth = Math.max(0, width - margin);
	const gap = innerWidth - visibleWidth(left) - visibleWidth(right);
	const minimumGap = left && right ? 2 : 0;
	const content =
		right && gap >= minimumGap
			? `${left}${" ".repeat(gap)}${right}`
			: truncateToWidth([left, right].filter(Boolean).join(" · "), innerWidth, "");
	return [`${" ".repeat(margin)}${theme.fg("dim", content)}`];
}

class PromptedUserMessageContent implements Component {
	constructor(
		private readonly content: Component,
		private readonly patch: UserMessagePromptPatch,
	) {}

	render(width: number): string[] {
		const prefixWidth = 2;
		const lines = this.content.render(Math.max(1, width - prefixWidth));
		if (lines.length === 0) return lines;
		const theme = this.patch.getTheme?.();
		const prompt = theme ? theme.fg("accent", "❯") : "❯";
		return lines.map((line, index) => `${index === 0 ? `${prompt} ` : "  "}${line}`);
	}

	invalidate(): void {
		this.content.invalidate?.();
	}
}

function installUserMessagePrompt(): {
	setThemeProvider(provider: (() => any) | undefined): void;
	dispose(): void;
} {
	const prototype = UserMessageComponent.prototype as any;
	let patch = prototype[USER_MESSAGE_PROMPT_PATCH_KEY] as UserMessagePromptPatch | undefined;
	if (!patch) {
		const originalRebuild = prototype.rebuild as (this: any) => void;
		patch = { refs: 0, originalRebuild };
		const installedPatch = patch;
		prototype.rebuild = function (this: any): void {
			installedPatch.originalRebuild.call(this);
			const contentBox = this.children?.[0];
			const markdown = contentBox?.children?.[0] as Component | undefined;
			if (!markdown || markdown instanceof PromptedUserMessageContent) return;
			contentBox.clear();
			contentBox.addChild(new PromptedUserMessageContent(markdown, installedPatch));
		};
		prototype[USER_MESSAGE_PROMPT_PATCH_KEY] = patch;
	}
	patch.refs++;
	let disposed = false;
	return {
		setThemeProvider(provider) {
			if (!disposed) patch!.getTheme = provider;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			patch!.refs--;
			if (patch!.refs > 0) return;
			if (prototype[USER_MESSAGE_PROMPT_PATCH_KEY] === patch) {
				prototype.rebuild = patch!.originalRebuild;
				delete prototype[USER_MESSAGE_PROMPT_PATCH_KEY];
			}
		},
	};
}

function thinkingColor(level: string): ThemeColor {
	switch (level) {
		case "off":
			return "thinkingOff";
		case "minimal":
		case "min":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
		case "med":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "thinkingText";
	}
}

function contextColor(percent: number | null): ThemeColor {
	if (percent === null) return "muted";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function renderContextProgress(
	theme: any,
	percent: number | null,
	contextWindow: number | null,
	compact: boolean,
): string {
	const cells = compact ? 6 : 10;
	const boundedPercent = percent === null ? 0 : Math.max(0, Math.min(100, percent));
	const filledCells = percent === null ? 0 : Math.round((boundedPercent / 100) * cells);
	const bar =
		theme.fg(contextColor(percent), "▰".repeat(filledCells)) +
		theme.fg("muted", "▱".repeat(cells - filledCells));
	const percentage =
		percent === null ? "—%" : compact ? `${Math.round(boundedPercent)}%` : `${boundedPercent.toFixed(1)}%`;
	const total = contextWindow ? formatTokens(contextWindow) : "—";
	return `${bar} ${theme.fg(contextColor(percent), `${percentage}/${total}`)}`;
}

class TokenSpeedTracker {
	private samples: SpeedSample[] = [];
	private currentStartMs: number | null = null;
	private currentTokens = 0;
	private lastLiveRate: number | null = null;
	private lastRefreshMs = 0;

	reset(): void {
		this.samples = [];
		this.currentStartMs = null;
		this.currentTokens = 0;
		this.lastLiveRate = null;
		this.lastRefreshMs = 0;
	}

	begin(message: unknown): void {
		this.currentStartMs = performance.now();
		this.currentTokens = messageOutputTokens(message);
		this.lastLiveRate = null;
	}

	update(message: unknown, now = performance.now()): boolean {
		if (this.currentStartMs === null) return false;
		this.currentTokens = messageOutputTokens(message);
		const elapsed = Math.max(1, now - this.currentStartMs) / 1000;
		this.lastLiveRate = this.currentTokens / elapsed;
		if (now - this.lastRefreshMs < SPEED_REFRESH_INTERVAL_MS) return false;
		this.lastRefreshMs = now;
		return true;
	}

	finish(message: unknown, now = performance.now()): void {
		if (this.currentStartMs === null) return;
		const tokens = messageOutputTokens(message);
		const seconds = Math.max(1, now - this.currentStartMs) / 1000;
		if (tokens > 0 && seconds > 0) {
			this.samples.push({ tokens, seconds });
			if (this.samples.length > MAX_SPEED_SAMPLES) {
				this.samples.splice(0, this.samples.length - MAX_SPEED_SAMPLES);
			}
		}
		this.currentStartMs = null;
		this.currentTokens = 0;
		this.lastLiveRate = null;
	}

	rate(): number | null {
		if (this.currentStartMs !== null && this.lastLiveRate !== null && this.lastLiveRate > 0) {
			return this.lastLiveRate;
		}
		let tokens = 0;
		let seconds = 0;
		for (const sample of this.samples) {
			tokens += sample.tokens;
			seconds += sample.seconds;
		}
		return seconds > 0 ? tokens / seconds : null;
	}
}

function isHorizontalBorder(line: string): boolean {
	const plain = stripTerminalSequences(line);
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more /.test(plain);
}

function scrollLabel(line: string): string {
	const plain = stripTerminalSequences(line);
	const match = plain.match(/^─── ([↑↓]) (\d+) more /);
	return match ? `${match[1]} ${match[2]} more ` : "";
}

export class InfoEditor extends CustomEditor {
	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly uiTheme: any,
		private readonly getInfo: () => EditorInfo,
	) {
		super(tui, editorTheme, keybindings);
	}

	override setPaddingX(_padding: number): void {
		// The prompt marker owns the editor's left inset. Pi copies the default
		// editorPaddingX after constructing custom editors; accepting that value
		// would render "❯  text" instead of the requested single-space prefix.
		super.setPaddingX(0);
	}

	private renderInfo(info: EditorInfo, compact = false): string {
		const theme = this.uiTheme;
		const modelName = compact ? truncateToWidth(info.model, 12, "…") : info.model;
		const model =
			theme.fg("accent", modelName) +
			(info.isGpt && info.fastMode
				? theme.fg("success", " fast")
				: "");
		const thinking = theme.fg(thinkingColor(info.thinking), info.thinking);
		const context = renderContextProgress(
			theme,
			info.contextPercent,
			info.contextWindow,
			compact,
		);
		const speed = theme.fg(
			info.speed === null ? "muted" : "accent",
			info.speed === null
				? compact
					? "—t/s"
					: "— tok/s"
				: compact
					? `${formatRate(info.speed)}t/s`
					: `${formatRate(info.speed)} tok/s`,
		);
		return [model, thinking, context, speed].join(theme.fg("dim", compact ? "•" : " • "));
	}

	private topBorder(width: number, sourceLine: string): string {
		const border = (text: string) => this.uiTheme.fg(BORDER_COLOR, text);
		const left = scrollLabel(sourceLine);
		const available = Math.max(0, width - visibleWidth(left));
		const data = this.getInfo();
		let info = ` ${this.renderInfo(data)} `;
		if (visibleWidth(info) > available) info = ` ${this.renderInfo(data, true)} `;
		const fittedInfo = truncateToWidth(info, available, "");
		const fill = "─".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(fittedInfo)));
		return `${left ? border(left) : ""}${border(fill)}${fittedInfo}`;
	}

	private bottomBorder(width: number, sourceLine: string): string {
		const border = (text: string) => this.uiTheme.fg(BORDER_COLOR, text);
		const label = scrollLabel(sourceLine);
		return border(label + "─".repeat(Math.max(0, width - visibleWidth(label))));
	}

	render(width: number): string[] {
		if (width <= 2) return super.render(width);
		const bodyWidth = width - 2;
		const source = super.render(bodyWidth);
		if (source.length === 0) return source;

		let bottomIndex = -1;
		for (let index = source.length - 1; index >= 1; index--) {
			if (isHorizontalBorder(source[index]!)) {
				bottomIndex = index;
				break;
			}
		}

		const lines: string[] = [this.topBorder(width, source[0]!)];
		for (let index = 1; index < source.length; index++) {
			const line = source[index]!;
			if (index === bottomIndex) {
				lines.push(this.bottomBorder(width, line));
				continue;
			}
			const prefix =
				index === 1 ? `${this.uiTheme.fg("accent", "❯")} ` : "  ";
			lines.push(truncateToWidth(`${prefix}${line}`, width, ""));
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const speed = new TokenSpeedTracker();
	let userMessagePrompt: ReturnType<typeof installUserMessagePrompt> | undefined =
		installUserMessagePrompt();
	let requestRender: (() => void) | undefined;
	let restorePluginStatusWidget: (() => void) | undefined;

	const refresh = () => requestRender?.();

	pi.on("model_select", async () => {
		speed.reset();
		refresh();
	});

	pi.on("thinking_level_select", async () => refresh());
	pi.on("turn_end", async () => refresh());

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") speed.begin(event.message);
	});

	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && speed.update(event.message)) refresh();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") {
			speed.finish(event.message);
			refresh();
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		speed.reset();
		if (ctx.mode !== "tui") return;
		userMessagePrompt ??= installUserMessagePrompt();
		userMessagePrompt.setThemeProvider(() => ctx.ui.theme);
		const ui = ctx.ui as any;
		const originalSetWidget = ui.setWidget;
		const callOriginalSetWidget = originalSetWidget.bind(ui);
		const filteredSetWidget = (key: string, content: unknown, options?: unknown) => {
			if (key !== PLUGIN_STATUS_WIDGET_KEY) {
				callOriginalSetWidget(key, content, options);
				return;
			}
			const remaining = pluginStatusSegmentsWithoutFastMode();
			if (remaining.length === 0) {
				callOriginalSetWidget(key, undefined, options);
			} else {
				callOriginalSetWidget(
					key,
					(_tui: TUI, theme: any) => ({
						render: (width: number) => renderPluginStatuslineWithoutFastMode(width, theme),
						invalidate: () => {},
					}),
					options,
				);
			}
			requestRender?.();
		};
		ui.setWidget = filteredSetWidget;
		restorePluginStatusWidget = () => {
			if (ui.setWidget === filteredSetWidget) ui.setWidget = originalSetWidget;
		};
		filteredSetWidget(PLUGIN_STATUS_WIDGET_KEY, undefined);

		ctx.ui.setFooter(() => ({
			render: () => [],
			invalidate: () => {},
		}));
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			requestRender = () => tui.requestRender();
			return new InfoEditor(tui, editorTheme, keybindings, ctx.ui.theme, () => {
				const usage = ctx.getContextUsage();
				const modelId = ctx.model?.id;
				return {
					model: formatModelName(modelId),
					isGpt: Boolean(modelId && /gpt/i.test(modelId)),
					fastMode: fastModeActive(),
					thinking: String(ctx.thinkingLevel ?? "off"),
					contextPercent: usage?.percent ?? null,
					contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? null,
					speed: speed.rate(),
				};
			});
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		requestRender = undefined;
		speed.reset();
		restorePluginStatusWidget?.();
		restorePluginStatusWidget = undefined;
		userMessagePrompt?.setThemeProvider(undefined);
		userMessagePrompt?.dispose();
		userMessagePrompt = undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setFooter(undefined);
		}
	});
}
