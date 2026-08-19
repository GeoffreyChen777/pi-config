import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Generic messaging system (no identity concept at the bottom layer)
//
// Two parties communicate: `main` (the main agent) and any subagent. Identity
// is defined entirely by each agent's prompt.
// Messages = file channel + polling:
//   send_message -> write <root>/<runId>/<agent>/<idx>/requests/<msgId>.json (to=target)
//   reply_message -> write <root>/<runId>/<fromAgent>/<idx>/replies/<msgId>.json
//   the waiting party polls replies/<msgId>.json
// Main-side routing: to === "main" -> inject into main session; otherwise
// forward to the target subagent's resident process.
// ============================================================================

// ---- env vars (injected when a subagent is spawned) ----
export const ENV_CHANNEL_ROOT = "PI_SUBAGENT_CHANNEL_ROOT";
export const ENV_RUN_ID = "PI_SUBAGENT_RUN_ID";
export const ENV_AGENT = "PI_SUBAGENT_AGENT";
export const ENV_CHILD_INDEX = "PI_SUBAGENT_CHILD_INDEX";
export const ENV_ROLE = "PI_SUBAGENT_ROLE";
export const ROLE_MAIN = "main";
export const ROLE_CHILD = "child";

/** Generic address of the main agent (no identity semantics, just "the main session") */
export const MAIN_AGENT = "main";

export const TOOL_SEND = "send_message";
export const TOOL_READ = "read_inbox";
export const TOOL_REPLY = "reply_message";

const REQUESTS_DIR = "requests";
const REPLIES_DIR = "replies";
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ROUTE_TIMEOUT_SECONDS = 6 * 60 * 60;
const MIN_ROUTE_TIMEOUT_SECONDS = 10;
const MAX_ROUTE_TIMEOUT_SECONDS = 3 * 24 * 60 * 60;
const CHANNEL_POLL_MS = 500;
const REPLY_POLL_MS = 250;

export interface MessageRequest {
	type: "pi.message.request";
	id: string;
	createdAt: number;
	from: string; // sender: main or a subagent name
	to: string; // target: main or a subagent name
	content: string;
	expectsReply: boolean;
	expiresAt?: number;
	timeoutMs?: number;
	requestFile: string;
	// sender's channel location (so a reply can be written back)
	fromRunId: string;
	fromAgent: string;
	fromChildIndex: number;
}

export interface MessageReply {
	type: "pi.message.reply";
	messageId: string;
	content: string;
	timestamp: number;
}

function safeSegment(value: string): string {
	return value.replace(/[^\w.-]+/g, "_");
}

/** Channel directory of one agent instance */
export function channelDir(root: string, runId: string, agent: string, childIndex: number): string {
	return path.join(root, safeSegment(runId), safeSegment(agent), String(childIndex));
}

function requestPath(dir: string, id: string): string {
	return path.join(dir, REQUESTS_DIR, `${safeSegment(id)}.json`);
}
function replyPath(dir: string, id: string): string {
	return path.join(dir, REPLIES_DIR, `${safeSegment(id)}.json`);
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomic(filePath: string, data: string): void {
	fs.writeFileSync(filePath, data, { encoding: "utf-8", mode: 0o600 });
}

// ============================================================================
// Message client (shared by subagents and the main agent)
// ============================================================================

interface ClientMeta {
	root: string;
	runId: string;
	agent: string;
	childIndex: number;
}

function readClientMeta(): ClientMeta | undefined {
	const root = process.env[ENV_CHANNEL_ROOT]?.trim();
	const runId = process.env[ENV_RUN_ID]?.trim();
	const agent = process.env[ENV_AGENT]?.trim();
	const rawIndex = process.env[ENV_CHILD_INDEX]?.trim();
	if (!root || !runId || !agent || rawIndex === undefined || !/^\d+$/.test(rawIndex)) return undefined;
	return { root, runId, agent, childIndex: Number(rawIndex) };
}

function waitForReply(dir: string, messageId: string, deadline: number, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const file = replyPath(dir, messageId);
		const tick = () => {
			if (signal?.aborted) {
				reject(new Error("Message wait cancelled."));
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error("Timed out waiting for reply."));
				return;
			}
			try {
				if (fs.existsSync(file)) {
					const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as MessageReply;
					if (parsed.type === "pi.message.reply" && parsed.messageId === messageId && typeof parsed.content === "string") {
						try {
							fs.unlinkSync(file);
						} catch {
							/* ignore cleanup failure */
						}
						resolve(parsed.content);
						return;
					}
				}
			} catch {
				/* ignore */
			}
			setTimeout(tick, REPLY_POLL_MS);
		};
		tick();
	});
}

/** Send a message to any target (main or subagent); wait=true blocks for a reply */
async function sendMessageInternal(
	to: string,
	content: string,
	wait: boolean,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ messageId: string; reply?: string }> {
	const meta = readClientMeta();
	if (!meta) throw new Error("Message channel is not available.");
	const dir = channelDir(meta.root, meta.runId, meta.agent, meta.childIndex);
	ensureDir(path.join(dir, REQUESTS_DIR));
	ensureDir(path.join(dir, REPLIES_DIR));

	const messageId = randomUUID();
	const now = Date.now();
	const deadline = now + (wait ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS);
	const request: MessageRequest = {
		type: "pi.message.request",
		id: messageId,
		createdAt: now,
		from: meta.agent,
		to,
		content,
		expectsReply: wait,
		...(wait ? { expiresAt: deadline } : {}),
		timeoutMs,
		requestFile: requestPath(dir, messageId),
		fromRunId: meta.runId,
		fromAgent: meta.agent,
		fromChildIndex: meta.childIndex,
	};
	const serialized = JSON.stringify(request, null, "\t");
	if (Buffer.byteLength(serialized, "utf-8") > MAX_MESSAGE_BYTES) throw new Error("Message is too large.");
	writeAtomic(requestPath(dir, messageId), serialized);

	if (!wait) return { messageId };
	try {
		const reply = await waitForReply(dir, messageId, deadline, signal);
		return { messageId, reply };
	} catch (e) {
		try {
			fs.unlinkSync(requestPath(dir, messageId));
		} catch {
			/* router may already have consumed it */
		}
		throw e;
	}
}

/** Reply to a message (locate the sender from the message, write the reply back) */
function replyToMessage(root: string, messageId: string, content: string): boolean {
	const request = findRequestInTree(root, messageId);
	if (!request) return false;
	const senderDir = channelDir(root, request.fromRunId, request.fromAgent, request.fromChildIndex);
	ensureDir(path.join(senderDir, REPLIES_DIR));
	const reply: MessageReply = { type: "pi.message.reply", messageId, content, timestamp: Date.now() };
	writeAtomic(replyPath(senderDir, messageId), JSON.stringify(reply, null, 2));
	// clean up the replied request
	if (request.requestFile) {
		try {
			fs.unlinkSync(request.requestFile);
		} catch {
			/* ignore */
		}
	}
	return true;
}

function findRequestInTree(root: string, messageId: string): MessageRequest | undefined {
	try {
		if (!fs.existsSync(root)) return undefined;
		for (const run of fs.readdirSync(root)) {
			const runDir = path.join(root, run);
			if (!fs.statSync(runDir).isDirectory()) continue;
			for (const agent of fs.readdirSync(runDir)) {
				const agentDir = path.join(runDir, agent);
				if (!fs.statSync(agentDir).isDirectory()) continue;
				for (const idx of fs.readdirSync(agentDir)) {
					const reqDir = path.join(agentDir, idx, REQUESTS_DIR);
					if (!fs.existsSync(reqDir)) continue;
					for (const f of fs.readdirSync(reqDir)) {
						if (f !== `${safeSegment(messageId)}.json`) continue;
						try {
							return JSON.parse(fs.readFileSync(path.join(reqDir, f), "utf-8")) as MessageRequest;
						} catch {
							/* ignore */
						}
					}
				}
			}
		}
	} catch {
		/* ignore */
	}
	return undefined;
}

/** Register the generic messaging tools for a child (subagent) */
export function registerChildMessaging(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_SEND,
		label: "Send Message",
		description: [
			"Send a message to any target: to='main' reaches the main agent, to=<agent name> reaches that subagent.",
			"wait=true (ask): block until the other party replies before continuing; wait=false (send): fire and forget.",
			"Use it to ask/confirm with the main agent or another subagent instead of leaving notes in normal output.",
		].join(" "),
		parameters: Type.Object({
			to: Type.String({ description: "Target: main or a subagent name" }),
			content: Type.String({ description: "Message content" }),
			wait: Type.Optional(
				Type.Boolean({ description: "true=wait for a reply (default true)" }),
			),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					minimum: MIN_ROUTE_TIMEOUT_SECONDS,
					maximum: MAX_ROUTE_TIMEOUT_SECONDS,
					description: `Reply timeout in seconds. Omit unless the user explicitly requested a time; default ${DEFAULT_ROUTE_TIMEOUT_SECONDS}s (6 hours).`,
				}),
			),
		}),
		execute: async (_id, params, signal) => {
			try {
				const timeoutMs =
					Math.min(
						MAX_ROUTE_TIMEOUT_SECONDS,
						Math.max(MIN_ROUTE_TIMEOUT_SECONDS, params.timeoutSeconds ?? DEFAULT_ROUTE_TIMEOUT_SECONDS),
					) * 1000;
				const { messageId, reply } = await sendMessageInternal(
					params.to,
					params.content,
					params.wait !== false,
					timeoutMs,
					signal,
				);
				if (reply !== undefined) {
					return {
						content: [{ type: "text", text: `Reply from ${params.to}:\n${reply}` }],
					};
				}
				return { content: [{ type: "text", text: `Sent message to ${params.to} (id ${messageId.slice(0, 8)})` }] };
			} catch (e) {
				return {
					content: [{ type: "text", text: `Failed to send message: ${e instanceof Error ? e.message : String(e)}` }],
				};
			}
		},
	});

	pi.registerTool({
		name: TOOL_READ,
		label: "Read Inbox",
		description: "Read messages that others sent you.",
		parameters: Type.Object({}),
		execute: async (_id) => {
			const meta = readClientMeta();
			if (!meta) return { content: [{ type: "text", text: "Message channel is not available." }] };
			const dir = channelDir(meta.root, meta.runId, meta.agent, meta.childIndex);
			const reqDir = path.join(dir, REQUESTS_DIR);
			if (!fs.existsSync(reqDir)) return { content: [{ type: "text", text: "Inbox is empty." }] };
			const files = fs.readdirSync(reqDir).filter((f) => f.endsWith(".json"));
			if (files.length === 0) return { content: [{ type: "text", text: "Inbox is empty." }] };
			const lines = files.map((f) => {
				try {
					const r = JSON.parse(fs.readFileSync(path.join(reqDir, f), "utf-8")) as MessageRequest;
					return `- [${r.id.slice(0, 8)}] from ${r.from}: ${r.content.slice(0, 150)}`;
				} catch {
					return "";
				}
			});
			return { content: [{ type: "text", text: `Inbox (requests from other agents):\n${lines.join("\n")}` }] };
		},
	});

	pi.registerTool({
		name: TOOL_REPLY,
		label: "Reply Message",
		description: "Reply to a received message (message_id comes from the received message).",
		parameters: Type.Object({
			message_id: Type.String({ description: "The message id to reply to" }),
			content: Type.String({ description: "Reply content" }),
		}),
		execute: async (_id, params) => {
			const meta = readClientMeta();
			if (!meta) return { content: [{ type: "text", text: "Message channel is not available." }] };
			if (!replyToMessage(meta.root, params.message_id, params.content)) {
				return { content: [{ type: "text", text: `Message not found: ${params.message_id.slice(0, 8)}` }] };
			}
			return { content: [{ type: "text", text: `Replied to ${params.message_id.slice(0, 8)}` }] };
		},
	});
}

// ============================================================================
// Main-agent side: message router (poller)
// ============================================================================

export interface MessageRouterState {
	root: string;
	/** when to === "main": inject into the main session */
	onMainMessage: (msg: MessageRequest) => void;
	/** when to === some subagent: route to its resident process */
	onChildMessage: (msg: MessageRequest, signal?: AbortSignal) => Promise<string> | string;
	matchesContext: (msg: MessageRequest) => boolean;
}

export interface MessageRouter {
	start: () => void;
	dispose: () => void;
}

/** Scan the channel tree for all pending message requests */
export function scanMessages(root: string): MessageRequest[] {
	const out: MessageRequest[] = [];
	try {
		if (!fs.existsSync(root)) return out;
		for (const run of fs.readdirSync(root)) {
			const runDir = path.join(root, run);
			if (!fs.statSync(runDir).isDirectory()) continue;
			for (const agent of fs.readdirSync(runDir)) {
				const agentDir = path.join(runDir, agent);
				if (!fs.statSync(agentDir).isDirectory()) continue;
				for (const idx of fs.readdirSync(agentDir)) {
					const reqDir = path.join(agentDir, idx, REQUESTS_DIR);
					if (!fs.existsSync(reqDir)) continue;
					for (const f of fs.readdirSync(reqDir)) {
						if (!f.endsWith(".json")) continue;
						try {
							const req = JSON.parse(fs.readFileSync(path.join(reqDir, f), "utf-8")) as MessageRequest;
							if (req.type === "pi.message.request" && req.id) {
								req.requestFile = path.join(reqDir, f);
								out.push(req);
							}
						} catch {
							/* ignore */
						}
					}
				}
			}
		}
	} catch {
		/* ignore */
	}
	return out;
}

export function writeReply(dir: string, messageId: string, content: string): void {
	ensureDir(path.join(dir, REPLIES_DIR));
	const reply: MessageReply = { type: "pi.message.reply", messageId, content, timestamp: Date.now() };
	writeAtomic(replyPath(dir, messageId), JSON.stringify(reply, null, 2));
}

export function removeRequestFile(msg: MessageRequest): void {
	try {
		if (msg.requestFile) fs.unlinkSync(msg.requestFile);
	} catch {
		/* ignore */
	}
}

/** Main agent creates a message router: poller scans, then splits main vs subagent */
export function createMessageRouter(pi: ExtensionAPI, state: MessageRouterState): MessageRouter {
	const seen = new Set<string>();
	let poller: ReturnType<typeof setInterval> | undefined;

	const poll = () => {
		for (const msg of scanMessages(state.root)) {
			if (seen.has(msg.id)) continue;
			if (msg.expiresAt !== undefined && msg.expiresAt < Date.now()) {
				removeRequestFile(msg);
				continue;
			}
			seen.add(msg.id);
			if (!state.matchesContext(msg)) continue;
			if (msg.to === MAIN_AGENT) {
				state.onMainMessage(msg);
			} else {
				void Promise.resolve(state.onChildMessage(msg)).catch(() => {
					/* routing errors are reported through the message reply path */
				});
			}
		}
	};

	return {
		start: () => {
			if (poller) return;
			registerMainReplyTool(pi, state);
			poll();
			poller = setInterval(poll, CHANNEL_POLL_MS);
			poller.unref?.();
		},
		dispose: () => {
			if (poller) clearInterval(poller);
			poller = undefined;
		},
	};
}

/** Main agent registers the generic messaging tools (send_message + reply_message) */
function registerMainReplyTool(pi: ExtensionAPI, state: MessageRouterState): void {
	// the main agent can also proactively message subagents
	pi.registerTool({
		name: TOOL_SEND,
		label: "Send Message",
		description: [
			"Send a message to a subagent: to=<agent name>. wait=true waits for its reply.",
			"The subagent processes the message and replies via reply_message.",
		].join(" "),
		parameters: Type.Object({
			to: Type.String({ description: "Subagent name" }),
			content: Type.String({ description: "Message content" }),
			wait: Type.Optional(Type.Boolean({ description: "true=wait for a reply (default true)" })),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					minimum: MIN_ROUTE_TIMEOUT_SECONDS,
					maximum: MAX_ROUTE_TIMEOUT_SECONDS,
					description: `Task timeout in seconds. Omit unless the user explicitly requested a time; default ${DEFAULT_ROUTE_TIMEOUT_SECONDS}s (6 hours).`,
				}),
			),
		}),
		execute: async (_id, params, signal) => {
			// the main agent has no child channel location; forward via the router
			const wait = params.wait !== false;
			const timeoutMs =
				Math.min(
					MAX_ROUTE_TIMEOUT_SECONDS,
					Math.max(MIN_ROUTE_TIMEOUT_SECONDS, params.timeoutSeconds ?? DEFAULT_ROUTE_TIMEOUT_SECONDS),
				) * 1000;
			const msg = findOrCreateProxyRequest(state.root, params.content, wait, timeoutMs);
			if (!msg) {
				return { content: [{ type: "text", text: "Message channel is not ready." }] };
			}
			const routed = { ...msg, to: params.to };
			if (!wait) {
				void Promise.resolve(state.onChildMessage(routed)).catch(() => {
					/* fire-and-forget failures cannot be returned to this completed tool call */
				});
				return { content: [{ type: "text", text: `Sent message to ${params.to}` }] };
			}
			try {
				const reply = await state.onChildMessage(routed, signal);
				return { content: [{ type: "text", text: `Reply from ${params.to}:\n${reply}` }] };
			} catch (e) {
				return {
					content: [{ type: "text", text: `Failed to message ${params.to}: ${e instanceof Error ? e.message : String(e)}` }],
				};
			}
		},
	});

	pi.registerTool({
		name: TOOL_REPLY,
		label: "Reply Message",
		description: [
			"Reply to a message from a subagent. message_id comes from the received message (like message_id=xxx).",
			"After receiving a subagent message, use this tool; the content is sent back to the waiting subagent.",
		].join(" "),
		parameters: Type.Object({
			message_id: Type.String({ description: "The message id to reply to" }),
			content: Type.String({ description: "Reply content" }),
		}),
		execute: async (_id, params) => {
			const msg = findRequestInTree(state.root, params.message_id);
			if (!msg) {
				return {
					content: [{ type: "text", text: `Message not found: ${params.message_id.slice(0, 8)} (may already be handled)` }],
				};
			}
			const dir = channelDir(state.root, msg.fromRunId, msg.fromAgent, msg.fromChildIndex);
			writeReply(dir, msg.id, params.content);
			removeRequestFile(msg);
			return { content: [{ type: "text", text: `Replied to ${msg.from}` }] };
		},
	});
}

/** Proxy request for the main agent sending to a subagent (placeholder; routing actually delivers it) */
function findOrCreateProxyRequest(
	root: string,
	content: string,
	expectsReply: boolean,
	timeoutMs: number,
): MessageRequest | undefined {
	if (!root) return undefined;
	return {
		type: "pi.message.request",
		id: randomUUID(),
		createdAt: Date.now(),
		from: MAIN_AGENT,
		to: "",
		content,
		expectsReply,
		timeoutMs,
		requestFile: "",
		fromRunId: "main",
		fromAgent: MAIN_AGENT,
		fromChildIndex: 0,
	};
}
