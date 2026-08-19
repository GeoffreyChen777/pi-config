/**
 * permission-control — Codex-style permission control for Pi.
 *
 * sandbox_mode = "workspace-write"
 * approval_policy = "on-request"
 *
 * Every operation is normalized to (agent, tool, capability, resource,
 * command) and decided to allow / ask / deny with precedence deny > ask >
 * allow. workspace-write auto-allows normal in-workspace read/write/edit/bash,
 * asks for out-of-workspace access / network / dangerous commands / sensitive
 * paths, and hard-denies ~/.ssh, keys, .env and Pi permission config files
 * (never overridable by approval).
 *
 * Modes: full-access (ignore permissions), ask (prompt flow), or
 * approve-for-me (configurable model auto-approves low risk, escalates high
 * risk to the user). Approval prompts support Allow once / session / path
 * prefix / project, Deny, Abort. TUI prompts are serialized through a FIFO
 * coordinator; headless/RPC fails closed; headless subagents forward asks to
 * the main session over the existing master↔subagent message channel.
 *
 * The `@landstrip/landstrip` OS sandbox backend is reused (not reimplemented)
 * to sandbox bash and to preflight file access. The main Pi process and this
 * host extension remain the trusted control plane.
 */

import { dirname } from "node:path";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	SelectList,
	Text,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { realpathSafe, resolveForPolicy, toAbsolute } from "./paths.ts";
import {
	defaultConfig,
	loadConfig,
	saveConfigUpdate,
	saveRules,
	type ApprovalPolicy,
	type PermissionControlConfig,
	type PermissionRules,
	type RiskLevel,
	type SandboxMode,
} from "./config.ts";
import {
	applyPolicyToAsk,
	decideBash,
	decideDomain,
	decidePath,
	findMatchingGrant,
	normalizeResource,
	type AccessRequest,
	type Capability,
	type Decision,
	type PolicyContext,
	type ResourceKind,
} from "./policy.ts";
import { PolicyContext as PolicyContextImpl } from "./policy.ts";
import {
	ApprovalCoordinator,
	GrantStore,
	type ApprovedGrant,
	type GrantScope,
} from "./approvals.ts";
import { AuditLog, nextAuditId, redactForChat, summarize, type AuditRecord } from "./audit.ts";
import {
	guardianAuthorizationBackstop,
	judgeAllowsSilently,
	runJudge,
} from "./judge.ts";
import {
	childMeta,
	cleanupChannel,
	startApprovalServer,
	type ApprovalReplyFile,
	type ApprovalServer,
	mainRoot,
	isChildProcess,
	requestApprovalFromMain,
} from "./channel.ts";
import {
	landstripStatus,
	preflightFileAccess,
	SessionPolicy,
	wrapBashWithLandstrip,
} from "./sandbox.ts";

const EXTENSION_LABEL = "permission-control";

interface ApprovalOutcome {
	allowed: boolean;
	grant?: ApprovedGrant;
	reason?: string;
	abort?: boolean;
}

interface ExtensionState {
	config: PermissionControlConfig;
	policy: PolicyContext | null;
	grants: GrantStore;
	audit: AuditLog;
	coordinator: ApprovalCoordinator;
	sessionPolicy: SessionPolicy | null;
	workspaceRoot: string;
	cwd: string;
	sessionId: string;
	root: string;
	approvalServer: ApprovalServer | null;
	onceByCall: Map<string, ApprovedGrant>;
	guardianDenials: number[];
	guardianConsecutiveDenials: number;
	recentGuardianDenials: Array<{
		id: string;
		req: AccessRequest;
		reason: string;
		risk: string;
		category: string;
		canUserAuthorize: boolean;
		createdAt: number;
	}>;
}

function makeState(): ExtensionState {
	const cfg = defaultConfig();
	return {
		config: cfg,
		policy: null,
		grants: new GrantStore(),
		audit: new AuditLog(() => cfg),
		coordinator: new ApprovalCoordinator(),
		sessionPolicy: null,
		workspaceRoot: "",
		cwd: process.cwd(),
		sessionId: "ephemeral",
		root: "",
		approvalServer: null,
		onceByCall: new Map(),
		guardianDenials: [],
		guardianConsecutiveDenials: 0,
		recentGuardianDenials: [],
	};
}

// ---------------------------------------------------------------------------
// Request normalization
// ---------------------------------------------------------------------------

function pathInputs(event: ToolCallEvent): string[] {
	const input = (event.input ?? {}) as Record<string, unknown>;
	const paths: string[] = [];
	for (const key of ["path", "file"]) {
		const v = input[key];
		if (typeof v === "string" && v) paths.push(v);
	}
	return paths;
}

async function normalizeToolRequest(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	st: ExtensionState,
): Promise<AccessRequest | null> {
	const tool = event.toolName;
	const agent = isChildProcess() ? (childMeta()?.agent ?? "subagent") : "main";

	if (tool === "bash") {
		const command = (event.input as { command?: string }).command ?? "";
		return {
			agent,
			tool,
			capability: "run_command",
			resource: { kind: "command", value: command.slice(0, 500) },
			command,
			isChild: isChildProcess(),
		};
	}

	let capability: Capability;
	let kind: ResourceKind;
	switch (tool) {
		case "read":
		case "grep":
		case "ls":
		case "find":
			capability = tool;
			kind = "path";
			break;
		case "write":
		case "edit":
		case "apply_patch":
			capability = tool;
			kind = "path";
			break;
		default:
			return null; // custom/unknown tools are not gated here
	}

	const raw = pathInputs(event)[0];
	if (!raw) {
		// grep/find/ls with no path default to the workspace (cwd).
		return {
			agent,
			tool,
			capability,
			resource: { kind: "scope", value: st.workspaceRoot || ctx.cwd },
			isChild: isChildProcess(),
		};
	}
	const abs = await resolveForPolicy(raw, ctx.cwd);
	return {
		agent,
		tool,
		capability,
		resource: { kind, value: raw, path: abs },
		isChild: isChildProcess(),
	};
}

// ---------------------------------------------------------------------------
// Evaluation + gate
// ---------------------------------------------------------------------------

async function evaluateRequest(req: AccessRequest, st: ExtensionState): Promise<Decision> {
	const policy = st.policy;
	if (!policy) return { verdict: "allow", risk: "low" };
	// Grants live in GrantStore because they are added and consumed throughout
	// the session. Keep the pure policy context pointed at the current snapshot
	// before every decision (including proactive request_approval calls).
	policy.grants = st.grants.all();

	if (req.capability === "run_command") {
		return decideBash(policy, req);
	}
	if (req.resource.kind === "path" && req.resource.path) {
		return decidePath(policy, req, req.resource.path);
	}
	if (req.capability === "network" || req.resource.kind === "domain") {
		const normalized = await normalizeResource("domain", req.resource.value, st.cwd);
		return decideDomain(policy, { ...req, resource: normalized });
	}
	return { verdict: "allow", risk: "low" };
}

const READ_CAPABILITIES = new Set(["read", "grep", "ls", "find"]);

async function auditRecord(
	st: ExtensionState,
	req: AccessRequest,
	verdict: AuditRecord["verdict"],
	extra?: Partial<AuditRecord>,
): Promise<void> {
	await st.audit.record({
		ts: Date.now(),
		auditId: nextAuditId(),
		agent: req.agent,
		tool: req.tool,
		capability: req.capability,
		resource: req.resource.value,
		verdict,
		route: isChildProcess() ? `child:${req.agent}` : "main",
		command: req.command,
		path: req.resource.path,
		...extra,
	});
}

type GateResult =
	| { action: "allow"; wrapped?: boolean }
	| {
			action: "block";
			reason: string;
			terminate?: boolean;
			status?: "authorization-required" | "denied" | "review-failed";
		};

async function runGate(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	st: ExtensionState,
	req: AccessRequest,
): Promise<GateResult> {
	if (!st.config.enabled) return { action: "allow" };
	const policy = st.policy;
	if (!policy) return { action: "allow" };

	// Deterministic authorization-sensitive requests must be stopped before
	// base policy evaluation. This prevents an incomplete command parser or a
	// broad pre-existing grant from turning a proactive approval request into
	// an immediate allow without Guardian seeing it.
	if (
		event.toolName === "request_approval" &&
		st.config.approvalPolicy === "approve-for-me"
	) {
		const backstop = guardianAuthorizationBackstop(req, ctx);
		if (backstop.requiresExplicitAuthorization) {
			const guardianReason =
				backstop.reason ??
				"The current user messages do not explicitly authorize this exact elevated action.";
			const reason = [
				`Guardian requires explicit user authorization: ${guardianReason.replace(/[.!?]+\s*$/, "")}.`,
				"Tell the user the exact action that needs elevated permission and why.",
				"Ask the user to explicitly reply that they allow that exact action.",
				"Do not retry, broaden the scope, or attempt a workaround until a new user message provides that authorization.",
			].join(" ");
			st.recentGuardianDenials.unshift({
				id: `${Date.now().toString(36)}-${event.toolCallId}`,
				req: { ...req, resource: { ...req.resource } },
				reason: guardianReason,
				risk: backstop.risk ?? "high",
				category: backstop.category ?? "ordinary",
				canUserAuthorize: true,
				createdAt: Date.now(),
			});
			st.recentGuardianDenials.splice(20);
			await auditRecord(st, req, "deny", {
				reason,
				risk: backstop.risk ?? "high",
				detail: {
					guardianVerdict: "ask_user",
					guardianCategory: backstop.category ?? "ordinary",
					guardianAuthorization: "none",
					authorizationBackstop: "pre-policy-v1",
				},
			});
			return {
				action: "block",
				reason,
				status: "authorization-required",
			};
		}
	}

	// Shared tail for every allowed request: Sandbox Policy preflight for file
	// tools, Landstrip bash wrapping, and audit. Kept identical across the
	// direct-allow and ask-approved paths so OS enforcement never diverges.
	const finalizeAllow = async (extra: Partial<AuditRecord> = {}): Promise<GateResult> => {
		// File tools: run the Sandbox Policy preflight (defense in depth).
		if (req.resource.kind === "path" && req.resource.path) {
			const isRead = READ_CAPABILITIES.has(req.capability) || req.capability === "read";
			const pf = preflightFileAccess(
				st.config,
				st.workspaceRoot,
				st.grants.all(),
				isRead ? "read" : "write",
				req.resource.path,
				{
					denyRead: policy.hardDenyRules.map((r) => r.absolute),
					denyWrite: policy.hardDenyRules.map((r) => r.absolute),
				},
			);
			if (!pf.allowed) {
				await auditRecord(st, req, "deny", { reason: `sandbox preflight: ${pf.reason}`, risk: "high" });
				return { action: "block", reason: pf.reason ?? "sandbox policy preflight failed" };
			}
		}

		// Bash: wrap with the landstrip OS sandbox when configured + available.
		let wrapped = false;
		let landstripError: string | undefined;
		if (
			req.capability === "run_command" &&
			event.toolName === "bash" &&
			st.config.sandbox.enabled
		) {
			const status = await landstripStatus();
			if (st.config.sandbox.requireLandstrip && !status.available) {
				await auditRecord(st, req, "deny", { reason: "landstrip backend required but unavailable", risk: "high" });
				return { action: "block", reason: "OS sandbox backend required but unavailable (fail-closed)" };
			}
			if (status.available && st.sessionPolicy) {
				const policyPath = await st.sessionPolicy.ensure(st.grants.all());
				const command = (event.input as { command?: string }).command ?? "";
				if (policyPath && !command.trim().startsWith(status.binaryPath ?? "\u0000")) {
					const wrapper = await wrapBashWithLandstrip(command, policyPath, status);
					if (wrapper) {
						(event.input as { command: string }).command = wrapper;
						wrapped = true;
					}
				}
			} else if (!status.available) {
				landstripError = status.error ?? "unavailable";
			}
		}

		await auditRecord(st, req, "allow", {
			risk: decision.risk,
			grantScope: decision.grant?.scope,
			detail: wrapped
				? { sandboxed: true }
				: landstripError
					? { sandboxed: false, reason: landstripError }
					: { sandboxed: false },
			...extra,
		});
		return { action: "allow", wrapped };
	};

	let decision = await evaluateRequest(req, st);

	// deny > ask > allow
	if (decision.verdict === "deny") {
		await auditRecord(st, req, "deny", { reason: decision.reason, risk: decision.risk });
		return { action: "block", reason: decision.reason ?? "denied" };
	}

	// A proactive request_approval call is itself an assertion that the
	// upcoming operation crosses a permission boundary. Command/path parsing
	// may not recognize every platform-specific privileged operation (for
	// example `sudo defaults write ...`), so never let a base-policy "allow"
	// bypass the configured reviewer. Existing grants are intentionally not
	// sufficient here: they belong to the eventual operation, not to a second
	// approval request.
	if (
		event.toolName === "request_approval" &&
		st.config.approvalPolicy === "approve-for-me" &&
		decision.verdict === "allow"
	) {
		decision = {
			verdict: "ask",
			risk: decision.risk === "low" ? "medium" : decision.risk,
			reason: "proactive elevated-permission request requires Guardian review",
		};
	}

	if (decision.verdict === "allow") {
		// A proactive request_approval reserves the grant for the operation
		// that follows; consuming it when the approval tool itself ends would
		// make "Allow once" unusable.
		if (decision.grant?.scope === "once" && event.toolName !== "request_approval") {
			st.onceByCall.set(event.toolCallId, decision.grant);
		}
		return finalizeAllow();
	}

	// ask
	const policyApplied = applyPolicyToAsk(policy, decision);
	if (policyApplied.verdict === "deny") {
		await auditRecord(st, req, "deny", { reason: policyApplied.reason, risk: policyApplied.risk });
		return { action: "block", reason: policyApplied.reason ?? "denied by approval policy" };
	}

	// approve-for-me: ask the model judge first
	if (st.config.approvalPolicy === "approve-for-me") {
		const backstop = guardianAuthorizationBackstop(req, ctx);
		const judge = backstop.requiresExplicitAuthorization
			? {
					approve: false,
					verdict: "ask_user" as const,
					risk: backstop.risk ?? "high",
					category: backstop.category ?? "ordinary",
					confidence: 1,
					reason: backstop.reason,
					userAuthorization: "none" as const,
				}
			: await runJudge(req, decision, ctx, st.config.approveForMe, ctx.signal);
		if (!judge.error && judgeAllowsSilently(judge, decision, st.config.approveForMe)) {
			st.guardianConsecutiveDenials = 0;
			if (event.toolName === "request_approval") {
				// The judge approved the proactive request, not the eventual
				// operation. Materialize a one-shot grant so the next matching
				// tool call can actually use that approval.
				await st.grants.add(grantForOutcome(req, "once", "exact"));
			}
			await auditRecord(st, req, "allow", {
				reason: `Guardian approved (${judge.reason ?? "n/a"})`,
				risk: judge.risk,
				detail: {
					guardianVerdict: judge.verdict,
					guardianRisk: judge.risk,
					guardianCategory: judge.category,
					guardianConfidence: judge.confidence,
					guardianUserAuthorization: judge.userAuthorization,
				},
			});
			return finalizeAllow({ reason: `Guardian approved (${judge.reason ?? "n/a"})`, risk: judge.risk });
		}
		const authorizationRequired = !judge.error && judge.verdict === "ask_user";
		const reviewerDenied =
			!judge.error &&
			judge.verdict === "deny";
		let circuitBreak = false;
		if (reviewerDenied) {
			st.guardianConsecutiveDenials += 1;
			st.guardianDenials.push(Date.now());
			if (st.guardianDenials.length > 50) st.guardianDenials.splice(0, st.guardianDenials.length - 50);
			circuitBreak =
				st.guardianConsecutiveDenials >= 3 ||
				st.guardianDenials.length >= 10;
		}
		await auditRecord(st, req, "ask", {
			reason: `Guardian ${judge.error ? `failed: ${judge.error}` : `${judge.verdict}: ${judge.reason ?? "no reason"}`}`,
			risk: judge.risk,
			detail: {
				guardianError: judge.error,
				guardianVerdict: judge.verdict,
				guardianRisk: judge.risk,
				guardianCategory: judge.category,
				guardianConfidence: judge.confidence,
				guardianReason: judge.reason,
				guardianUserAuthorization: judge.userAuthorization,
				guardianConsecutiveDenials: st.guardianConsecutiveDenials,
				guardianRecentDenials: st.guardianDenials.length,
				guardianCircuitBreak: circuitBreak,
			},
		});
		if (judge.error) {
			return {
				action: "block",
				reason: `Guardian review failed closed: ${judge.error}. The requested action was not executed.`,
				status: "review-failed",
			};
		}
		if (authorizationRequired || reviewerDenied) {
			const guardianReason = (judge.reason ?? "action violates automatic review policy").replace(/[.!?]+\s*$/, "");
			const canUserAuthorize = authorizationRequired;
			const reason = canUserAuthorize
				? [
						`Guardian requires explicit user authorization: ${guardianReason}.`,
						`Tell the user the exact action that needs elevated permission and why.`,
						`Ask the user to explicitly reply that they allow that exact action.`,
						`Do not retry, broaden the scope, or attempt a workaround until a new user message provides that authorization.`,
					].join(" ")
				: [
						`Guardian denied: ${guardianReason}.`,
						`This action cannot be approved merely by retrying or rephrasing it.`,
						`Do not attempt a workaround; use a materially safer alternative or ask the user to change the requested action.`,
					].join(" ");
			st.recentGuardianDenials.unshift({
				id: `${Date.now().toString(36)}-${event.toolCallId}`,
				req: { ...req, resource: { ...req.resource } },
				reason: guardianReason,
				risk: judge.risk,
				category: judge.category,
				canUserAuthorize,
				createdAt: Date.now(),
			});
			if (st.recentGuardianDenials.length > 20) st.recentGuardianDenials.length = 20;
			if (circuitBreak) {
				return {
					action: "block",
					reason: `${reason} Guardian rejection circuit breaker triggered.`,
					terminate: true,
					status: canUserAuthorize ? "authorization-required" : "denied",
				};
			}
			return {
				action: "block",
				reason,
				status: canUserAuthorize ? "authorization-required" : "denied",
			};
		}
	}

	const outcome = await resolveAsk(req, decision, ctx, st);
	if (outcome.allowed) {
		// The grant (if any) was already added to the store by resolveAsk.
		if (outcome.grant?.scope === "once" && event.toolName !== "request_approval") {
			st.onceByCall.set(event.toolCallId, outcome.grant);
		}
		return finalizeAllow({ reason: `approved (${outcome.grant?.scope ?? "n/a"})` });
	}
	await auditRecord(st, req, "deny", { reason: outcome.reason ?? "denied", risk: decision.risk });
	return { action: "block", reason: outcome.reason ?? "denied by user", terminate: outcome.abort };
}

// ---------------------------------------------------------------------------
// Ask resolution: user prompt / subagent forwarding / fail-closed
// ---------------------------------------------------------------------------

function grantForOutcome(
	req: AccessRequest,
	scope: GrantScope,
	action: "exact" | "prefix" | "domain",
): ApprovedGrant {
	const base = { scope, createdAt: Date.now() };
	if (action === "domain") return { ...base, capability: "network", domain: req.resource.value };
	if (action === "prefix") {
		if (req.capability === "run_command" && req.command) {
			const first = req.command.trim().split(/\s+/)[0] ?? req.command;
			return { ...base, commandPrefix: first };
		}
		if (req.resource.path) return { ...base, pathPrefix: dirname(req.resource.path) };
		return { ...base, capability: req.capability };
	}
	// exact
	if (req.capability === "run_command" && req.command) {
		return { ...base, commandPrefix: req.command.trim() };
	}
	if (req.resource.path) return { ...base, pathPrefix: req.resource.path };
	if (req.resource.kind === "domain") return { ...base, capability: "network", domain: req.resource.value };
	return { ...base, capability: req.capability };
}

const APPROVAL_DETAIL_MAX_LENGTH = 140;

function abbreviateApprovalDetail(value: string, maxLength = APPROVAL_DETAIL_MAX_LENGTH): string {
	const compact = redactForChat(value).replace(/\s+/g, " ").trim();
	const characters = [...compact];
	if (characters.length <= maxLength) return compact;
	return `${characters.slice(0, Math.max(0, maxLength - 3)).join("")}...`;
}

export function buildPromptTitle(req: AccessRequest, decision: Decision, isChild: boolean): string {
	const lines = [
		`Permission required · risk: ${decision.risk}${isChild ? " · from subagent" : ""}`,
		`  capability: ${req.capability}`,
	];
	// Bash requests use the command itself as the resource. Avoid displaying
	// the same potentially long value twice.
	if (!req.command || req.resource.value.trim() !== req.command.trim()) {
		lines.push(`  resource:   ${abbreviateApprovalDetail(req.resource.value)}`);
	}
	if (req.command) lines.push(`  command:    ${abbreviateApprovalDetail(req.command)}`);
	if (req.justification) lines.push(`  why:        ${abbreviateApprovalDetail(req.justification)}`);
	if (decision.reason) lines.push(`  policy:     ${abbreviateApprovalDetail(decision.reason)}`);
	return lines.join("\n");
}

function approvalOptions(req: AccessRequest): string[] {
	const opts = ["Allow once", "Allow for session"];
	if (req.capability === "network" || req.resource.kind === "domain") {
		opts.push("Allow this domain");
	} else if (req.capability === "run_command") {
		opts.push("Allow command prefix");
	} else {
		opts.push("Allow path/prefix");
	}
	opts.push("Allow for project", "Deny", "Abort");
	return opts;
}

function approvalOptionItems(req: AccessRequest): SelectItem[] {
	return approvalOptions(req).map((value) => {
		switch (value) {
			case "Allow once":
				return { value, label: value, description: "Approve only this operation" };
			case "Allow for session":
				return { value, label: value, description: "Approve this exact resource for the current session" };
			case "Allow this domain":
				return { value, label: value, description: "Approve this domain for the current session" };
			case "Allow command prefix":
				return { value, label: value, description: "Approve matching commands for the current session" };
			case "Allow path/prefix":
				return { value, label: value, description: "Approve this path prefix for the current session" };
			case "Allow for project":
				return { value, label: value, description: "Persist a broader rule in the project configuration" };
			case "Deny":
				return { value, label: value, description: "Block this operation and let the agent continue" };
			case "Abort":
				return { value, label: value, description: "Block this operation and terminate the current turn" };
			default:
				return { value, label: value };
		}
	});
}

async function promptStyledApproval(
	ctx: ExtensionContext,
	req: AccessRequest,
	decision: Decision,
	signal: AbortSignal,
): Promise<string | null> {
	if (signal.aborted) return null;

	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const riskColor = decision.risk === "high" ? "error" : decision.risk === "medium" ? "warning" : "success";
		const borderColor = (text: string) => theme.fg(riskColor, text);

		container.addChild(new DynamicBorder(borderColor));

		container.addChild(
			new Text(
				theme.fg(riskColor, theme.bold(`Permission required  |  ${decision.risk.toUpperCase()} RISK`)),
				1,
				0,
			),
		);

		const details: string[] = [
			`${theme.fg("muted", theme.bold("Capability"))}  ${theme.fg("text", req.capability)}`,
		];
		if (!req.command || req.resource.value.trim() !== req.command.trim()) {
			details.push(
				`${theme.fg("muted", theme.bold("Resource"))}    ${theme.fg("accent", abbreviateApprovalDetail(req.resource.value))}`,
			);
		}
		if (req.command) {
			details.push(
				`${theme.fg("muted", theme.bold("Command"))}     ${theme.fg("warning", abbreviateApprovalDetail(req.command))}`,
			);
		}
		if (req.justification) {
			details.push(
				`${theme.fg("muted", theme.bold("Reason"))}      ${theme.fg("text", abbreviateApprovalDetail(req.justification))}`,
			);
		}
		if (decision.reason) {
			details.push(
				`${theme.fg("muted", theme.bold("Policy"))}      ${theme.fg(riskColor, abbreviateApprovalDetail(decision.reason))}`,
			);
		}

		container.addChild(new Text(details.join("\n"), 1, 1));

		container.addChild(new Text(theme.fg("text", theme.bold("Choose an action")), 1, 0));

		const items = approvalOptionItems(req).map((item) => ({
			value: item.value,
			label: item.description
				? `${theme.bold(item.label)} ${theme.fg("dim", `· ${item.description}`)}`
				: theme.bold(item.label),
		}));
		const selectList = new SelectList(items, Math.min(items.length, 8), {
			selectedPrefix: (text) => theme.fg("accent", theme.bold(text)),
			selectedText: (text) => theme.fg("accent", theme.bold(text)),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		container.addChild(selectList);
		container.addChild(
			new Text(
				theme.fg("dim", "Up/Down navigate | Enter select | Esc cancel"),
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder(borderColor));

		let completed = false;
		const finish = (value: string | null): void => {
			if (completed) return;
			completed = true;
			signal.removeEventListener("abort", onAbort);
			done(value);
		};
		const onAbort = (): void => finish(null);
		signal.addEventListener("abort", onAbort, { once: true });

		selectList.onSelect = (item) => finish(item.value);
		selectList.onCancel = () => finish(null);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
			dispose: () => signal.removeEventListener("abort", onAbort),
		};
	});
}

async function promptUserApproval(
	ctx: ExtensionContext,
	req: AccessRequest,
	decision: Decision,
	signal: AbortSignal,
): Promise<ApprovalOutcome | null> {
	const choice =
		ctx.mode === "tui"
			? await promptStyledApproval(ctx, req, decision, signal)
			: await ctx.ui.select(
					buildPromptTitle(req, decision, false),
					approvalOptions(req),
					signal ? { signal } : undefined,
				);
	if (!choice) return null;
	switch (choice) {
		case "Allow once":
			return { allowed: true, grant: grantForOutcome(req, "once", "exact") };
		case "Allow for session":
			return { allowed: true, grant: grantForOutcome(req, "session", "exact") };
		case "Allow this domain":
			return { allowed: true, grant: grantForOutcome(req, "session", "domain") };
		case "Allow command prefix":
			return { allowed: true, grant: grantForOutcome(req, "session", "prefix") };
		case "Allow path/prefix":
			return { allowed: true, grant: grantForOutcome(req, "session", "prefix") };
		case "Allow for project":
			return { allowed: true, grant: grantForOutcome(req, "project", "prefix") };
		case "Deny":
			return { allowed: false, reason: "denied by user" };
		case "Abort":
			return { allowed: false, reason: "aborted by user", abort: true };
		default:
			return null;
	}
}

function grantFromForward(fwd: { allowed: boolean; scope?: GrantScope; pathPrefix?: string; commandPrefix?: string; capability?: string; domain?: string; reason?: string }): ApprovalOutcome {
	if (!fwd.allowed) return { allowed: false, reason: fwd.reason ?? "denied by main session" };
	const grant: ApprovedGrant = {
		scope: fwd.scope ?? "session",
		createdAt: Date.now(),
		...(fwd.pathPrefix ? { pathPrefix: fwd.pathPrefix } : {}),
		...(fwd.commandPrefix ? { commandPrefix: fwd.commandPrefix } : {}),
		...(fwd.capability ? { capability: fwd.capability } : {}),
		...(fwd.domain ? { domain: fwd.domain } : {}),
	};
	return { allowed: true, grant };
}

async function resolveAsk(
	req: AccessRequest,
	decision: Decision,
	ctx: ExtensionContext,
	st: ExtensionState,
): Promise<ApprovalOutcome> {
	// Headless subagent: forward to the main session over the message channel.
	if (isChildProcess()) {
		const meta = childMeta();
		if (!meta) return { allowed: false, reason: "no approval channel (fail-closed)" };
		const fwd = await requestApprovalFromMain(
			meta,
			{
				tool: req.tool,
				capability: req.capability,
				resource: req.resource.value,
				command: req.command,
				justification: req.justification,
				reason: decision.reason,
				risk: decision.risk,
			},
			{
				timeoutMs: st.config.subagentApprovalTimeoutMs,
				signal: ctx.signal,
			},
		);
		return grantFromForward(fwd);
	}

	// Main process: no UI → fail-closed.
	if (!ctx.hasUI) {
		return { allowed: false, reason: "no approval channel (fail-closed)" };
	}

	// TUI: serialize through the FIFO coordinator.
	return st.coordinator.resolve<ApprovalOutcome>(
		() => {
			const grant = findMatchingGrant(req, st.grants.all());
			return grant ? { allowed: true, grant } : undefined;
		},
		async (signal) => {
			const outcome = await promptUserApproval(ctx, req, decision, signal);
			if (!outcome) return { allowed: false, reason: decision.reason ?? "approval cancelled" };
			if (outcome.grant) await st.grants.add(outcome.grant);
			return outcome;
		},
		ctx.signal,
		st.config.promptTimeoutMs > 0 ? st.config.promptTimeoutMs : undefined,
	);
}

// ---------------------------------------------------------------------------
// Main extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const st = makeState();
	const isChild = isChildProcess();
	const env = process.env;

	// ---- session lifecycle ----
	pi.on("session_start", async (_event, ctx) => {
		st.guardianDenials.length = 0;
		st.guardianConsecutiveDenials = 0;
		st.recentGuardianDenials.length = 0;
		st.cwd = ctx.cwd;
		st.sessionId =
			ctx.sessionManager?.getSessionId?.() ?? (env.PI_SESSION_ID || "ephemeral");
		st.root = mainRoot(st.sessionId);

		const includeProject = ctx.isProjectTrusted?.() !== false;
		const loaded = await loadConfig(st.cwd, includeProject);
		st.config = loaded.config;
		st.workspaceRoot = await realpathSafe(
			st.config.workspaceRoot ? toAbsolute(st.config.workspaceRoot, st.cwd) : st.cwd,
		);
		st.policy = await PolicyContextImpl.create(st.config, st.cwd);

		// Grant store + project/global grants (loaded separately so each persists
		// to its own scope and is never clobbered by the other).
		st.grants = new GrantStore({
			persistProject: async (grants) => {
				await saveRules(st.cwd, rulesFromGrants(grants.filter((g) => g.scope === "project")), "project");
			},
			persistGlobal: async (grants) => {
				await saveRules(st.cwd, rulesFromGrants(grants.filter((g) => g.scope === "global")), "global");
			},
		});
		st.grants.setGlobalGrants(grantsFromRules(loaded.globalConfig?.rules, "global"));
		st.grants.setProjectGrants(grantsFromRules(loaded.projectConfig?.rules, "project"));
		st.policy.grants = st.grants.all();

		st.sessionPolicy = new SessionPolicy(st.config, st.workspaceRoot);
		st.audit = new AuditLog(() => st.config);

		// Main process: serve subagent approval requests.
		if (!isChild) {
			st.approvalServer?.dispose();
			st.approvalServer = await startApprovalServer(st.root, async (req, done) => {
				if (!ctx.hasUI) {
					done({ type: "permission-control.approval.reply", id: req.id, allowed: false, reason: "no UI for approval (fail-closed)", timestamp: Date.now() });
					return;
				}
				const decision: Decision = { verdict: "ask", risk: (req.risk as RiskLevel) || "medium", reason: req.reason };
				const accessReq: AccessRequest = {
					agent: req.agent,
					tool: req.tool,
					capability: req.capability,
					resource: { kind: req.capability === "network" ? "domain" : req.tool === "bash" ? "command" : "scope", value: req.resource },
					command: req.command,
					justification: req.justification,
					isChild: true,
				};
				if (accessReq.capability === "run_command" || accessReq.tool === "bash") {
					// realpath resolution for path-ish resources handled by evaluate on the child; here just prompt.
				}
				try {
					const outcome = await st.coordinator.resolve<ApprovalOutcome | null>(
						() => undefined,
						async (signal) => promptUserApproval(ctx, accessReq, decision, signal),
						undefined,
						st.config.promptTimeoutMs > 0 ? st.config.promptTimeoutMs : undefined,
					);
					const reply: ApprovalReplyFile = outcome?.allowed
						? {
								type: "permission-control.approval.reply",
								id: req.id,
								allowed: true,
								scope: outcome.grant?.scope,
								pathPrefix: outcome.grant?.pathPrefix,
								commandPrefix: outcome.grant?.commandPrefix,
								capability: outcome.grant?.capability,
								domain: outcome.grant?.domain,
								reason: outcome.grant?.scope,
								timestamp: Date.now(),
							}
						: {
								type: "permission-control.approval.reply",
								id: req.id,
								allowed: false,
								reason: outcome?.reason ?? "denied",
								timestamp: Date.now(),
							};
					done(reply);
					await st.audit.record({
						ts: Date.now(),
						auditId: nextAuditId(),
						agent: req.agent,
						tool: req.tool,
						capability: req.capability,
						resource: req.resource,
						verdict: outcome?.allowed ? "allow" : "deny",
						risk: req.risk,
						grantScope: outcome?.grant?.scope,
						route: `child:${req.agent}`,
						command: req.command,
					});
				} catch {
					done({ type: "permission-control.approval.reply", id: req.id, allowed: false, reason: "approval failed", timestamp: Date.now() });
				}
			});
		}
	});

	pi.on("session_shutdown", async () => {
		st.coordinator.reset();
		st.guardianDenials.length = 0;
		st.guardianConsecutiveDenials = 0;
		st.recentGuardianDenials.length = 0;
		st.approvalServer?.dispose();
		st.approvalServer = null;
		await st.sessionPolicy?.dispose();
		st.sessionPolicy = null;
		if (!isChild && st.root) await cleanupChannel(st.root);
	});

	// ---- tool gate ----
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "request_approval") return undefined;
		if (!st.config.enabled || !st.policy) return undefined;
		const req = await normalizeToolRequest(event, ctx, st);
		if (!req) return undefined;
		const result = await runGate(event, ctx, st, req);
		if (result.action === "block") {
			return { block: true, reason: result.reason, terminate: result.terminate };
		}
		return undefined;
	});

	// Consume once-grants after the tool actually executed.
	pi.on("tool_execution_end", async (event) => {
		const grant = st.onceByCall.get(event.toolCallId);
		if (grant) {
			st.onceByCall.delete(event.toolCallId);
			st.grants.consumeOnce(grant);
		}
	});

	// ---- request_approval custom tool (Codex-style proactive approval) ----
	pi.registerTool({
		name: "request_approval",
		label: "Request Approval",
		description: [
			"Request permission before performing a high-risk operation.",
			"Submit a justification, the required capability (read/write/edit/run_command/network/other),",
			"the resource scope (a path, URL/domain, or description), and an optional exact command prefix.",
			"The user (or the configured auto-approval judge) approves once/session/project/prefix.",
			"Returns whether the operation was allowed and, when allowed, the grant scope.",
		].join(" "),
		parameters: Type.Object({
			justification: Type.String({ description: "Why this permission is needed" }),
			capability: Type.String({ description: "Required capability: read, write, edit, run_command, network, or another name" }),
			resource: Type.String({ description: "Resource scope: a path, URL/domain, or description" }),
			command: Type.Optional(Type.String({ description: "Optional exact command prefix to be approved" })),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 600, description: "Wait limit for approval (default 120)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!st.config.enabled || !st.policy) {
				return {
					content: [{ type: "text", text: "permission-control is disabled; no approval needed." }],
					details: { allowed: true, disabled: true },
				};
			}
			const cap = (params.capability || "").toLowerCase();
			let kind: ResourceKind = "scope";
			if (cap === "network") kind = "domain";
			else if (cap === "run_command") kind = "command";
			else if (params.resource && (params.resource.startsWith("/") || params.resource.startsWith("~") || params.resource.startsWith("."))) kind = "path";

			let resource;
			try {
				resource = await normalizeResource(kind, params.resource, ctx.cwd);
			} catch (error) {
				resource = { kind, value: params.resource };
			}

			const req: AccessRequest = {
				agent: isChild ? (childMeta()?.agent ?? "subagent") : "main",
				tool: "request_approval",
				capability: cap,
				resource,
				command: params.command,
				justification: params.justification,
				isChild,
			};

			// Defense in depth: enforce deterministic authorization-sensitive
			// checks in the executor itself, before any policy/grant fast path.
			if (st.config.approvalPolicy === "approve-for-me") {
				const backstop = guardianAuthorizationBackstop(req, ctx);
				if (backstop.requiresExplicitAuthorization) {
					const guardianReason =
						backstop.reason ??
						"The current user messages do not explicitly authorize this exact elevated action.";
					const reason = [
						`Guardian requires explicit user authorization: ${guardianReason.replace(/[.!?]+\s*$/, "")}.`,
						"Tell the user the exact action that needs elevated permission and why.",
						"Ask the user to explicitly reply that they allow that exact action.",
						"Do not retry, broaden the scope, or attempt a workaround until a new user message provides that authorization.",
					].join(" ");
					await auditRecord(st, req, "deny", {
						reason,
						risk: backstop.risk ?? "high",
						detail: {
							guardianVerdict: "ask_user",
							guardianCategory: backstop.category ?? "ordinary",
							guardianAuthorization: "none",
							authorizationBackstop: "executor",
						},
					});
					return {
						content: [
							{
								type: "text",
								text: [
									"Permission requires explicit user authorization.",
									`Exact action: ${params.command ?? params.resource}`,
									`Reason: ${reason}`,
									"Stop now. Explain this request to the user and ask them to explicitly reply that they allow this exact action. Do not retry or use a workaround before receiving a new user message.",
								].join("\n"),
							},
						],
						details: {
							allowed: false,
							status: "authorization-required",
							requiresExplicitUserAuthorization: true,
							exactAction: params.command ?? params.resource,
							capability: cap,
							resource: params.resource,
						},
					};
				}
			}

			// Reuse the gate but with the toolCallId of this execution.
			const fakeEvent = { toolName: "request_approval", toolCallId: _id, input: params } as unknown as ToolCallEvent;
			const result = await runGate(fakeEvent, ctx, st, req);
			if (result.action === "block") {
				const details = {
					allowed: false,
					reason: result.reason,
					status: result.status ?? "denied",
					requiresExplicitUserAuthorization:
						result.status === "authorization-required",
					exactAction: params.command ?? params.resource,
					capability: cap,
					resource: params.resource,
				};
				const text =
					result.status === "authorization-required"
						? [
								"Permission requires explicit user authorization.",
								`Exact action: ${params.command ?? params.resource}`,
								`Reason: ${result.reason}`,
								"Stop now. Explain this request to the user and ask them to explicitly reply that they allow this exact action. Do not retry or use a workaround before receiving a new user message.",
							].join("\n")
						: `Permission DENIED: ${result.reason ?? "denied"}`;
				return {
					content: [{ type: "text", text }],
					details,
				};
			}
			const matched = findMatchingGrant(req, st.grants.all());
			return {
				content: [
					{
						type: "text",
						text: `Permission GRANTED${matched ? ` (${matched.scope})` : ""}. Proceed with the operation.`,
					},
				],
				details: {
					allowed: true,
					scope: matched?.scope ?? "once",
					capability: cap,
					resource: params.resource,
				},
			};
		},
	});

	// ---- system prompt guidance ----
	pi.on("before_agent_start", (event, ctx) => {
		if (!st.config.enabled) return undefined;
		const mode = st.config.sandboxMode;
		const policy = st.config.approvalPolicy;
		const lines = [
			"## Permission policy",
			`- Sandbox mode: ${mode}. Approval policy: ${policy}.`,
			"- In workspace-write, normal read/write/edit/bash inside the workspace are allowed automatically.",
			"- Operations that require approval: access outside the workspace, network, dangerous or privileged commands (sudo, rm -rf, dd, chmod 777...), and sensitive paths (.env, keys).",
			"- These paths are HARD-DENIED and cannot be approved: ~/.ssh, private keys, .env (as configured), and Pi permission/trust config files. Do not attempt to read or modify them.",
		];
		if (policy === "approve-for-me") {
			lines.push(
				"- Eligible boundary-crossing requests are reviewed by a Codex Guardian-style automatic reviewer using visible user authorization, exact target and scope, data payload and destination, credential probing, persistent security weakening, and destructive/reversibility risks.",
				"- If Guardian reports that explicit user authorization is required, stop and tell the user the exact action, target, scope, and reason. Ask the user to explicitly reply that they allow that exact action. Do not retry, broaden the request, or use a workaround until a new user message provides authorization.",
				"- A Guardian critical/policy denial is final for that exact action. Do not retry indirectly or through a workaround; use a materially safer alternative or ask the user to change the requested action.",
			);
		}
		if (ctx.hasUI) {
			lines.push(
				"- To request permission proactively (e.g. before network or out-of-workspace access), call the request_approval tool with a justification, capability, resource scope, and optional command prefix.",
				"- If request_approval returns DENIED, do not retry with a workaround; stop and explain to the user.",
			);
		} else {
			lines.push(
				"- This session has no interactive approval channel: operations that would need approval are denied (fail-closed). Stay inside the workspace.",
			);
		}
		return { systemPrompt: event.systemPrompt + "\n\n" + lines.join("\n") };
	});

	// ---- commands ----
	pi.registerCommand("perm", {
		description: "Show permission-control status",
		handler: async (_args, ctx) => {
			const s = await landstripStatus();
			const judgeModel =
				st.config.approveForMe?.provider && st.config.approveForMe?.model
					? `${st.config.approveForMe.provider}/${st.config.approveForMe.model}`
					: "active session model";
			const lines = [
				`enabled: ${st.config.enabled}`,
				`mode: ${st.config.sandboxMode}`,
				`approval policy: ${st.config.approvalPolicy}`,
				`approve-for-me model: ${judgeModel}`,
				"approve-for-me policy: Codex Guardian",
				`approve-for-me timeout: ${st.config.approveForMe?.timeoutMs ?? 30_000}ms`,
				`Guardian denials: consecutive=${st.guardianConsecutiveDenials}, recent=${st.guardianDenials.length}`,
				`workspace: ${st.workspaceRoot}`,
				`project grants: ${st.grants.all().filter((g) => g.scope === "project").length}`,
				`session grants: ${st.grants.all().filter((g) => g.scope === "session").length}`,
				`OS sandbox backend: ${s.available ? `available (${s.binaryPath})` : `unavailable (${s.error ?? "?"})`}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("perm-config", {
		description: "Interactively configure sandbox, approval policy, and approve-for-me judge",
		handler: async (_args, ctx) => {
			const modeChoice = await ctx.ui.select(
				"Sandbox mode:",
				["workspace-write", "read-only", "full-access"],
			);
			if (!modeChoice) return;
			const mode = modeChoice as SandboxMode;
			const policyChoice = await ctx.ui.select(
				"Approval policy:",
				["on-request", "untrusted", "never", "approve-for-me"],
			);
			if (!policyChoice) return;
			const policy = policyChoice as ApprovalPolicy;

			let approveForMe = st.config.approveForMe;
			if (policy === "approve-for-me") {
				const activeModelLabel = ctx.model
					? `Use active session model (${ctx.model.provider}/${ctx.model.id})`
					: "Use active session model";
				const availableModels = ctx.modelRegistry
					.getAvailable()
					.slice()
					.sort((a, b) =>
						`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
					);
				const modelChoices = [
					activeModelLabel,
					...availableModels.map((model) => `${model.provider}/${model.id}`),
				];
				const configuredModel =
					approveForMe?.provider && approveForMe.model
						? `${approveForMe.provider}/${approveForMe.model}`
						: undefined;
				if (configuredModel && !modelChoices.includes(configuredModel)) {
					modelChoices.splice(1, 0, configuredModel);
				}

				const modelChoice = await ctx.ui.select(
					"Approve-for-me judge model:",
					modelChoices,
				);
				if (!modelChoice) return;

				let provider: string | undefined;
				let model: string | undefined;
				if (modelChoice !== activeModelLabel) {
					const separator = modelChoice.indexOf("/");
					if (separator <= 0 || separator === modelChoice.length - 1) {
						ctx.ui.notify(`Invalid model selection: ${modelChoice}`, "error");
						return;
					}
					provider = modelChoice.slice(0, separator);
					model = modelChoice.slice(separator + 1);
				}

				const timeoutChoice = await ctx.ui.select(
					"Judge timeout:",
					["10 seconds", "30 seconds (recommended)", "60 seconds", "Custom"],
				);
				if (!timeoutChoice) return;
				let timeoutMs =
					timeoutChoice === "10 seconds"
						? 10_000
						: timeoutChoice === "60 seconds"
							? 60_000
							: 30_000;
				if (timeoutChoice === "Custom") {
					const raw = await ctx.ui.input(
						"Judge timeout in seconds:",
						String(Math.round((approveForMe?.timeoutMs ?? 30_000) / 1000)),
					);
					if (raw === undefined) return;
					const seconds = Number(raw.trim());
					if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) {
						ctx.ui.notify("Timeout must be between 5 and 600 seconds.", "error");
						return;
					}
					timeoutMs = Math.round(seconds * 1000);
				}

				approveForMe = {
					provider,
					model,
					timeoutMs,
				};
			}

			const scopeChoice = await ctx.ui.select("Persist where?", ["global", "project"]);
			if (!scopeChoice) return;
			const update: Record<string, unknown> = {
				sandboxMode: mode,
				approvalPolicy: policy,
			};
			if (policy === "approve-for-me") update.approveForMe = approveForMe;
			await saveConfigUpdate(
				st.cwd,
				update,
				scopeChoice as "global" | "project",
			);
			st.config = {
				...st.config,
				sandboxMode: mode,
				approvalPolicy: policy,
				...(policy === "approve-for-me" ? { approveForMe } : {}),
			};
			st.policy = await PolicyContextImpl.create(st.config, st.cwd);
			st.policy.grants = st.grants.all();
			await st.sessionPolicy?.dispose();
			st.sessionPolicy = new SessionPolicy(st.config, st.workspaceRoot);
			const judgeSummary =
				policy === "approve-for-me"
					? `, judge=${approveForMe?.provider && approveForMe.model ? `${approveForMe.provider}/${approveForMe.model}` : "active model"}, policy=Codex Guardian, timeout=${approveForMe?.timeoutMs ?? 30_000}ms`
					: "";
			ctx.ui.notify(
				`permission-control: mode=${mode}, approval=${policy}${judgeSummary} (${scopeChoice})`,
				"info",
			);
		},
	});

	pi.registerCommand("perm-allow", {
		description: "Manually add a persistent allow rule: /perm-allow path <path> | command <prefix> | capability <name> | domain <host> [project|global]",
		handler: async (args, ctx) => {
			const parts = Array.isArray(args) ? args.map(String) : String(args ?? "").trim().split(/\s+/);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /perm-allow path|command|capability|domain <value> [project|global]", "warning");
				return;
			}
			const [type, ...rest] = parts;
			const scopeArg = rest[rest.length - 1];
			const hasExplicitScope = scopeArg === "project" || scopeArg === "global";
			const scope: "project" | "global" = scopeArg === "global" ? "global" : "project";
			const valueParts = hasExplicitScope ? rest.slice(0, -1) : rest;
			const value = valueParts.join(" ");
			if (!value) {
				ctx.ui.notify("Usage: /perm-allow path|command|capability|domain <value> [project|global]", "warning");
				return;
			}
			let grant: ApprovedGrant | undefined;
			switch (type) {
				case "path": {
					const abs = await realpathSafe(toAbsolute(value, st.cwd));
					grant = { scope, pathPrefix: abs, createdAt: Date.now() };
					break;
				}
				case "command":
					grant = { scope, commandPrefix: value, createdAt: Date.now() };
					break;
				case "capability":
					grant = { scope, capability: value, createdAt: Date.now() };
					break;
				case "domain":
					grant = { scope, domain: value.toLowerCase(), createdAt: Date.now() };
					break;
				default:
					ctx.ui.notify(`Unknown rule type: ${type}`, "warning");
					return;
			}
			if (!grant) return;
			await st.grants.add(grant);
			ctx.ui.notify(`Added ${scope} rule: ${type} ${value}`, "info");
		},
	});

	pi.registerCommand("perm-approve", {
		description: "Approve one exact retry of a recent Guardian denial",
		handler: async (_args, ctx) => {
			if (st.recentGuardianDenials.length === 0) {
				ctx.ui.notify("No recent Guardian denials.", "info");
				return;
			}
			const labels = st.recentGuardianDenials.map((denial, index) => {
				const target = abbreviateApprovalDetail(
					denial.req.command ?? denial.req.resource.value,
					90,
				);
				const mode = denial.canUserAuthorize ? "authorization required" : "policy denied";
				return `${index + 1}. [${denial.risk}; ${mode}] ${target}`;
			});
			const choice = await ctx.ui.select("Approve one exact denied action for one retry:", labels);
			if (!choice) return;
			const index = labels.indexOf(choice);
			const denial = st.recentGuardianDenials[index];
			if (!denial) return;
			if (!denial.canUserAuthorize) {
				ctx.ui.notify(
					"This Guardian denial is not user-overridable. Change the requested action or use a materially safer alternative.",
					"error",
				);
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Confirm exact one-shot override",
				[
					`Risk: ${denial.risk}`,
					`Category: ${denial.category}`,
					`Action: ${abbreviateApprovalDetail(denial.req.command ?? denial.req.resource.value, 180)}`,
					`Guardian: ${abbreviateApprovalDetail(denial.reason, 180)}`,
					"",
					"This authorizes one exact retry only.",
				].join("\n"),
			);
			if (!confirmed) return;

			// Add an explicit visible user-authorization message to the session.
			// The exact retry still passes through Guardian; this is context, not
			// a sandbox bypass.
			const action = denial.req.command ?? denial.req.resource.value;
			pi.sendUserMessage(
				`I explicitly authorize this exact action for one retry: ${action}`,
			);
			st.recentGuardianDenials.splice(index, 1);
			st.guardianConsecutiveDenials = 0;
			ctx.ui.notify(
				"Recorded explicit authorization and queued one exact retry for Guardian review.",
				"warning",
			);
		},
	});

	pi.registerCommand("perm-log", {
		description: "Show recent permission decisions from the audit log",
		handler: async (_args, ctx) => {
			const file = st.config.audit.path ?? "";
			if (!file || !existsSync(file)) {
				ctx.ui.notify("No audit log yet.", "info");
				return;
			}
			try {
				const text = await readFile(file, "utf-8");
				const lines = text.trim().split("\n").filter(Boolean);
				const recent = lines.slice(-25).map((l) => {
					try {
						return summarize(JSON.parse(l) as AuditRecord);
					} catch {
						return l;
					}
				});
				ctx.ui.notify(`Recent permission decisions (${lines.length} total):\n${recent.join("\n")}`, "info");
			} catch {
				ctx.ui.notify("Could not read audit log.", "warning");
			}
		},
	});

	pi.registerCommand("perm-sandbox", {
		description: "Show the OS sandbox backend (landstrip) status",
		handler: async (_args, ctx) => {
			const s = await landstripStatus();
			ctx.ui.notify(
				s.available
					? `landstrip available: ${s.binaryPath}\nbash sandboxing: ${st.config.sandbox.enabled ? "enabled" : "disabled"} (require=${st.config.sandbox.requireLandstrip})`
					: `landstrip unavailable: ${s.error}\nBash runs unsandboxed but still gated by the permission layer.`,
				s.available ? "info" : "warning",
			);
		},
	});
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function rulesFromGrants(grants: ApprovedGrant[]): PermissionRules {
	return {
		allowPaths: unique(grants.filter((g) => g.pathPrefix).map((g) => g.pathPrefix!)),
		allowCommands: unique(grants.filter((g) => g.commandPrefix).map((g) => g.commandPrefix!)),
		allowCapabilities: unique(
			grants.filter((g) => g.capability && !g.pathPrefix && !g.commandPrefix).map((g) => g.capability!),
		),
		allowDomains: unique(grants.filter((g) => g.domain).map((g) => g.domain!)),
	};
}

function grantsFromRules(raw: unknown, scope: "project" | "global"): ApprovedGrant[] {
	const rules = (raw ?? {}) as Partial<PermissionRules>;
	const out: ApprovedGrant[] = [];
	const createdAt = 0;
	for (const p of rules.allowPaths ?? []) out.push({ scope, pathPrefix: p, createdAt });
	for (const c of rules.allowCommands ?? []) out.push({ scope, commandPrefix: c, createdAt });
	for (const c of rules.allowCapabilities ?? []) out.push({ scope, capability: c, createdAt });
	for (const d of rules.allowDomains ?? []) out.push({ scope, domain: d, createdAt });
	return out;
}
