/**
 * audit.ts — transparent audit log for permission decisions.
 *
 * Every allow/ask/deny is appended as a JSONL record to the audit file
 * (default ~/.pi/agent/permission-control-audit.jsonl). The file keeps full
 * non-secret detail. Anything that reaches the *chat transcript* goes through
 * `redactForChat()` so internal tokens, request IDs, and routing info never
 * show up in normal conversation.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PermissionControlConfig } from "./config.ts";

/** Opaque correlation id used only inside the audit file / prompt, never in chat. */
export type AuditId = string;

let counter = 0;

export function nextAuditId(): AuditId {
	counter += 1;
	return `a${Date.now().toString(36)}${counter.toString(36)}`;
}

const TOKEN_RE = /\b(?:sk|api|ghp|gho|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g;
const ID_RE = /\b(?:req|msg|tool|run)[-_](?:[a-z0-9]{8,})/gi;

/**
 * Redact secrets / ids / route info from text before it is shown to the user
 * in the normal chat transcript. Keeps the readable essence.
 */
export function redactForChat(text: string): string {
	if (typeof text !== "string") return String(text ?? "");
	let out = text.replace(TOKEN_RE, "[redacted]");
	out = out.replace(ID_RE, "[id]");
	// strip query strings / tokens from URLs
	out = out.replace(/(\?|&)(api[_-]?key|token|key|auth)=[^&\s]+/gi, "$1$2=[redacted]");
	// strip request-id-ish headers
	out = out.replace(/\b(x-request-id|request-id|trace-id|correlation-id)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
	return out;
}

export interface AuditRecord {
	ts: number;
	auditId: AuditId;
	agent: string;
	tool: string;
	capability: string;
	resource: string;
	verdict: "allow" | "ask" | "deny";
	reason?: string;
	risk?: string;
	grantScope?: string;
	command?: string;
	path?: string;
	route?: string; // main | child:<agent>
	detail?: Record<string, unknown>;
}

export class AuditLog {
	private readonly getConfig: () => PermissionControlConfig;

	constructor(config: () => PermissionControlConfig) {
		this.getConfig = config;
	}

	async record(entry: AuditRecord): Promise<void> {
		const cfg = this.getConfig();
		if (!cfg.audit.enabled) return;
		const file = cfg.audit.path ?? "";
		if (!file) return;
		try {
			await mkdir(dirname(file), { recursive: true });
			// Keep the audit file free of secrets; redact tokens even here.
			const safe: Record<string, unknown> = {
				...entry,
				command: entry.command ? redactForChat(entry.command) : undefined,
				resource: entry.resource ? redactForChat(entry.resource) : undefined,
			};
			await appendFile(file, JSON.stringify(safe) + "\n", "utf-8");
		} catch {
			// audit failures must never break tool execution
		}
	}
}

/** Human-readable one-line summary used for /perm-log. */
export function summarize(entry: AuditRecord): string {
	const when = new Date(entry.ts).toISOString().slice(11, 19);
	const verb = entry.verdict.toUpperCase().padEnd(5);
	const scope = entry.grantScope ? ` (${entry.grantScope})` : "";
	return `${when} ${verb} ${entry.capability} ${entry.resource}${scope}${entry.reason ? ` — ${entry.reason}` : ""}`;
}
