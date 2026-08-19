/**
 * channel.ts — subagent approval forwarding over the existing master↔subagent
 * message channel.
 *
 * The subagents extension shares a message root (`/tmp/pi-subagents-messages/
 * <sessionId>`). This module reuses that root with its own
 * `permission-control/` namespace so the subagents router never picks these
 * files up, while staying on the same channel a subagent already lives on.
 *
 * Child (headless subagent) side:
 *   - hits an `ask`, has no TUI → writes a request file, polls for the reply.
 *   - supports per-request timeout and abort; concurrent asks are serialized.
 *
 * Main side:
 *   - polls the namespace, prompts the user (via an injected callback), writes
 *     the reply back to the waiting subagent.
 */

import { mkdir, readdir, readFile, rm, unlink, writeFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GrantScope } from "./approvals.ts";

export const ENV_ROLE = "PI_SUBAGENT_ROLE";
export const ENV_CHANNEL_ROOT = "PI_SUBAGENT_CHANNEL_ROOT";
export const ENV_AGENT = "PI_SUBAGENT_AGENT";

const BASE = "/tmp/pi-subagents-messages";
const NS = "permission-control";
const REQUEST_DIR = "requests";
const REPLY_DIR = "replies";
const POLL_MS = 300;
const REPLY_POLL_MS = 250;

export interface ApprovalRequestFile {
	type: "permission-control.approval.request";
	id: string;
	agent: string;
	tool: string;
	capability: string;
	resource: string;
	command?: string;
	justification?: string;
	reason?: string;
	risk?: string;
	createdAt: number;
	expiresAt?: number;
}

export interface ApprovalReplyFile {
	type: "permission-control.approval.reply";
	id: string;
	allowed: boolean;
	scope?: GrantScope;
	pathPrefix?: string;
	commandPrefix?: string;
	capability?: string;
	domain?: string;
	reason?: string;
	timestamp: number;
}

export function isChildProcess(): boolean {
	return process.env[ENV_ROLE] === "child";
}

export function childMeta(): { root: string; agent: string } | undefined {
	const root = process.env[ENV_CHANNEL_ROOT]?.trim();
	const agent = process.env[ENV_AGENT]?.trim() || "subagent";
	if (!root) return undefined;
	return { root, agent };
}

export function mainRoot(sessionId: string): string {
	return `${BASE}/${sessionId.replace(/[^\w.-]+/g, "_")}`;
}

function safe(id: string): string {
	return id.replace(/[^\w.-]+/g, "_");
}

function requestPath(root: string, id: string): string {
	return join(root, NS, REQUEST_DIR, `${safe(id)}.json`);
}
function replyPath(root: string, id: string): string {
	return join(root, NS, REPLY_DIR, `${safe(id)}.json`);
}

async function writeAtomic(filePath: string, data: string): Promise<void> {
	await mkdir(join(filePath, ".."), { recursive: true });
	await writeFile(filePath, data, { encoding: "utf-8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Child side: send an approval request, wait for the main reply
// ---------------------------------------------------------------------------

export interface ForwardOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ForwardResult {
	allowed: boolean;
	scope?: GrantScope;
	pathPrefix?: string;
	commandPrefix?: string;
	capability?: string;
	domain?: string;
	reason?: string;
	timedOut?: boolean;
}

export async function requestApprovalFromMain(
	meta: { root: string; agent: string },
	req: {
		tool: string;
		capability: string;
		resource: string;
		command?: string;
		justification?: string;
		reason?: string;
		risk?: string;
	},
	opts: ForwardOptions = {},
): Promise<ForwardResult> {
	const id = randomUUID();
	const now = Date.now();
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const request: ApprovalRequestFile = {
		type: "permission-control.approval.request",
		id,
		agent: meta.agent,
		tool: req.tool,
		capability: req.capability,
		resource: req.resource,
		command: req.command,
		justification: req.justification,
		reason: req.reason,
		risk: req.risk,
		createdAt: now,
		expiresAt: now + timeoutMs + 30_000,
	};
	await writeAtomic(requestPath(meta.root, id), JSON.stringify(request, null, 2));

	const deadline = now + timeoutMs;
	try {
		return await waitForReply(meta.root, id, deadline, opts.signal);
	} catch (error) {
		if (error instanceof ForwardTimeout) {
			return { allowed: false, reason: "approval request timed out", timedOut: true };
		}
		return { allowed: false, reason: "approval request cancelled" };
	} finally {
		// clean up the request file if it was never consumed
		try {
			await unlink(requestPath(meta.root, id));
		} catch {
			/* already removed by main */
		}
	}
}

class ForwardTimeout extends Error {}

function waitForReply(
	root: string,
	id: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<ForwardResult> {
	return new Promise((resolve, reject) => {
		const file = replyPath(root, id);
		const tick = () => {
			if (signal?.aborted) {
				reject(new Error("cancelled"));
				return;
			}
			if (Date.now() > deadline) {
				reject(new ForwardTimeout());
				return;
			}
			try {
				if (existsSync(file)) {
					const parsed = JSON.parse(readFileSync(file, "utf-8")) as ApprovalReplyFile;
					if (parsed.type === "permission-control.approval.reply" && parsed.id === id) {
						try {
							unlink(file);
						} catch {
							/* ignore */
						}
						resolve({
							allowed: parsed.allowed,
							scope: parsed.scope,
							pathPrefix: parsed.pathPrefix,
							commandPrefix: parsed.commandPrefix,
							capability: parsed.capability,
							domain: parsed.domain,
							reason: parsed.reason,
						});
						return;
					}
				}
			} catch {
				/* transient read error */
			}
			setTimeout(tick, REPLY_POLL_MS);
		};
		tick();
	});
}

// ---------------------------------------------------------------------------
// Main side: poll for child approval requests, call a handler, write replies
// ---------------------------------------------------------------------------

export interface ApprovalServer {
	dispose(): void;
}

export async function startApprovalServer(
	root: string,
	handler: (req: ApprovalRequestFile, done: (reply: ApprovalReplyFile) => void) => void,
): Promise<ApprovalServer> {
	const reqDir = join(root, NS, REQUEST_DIR);
	let running = true;
	let poller: ReturnType<typeof setInterval> | undefined;
	const inFlight = new Set<string>();

	const handleOne = async (file: string) => {
		let req: ApprovalRequestFile | undefined;
		try {
			req = JSON.parse(await readFile(file, "utf-8")) as ApprovalRequestFile;
		} catch {
			try {
				await unlink(file);
			} catch {
				/* ignore */
			}
			return;
		}
		if (req?.type !== "permission-control.approval.request" || !req.id) {
			try {
				await unlink(file);
			} catch {
				/* ignore */
			}
			return;
		}
		if (req.expiresAt !== undefined && req.expiresAt < Date.now()) {
			try {
				await unlink(file);
			} catch {
				/* ignore */
			}
			return;
		}
		if (inFlight.has(req.id)) return;
		inFlight.add(req.id);
		try {
			await new Promise<void>((resolve) => {
				handler(req!, (reply) => {
					void (async () => {
						await writeAtomic(replyPath(root, req!.id), JSON.stringify(reply, null, 2));
						try {
							await unlink(file);
						} catch {
							/* ignore */
						}
						resolve();
					})();
				});
			});
		} catch {
			// handler threw; fail-closed: reply deny
			try {
				const reply: ApprovalReplyFile = {
					type: "permission-control.approval.reply",
					id: req.id,
					allowed: false,
					reason: "main handler failed (fail-closed)",
					timestamp: Date.now(),
				};
				await writeAtomic(replyPath(root, req.id), JSON.stringify(reply, null, 2));
				await unlink(file);
			} catch {
				/* ignore */
			}
		} finally {
			inFlight.delete(req.id);
		}
	};

	const poll = async () => {
		if (!running) return;
		try {
			if (!existsSync(reqDir)) return;
			const entries = await readdir(reqDir);
			const files = entries.filter((f) => f.endsWith(".json")).sort();
			for (const f of files) {
				if (!running) return;
				const full = join(reqDir, f);
				try {
					const st = await stat(full);
					// skip files still being written
					if (st.size === 0) continue;
				} catch {
					continue;
				}
				await handleOne(full);
			}
		} catch {
			/* ignore transient errors */
		}
	};

	await poll();
	poller = setInterval(() => void poll(), POLL_MS);
	poller.unref?.();

	return {
		dispose: () => {
			running = false;
			if (poller) clearInterval(poller);
			poller = undefined;
		},
	};
}

/** Clean up stale approval files (called on session shutdown). */
export async function cleanupChannel(root: string): Promise<void> {
	try {
		await rm(join(root, NS), { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}
