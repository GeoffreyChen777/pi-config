import { UserMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
	Input,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	CompactExternalGroupComponent,
	getCompactMarkdownTheme,
	type CompactExternalGroup,
	type CompactExternalTool,
} from "../compact-mode/index.ts";
import type { SubagentSessionHandle } from "./session.ts";

// In fullscreen TUI mode (TuiAltScreen), the viewport input listener runs before the
// focused component and consumes these bindings to scroll the underlying transcript,
// so pageUp/pageDown/home/end never reach a focused overlay's handleInput. While the
// session overlay is open we temporarily clear them so the overlay can scroll itself,
// and restore the user's bindings when it closes.
const ALTSCREEN_SCROLL_BINDINGS = [
	"tui.altScreen.pageUp",
	"tui.altScreen.pageDown",
	"tui.altScreen.halfPageUp",
	"tui.altScreen.halfPageDown",
	"tui.altScreen.top",
	"tui.altScreen.bottom",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
];

type UserTranscriptItem = {
	kind: "user";
	text: string;
	component: UserMessageComponent;
};

type AssistantTranscriptItem = {
	kind: "assistant";
	text: string;
	streaming: boolean;
	component: Markdown;
};

type CompactTranscriptItem = {
	kind: "compact";
	state: CompactExternalGroup;
	component: CompactExternalGroupComponent;
};

type NoticeTranscriptItem = {
	kind: "notice";
	text: string;
	color: "dim" | "muted" | "error";
};

type TranscriptItem =
	| UserTranscriptItem
	| AssistantTranscriptItem
	| CompactTranscriptItem
	| NoticeTranscriptItem;

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) => (block?.type === "text" ? String(block.text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

function thinkingText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) =>
			block?.type === "thinking" ? String(block.thinking ?? block.text ?? "") : "",
		)
		.filter(Boolean)
		.join("\n");
}

function oneLine(value: unknown, max = 160): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolCallId(value: any): string {
	return String(value?.toolCallId ?? value?.id ?? "");
}

function toolCallName(value: any): string {
	return String(value?.toolName ?? value?.name ?? "unknown");
}

function toolCallArgs(value: any): any {
	return value?.args ?? value?.arguments ?? {};
}

function toolResultText(value: any): string {
	return contentText(value?.content ?? value)
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\r/g, "\n");
}

function estimateThinkingTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

class SubagentSessionComponent implements Component, Focusable {
	private readonly input = new Input();
	private readonly items: TranscriptItem[] = [];
	private readonly tools = new Map<string, CompactExternalTool>();
	private readonly toolGroups = new Map<string, CompactTranscriptItem>();
	private currentGroup: CompactTranscriptItem | undefined;
	private liveAssistant: AssistantTranscriptItem | undefined;
	private status = "connected";
	private closed = false;
	private _focused = false;
	private expanded = false;
	private scrollFromBottom = 0;
	private disposed = false;
	private readonly animationTimer: ReturnType<typeof setInterval>;
	private savedUserBindings: Record<string, unknown> | undefined;

	constructor(
		private readonly tui: any,
		private readonly theme: any,
		private readonly session: SubagentSessionHandle,
		messages: any[],
		private readonly done: () => void,
		private readonly unsubscribe: () => void,
		private readonly keybindings?: any,
	) {
		this.restoreHistory(messages);
		this.input.onSubmit = (value) => this.submit(value);
		this.animationTimer = setInterval(() => {
			if (!this.disposed) this.tui.requestRender();
		}, 300);
		this.animationTimer.unref?.();
		this.suspendAltScreenScroll();
	}

	/**
	 * While the overlay is focused, stop the fullscreen viewport from hijacking
	 * pageUp/pageDown/home/end so they reach this component's handleInput instead of
	 * scrolling the underlying main transcript.
	 */
	private suspendAltScreenScroll(): void {
		const kb = this.keybindings;
		if (!kb || typeof kb.getUserBindings !== "function" || typeof kb.setUserBindings !== "function") {
			return;
		}
		try {
			const saved = kb.getUserBindings();
			const next: Record<string, unknown> = { ...saved };
			for (const id of ALTSCREEN_SCROLL_BINDINGS) next[id] = [];
			kb.setUserBindings(next);
			this.savedUserBindings = saved;
		} catch {
			this.savedUserBindings = undefined;
		}
	}

	private restoreAltScreenScroll(): void {
		if (this.savedUserBindings === undefined) return;
		const saved = this.savedUserBindings;
		this.savedUserBindings = undefined;
		try {
			this.keybindings?.setUserBindings?.(saved);
		} catch {
			/* best-effort restore */
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private pushItem(item: TranscriptItem): void {
		this.items.push(item);
		if (this.items.length > 160) this.items.splice(0, this.items.length - 160);
	}

	private addUser(text: string): UserTranscriptItem | undefined {
		const value = text.trim();
		if (!value) return undefined;
		const previous = this.items.at(-1);
		if (previous?.kind === "user" && previous.text === value) return previous;
		const item: UserTranscriptItem = {
			kind: "user",
			text: value,
			component: new UserMessageComponent(value, getMarkdownTheme(), 1),
		};
		this.pushItem(item);
		this.liveAssistant = undefined;
		return item;
	}

	private addAssistant(text: string, streaming: boolean): AssistantTranscriptItem | undefined {
		const value = streaming ? text : text.trim();
		if (!value && !streaming) return undefined;
		this.sealCurrentGroup();
		const previous = this.items.at(-1);
		if (!streaming && previous?.kind === "assistant" && previous.text.trim() === value.trim()) {
			return previous;
		}
		const component = new Markdown(value, 1, 0, getCompactMarkdownTheme());
		const item: AssistantTranscriptItem = { kind: "assistant", text: value, streaming, component };
		this.pushItem(item);
		this.liveAssistant = streaming ? item : undefined;
		return item;
	}

	private updateAssistant(item: AssistantTranscriptItem, text: string, streaming: boolean): void {
		item.text = text;
		item.streaming = streaming;
		item.component.setText(text);
		item.component.invalidate();
	}

	private addNotice(text: string, color: NoticeTranscriptItem["color"] = "dim"): void {
		if (!text.trim()) return;
		this.pushItem({ kind: "notice", text, color });
	}

	private createGroup(): CompactTranscriptItem {
		const state: CompactExternalGroup = {
			tools: [],
			thinking: "",
			thinkingActive: false,
			sealed: false,
		};
		const item: CompactTranscriptItem = {
			kind: "compact",
			state,
			component: new CompactExternalGroupComponent(state, this.theme),
		};
		item.component.setExpanded(this.expanded);
		return item;
	}

	private ensureGroup(): CompactTranscriptItem {
		if (this.currentGroup && !this.currentGroup.state.sealed) return this.currentGroup;
		this.liveAssistant = undefined;
		const item = this.createGroup();
		this.pushItem(item);
		this.currentGroup = item;
		return item;
	}

	private sealCurrentGroup(): void {
		if (!this.currentGroup) return;
		this.currentGroup.state.sealed = true;
		this.currentGroup.state.thinkingActive = false;
		this.currentGroup = undefined;
	}

	private restoreHistory(messages: any[]): void {
		for (const message of messages) {
			const role = message?.role;
			if (role === "user") {
				this.addUser(contentText(message.content));
				continue;
			}
			if (role === "assistant") {
				for (const block of Array.isArray(message.content) ? message.content : []) {
					if (block?.type === "thinking") {
						const group = this.ensureGroup();
						group.state.thinking += String(block.thinking ?? block.text ?? "");
						group.state.thinkingTokens = estimateThinkingTokens(group.state.thinking);
						continue;
					}
					if (block?.type === "text" && String(block.text ?? "").trim()) {
						this.addAssistant(String(block.text), false);
						continue;
					}
					if (block?.type === "toolCall") {
						const group = this.ensureGroup();
						const id = toolCallId(block);
						if (!id || this.tools.has(id)) continue;
						const tool: CompactExternalTool = {
							id,
							name: toolCallName(block),
							args: toolCallArgs(block),
							status: "pending",
							resultText: "",
							startedAt: Number(message.timestamp) || Date.now(),
						};
						group.state.tools.push(tool);
						this.tools.set(id, tool);
						this.toolGroups.set(id, group);
					}
				}
				const reasoning = Number(message?.usage?.reasoning);
				const group = this.currentGroup;
				if (group?.state.thinking && Number.isFinite(reasoning) && reasoning > 0) {
					group.state.thinkingTokens = reasoning;
					group.state.thinkingTokensExact = true;
				}
				continue;
			}
			if (role === "toolResult") {
				const id = toolCallId(message);
				let tool = this.tools.get(id);
				if (!tool) {
					const group = this.ensureGroup();
					tool = {
						id: id || `history-tool-${this.tools.size}`,
						name: toolCallName(message),
						args: {},
						status: "pending",
						resultText: "",
						startedAt: Number(message.timestamp) || Date.now(),
					};
					group.state.tools.push(tool);
					this.tools.set(tool.id, tool);
					this.toolGroups.set(tool.id, group);
				}
				tool.status = message.isError ? "error" : "success";
				tool.resultText = toolResultText(message);
				tool.endedAt = Number(message.timestamp) || Date.now();
			}
		}
	}

	private handleAssistantEnd(message: any): void {
		const historicalThinking = thinkingText(message.content);
		let reasoningGroup: CompactTranscriptItem | undefined;
		if (historicalThinking) {
			const assistantIndex = this.liveAssistant
				? this.items.indexOf(this.liveAssistant)
				: this.items.length;
			const immediatelyBefore = this.items[assistantIndex - 1];
			if (immediatelyBefore?.kind === "compact") {
				reasoningGroup = immediatelyBefore;
			} else if (this.liveAssistant && assistantIndex >= 0) {
				reasoningGroup = this.createGroup();
				reasoningGroup.state.sealed = true;
				this.items.splice(assistantIndex, 0, reasoningGroup);
			} else {
				reasoningGroup = this.ensureGroup();
			}
			if (!reasoningGroup.state.thinking) {
				reasoningGroup.state.thinking = historicalThinking;
				reasoningGroup.state.thinkingTokens = estimateThinkingTokens(historicalThinking);
			}
		}
		const authoritative = contentText(message.content);
		if (this.liveAssistant) {
			this.updateAssistant(this.liveAssistant, authoritative || this.liveAssistant.text, false);
			this.liveAssistant = undefined;
		} else if (authoritative.trim()) {
			this.addAssistant(authoritative, false);
		}
		const reasoning = Number(message?.usage?.reasoning);
		if (reasoningGroup?.state.thinking && Number.isFinite(reasoning) && reasoning > 0) {
			reasoningGroup.state.thinkingTokens = reasoning;
			reasoningGroup.state.thinkingTokensExact = true;
		}
	}

	private handleEvent(event: any): void {
		if (event?.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update?.type === "text_delta") {
				if (!this.liveAssistant) this.addAssistant("", true);
				if (this.liveAssistant) {
					this.updateAssistant(
						this.liveAssistant,
						this.liveAssistant.text + String(update.delta ?? ""),
						true,
					);
				}
				this.status = "responding…";
			} else if (update?.type === "thinking_delta") {
				const group = this.ensureGroup();
				group.state.thinking += String(update.delta ?? "");
				group.state.thinkingActive = true;
				group.state.thinkingTokens = estimateThinkingTokens(group.state.thinking);
				group.state.thinkingTokensExact = false;
				this.status = "thinking…";
			}
		} else if (event?.type === "message_end" && event.message?.role === "assistant") {
			this.handleAssistantEnd(event.message);
		} else if (event?.type === "tool_execution_start") {
			const id = String(event.toolCallId ?? "");
			let tool = this.tools.get(id);
			if (!tool) {
				const group = this.ensureGroup();
				tool = {
					id,
					name: event.toolName || "unknown",
					args: event.args ?? {},
					status: "pending",
					resultText: "",
					startedAt: Date.now(),
				};
				group.state.tools.push(tool);
				this.tools.set(id, tool);
				this.toolGroups.set(id, group);
			} else {
				tool.status = "pending";
				tool.args = event.args ?? tool.args;
				const group = this.toolGroups.get(id);
				if (group && !group.state.sealed) this.currentGroup = group;
			}
			this.status = `${event.toolName || "tool"}…`;
		} else if (event?.type === "tool_execution_update") {
			const tool = this.tools.get(String(event.toolCallId ?? ""));
			if (tool) {
				tool.resultText = toolResultText(event.partialResult);
				tool.status = "pending";
			}
			this.status = `${event.toolName || "tool"}…`;
		} else if (event?.type === "tool_execution_end") {
			const tool = this.tools.get(String(event.toolCallId ?? ""));
			if (tool) {
				tool.resultText = toolResultText(event.result);
				tool.status = event.isError ? "error" : "success";
				tool.endedAt = Date.now();
			}
			this.status = event.isError ? `${event.toolName || "tool"} failed` : "working…";
		} else if (event?.type === "agent_start") {
			this.status = "working…";
		} else if (event?.type === "agent_end") {
			this.status = "finishing…";
		} else if (event?.type === "agent_settled") {
			this.sealCurrentGroup();
			this.status = "idle";
		} else if (event?.type === "session_closed") {
			this.sealCurrentGroup();
			this.status = "session ended";
			if (event.error) this.addNotice(`[session] ${event.error}`, "error");
		}
		this.tui.requestRender();
	}

	pushEvent(event: any): void {
		this.handleEvent(event);
	}

	private submit(value: string): void {
		const message = value.trim();
		if (!message) return;
		this.input.setValue("");
		this.addUser(message);
		this.status = "sending…";
		this.scrollFromBottom = 0;
		this.tui.requestRender();
		void this.session
			.send(message)
			.then(() => {
				this.status = "accepted";
				this.tui.requestRender();
			})
			.catch((error) => {
				this.status = "send failed";
				this.addNotice(`[error] ${error instanceof Error ? error.message : String(error)}`, "error");
				this.tui.requestRender();
			});
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.restoreAltScreenScroll();
		this.done();
	}

	private toggleExpanded(): void {
		this.expanded = !this.expanded;
		for (const item of this.items) {
			if (item.kind === "compact") item.component.setExpanded(this.expanded);
		}
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		if (matchesKey(data, "ctrl+x")) {
			this.status = "aborting…";
			void this.session.abort().catch((error) => {
				this.addNotice(`[abort error] ${error instanceof Error ? error.message : String(error)}`, "error");
			});
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			this.toggleExpanded();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollFromBottom += Math.max(5, Math.floor((this.tui.terminal?.rows ?? 30) * 0.7));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollFromBottom = Math.max(
				0,
				this.scrollFromBottom - Math.max(5, Math.floor((this.tui.terminal?.rows ?? 30) * 0.7)),
			);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollFromBottom = 0;
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private frameLine(content: string, innerWidth: number, border: (text: string) => string): string {
		const clipped = truncateToWidth(content, innerWidth, "…");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		return `${border("│")}${clipped}${padding}${border("│")}`;
	}

	private renderTranscript(width: number): string[] {
		const lines: string[] = [];
		for (const item of this.items) {
			if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
			if (item.kind === "user" || item.kind === "assistant" || item.kind === "compact") {
				lines.push(...item.component.render(width));
			} else {
				lines.push(this.theme.fg(item.color, item.text));
			}
		}
		return lines;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const terminalRows = Math.max(18, Number(this.tui.terminal?.rows) || 30);
		const targetHeight = Math.max(16, Math.min(terminalRows - 2, Math.floor(terminalRows * 0.85)));
		const fixedRows = 5;
		const transcriptHeight = Math.max(8, targetHeight - fixedRows);
		const transcript = this.renderTranscript(innerWidth);
		const maxScroll = Math.max(0, transcript.length - transcriptHeight);
		this.scrollFromBottom = Math.min(this.scrollFromBottom, maxScroll);
		const end = Math.max(0, transcript.length - this.scrollFromBottom);
		const start = Math.max(0, end - transcriptHeight);
		const visible = transcript.slice(start, end);
		const hiddenAbove = start;
		const hiddenBelow = transcript.length - end;
		const scrollLabel =
			hiddenAbove || hiddenBelow ? ` · ↑${hiddenAbove} ↓${hiddenBelow}` : "";
		const title = ` ${this.theme.bold(this.theme.fg("accent", this.session.agent))} session ${this.theme.fg("muted", `· ${this.status}${scrollLabel}`)} `;
		const titleWidth = visibleWidth(title);
		const titleRight = Math.max(0, innerWidth - titleWidth);
		const lines = [
			`${border("╭")}${title}${border(`${"─".repeat(titleRight)}╮`)}`,
		];
		for (const line of visible) lines.push(this.frameLine(line, innerWidth, border));
		while (lines.length < transcriptHeight + 1) lines.push(this.frameLine("", innerWidth, border));
		lines.push(`${border("├")}${border("─".repeat(innerWidth))}${border("┤")}`);
		const [inputLine = ""] = this.input.render(Math.max(1, innerWidth - 4));
		const inputContent = inputLine.startsWith("> ") ? inputLine.slice(2) : inputLine;
		lines.push(this.frameLine(` › ${inputContent}`, innerWidth, border));
		lines.push(
			this.frameLine(
				` ${this.theme.fg("dim", "Enter send · Esc main · Ctrl+X abort · Ctrl+O expand · PgUp/PgDn scroll")}`,
				innerWidth,
				border,
			),
		);
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {
		this.input.invalidate();
		for (const item of this.items) {
			if ("component" in item) item.component.invalidate();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.restoreAltScreenScroll();
		clearInterval(this.animationTimer);
		this.unsubscribe();
	}
}

export async function openSubagentSessionOverlay(ctx: any, session: SubagentSessionHandle): Promise<void> {
	const bufferedEvents: any[] = [];
	let component: SubagentSessionComponent | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (component) component.pushEvent(event);
		else bufferedEvents.push(event);
	});
	let messages: any[] = [];
	try {
		messages = await session.getMessages();
	} catch {
		/* a just-starting process may not have history yet */
	}
	try {
		await ctx.ui.custom<void>(
			(tui: any, theme: any, keybindings: any, done: () => void) => {
				component = new SubagentSessionComponent(
					tui,
					theme,
					session,
					messages,
					done,
					unsubscribe,
					keybindings,
				);
				for (const event of bufferedEvents.splice(0)) component.pushEvent(event);
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "96%",
					minWidth: 50,
					maxHeight: "85%",
					anchor: "center",
					margin: 0,
				},
			},
		);
	} catch (error) {
		if (!component) unsubscribe();
		throw error;
	}
}
