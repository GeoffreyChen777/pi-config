/**
 * policy.ts — the unified permission decision engine.
 *
 * Every operation is normalized into a structured AccessRequest
 * (agent / tool / capability / resource / command) and evaluated to a single
 * verdict with strict precedence:
 *
 *     deny > ask > allow
 *
 * A hard deny can never be overridden by any approval grant. Full-access mode
 * short-circuits to allow. Read-only mode denies writes. Grants (once /
 * session / project) are matched before defaulting to ask.
 */

import {
	classifyPath,
	compilePathRule,
	isInside,
	isHardDenied,
	realpathSafe,
	resolveForPolicy,
	toAbsolute,
	type PathRule,
} from "./paths.ts";
import { analyzeCommand, type BashAnalysis, type PathOperand } from "./bash.ts";
import {
	protectedConfigPaths,
	type ApprovalPolicy,
	type PermissionControlConfig,
	type RiskLevel,
	type SandboxMode,
} from "./config.ts";
import type { ApprovedGrant } from "./approvals.ts";

export type { RiskLevel } from "./config.ts";

export type Verdict = "allow" | "ask" | "deny";

export type Capability =
	| "read"
	| "write"
	| "edit"
	| "apply_patch"
	| "grep"
	| "ls"
	| "find"
	| "run_command"
	| "network"
	| (string & {});

export type ResourceKind = "path" | "command" | "domain" | "scope";

export interface Resource {
	readonly kind: ResourceKind;
	/** human-readable value (path / command / domain) */
	readonly value: string;
	/** absolute realpath when kind === "path" */
	readonly path?: string;
}

export interface AccessRequest {
	readonly agent: string;
	readonly tool: string;
	readonly capability: Capability;
	readonly resource: Resource;
	/** raw command for run_command */
	readonly command?: string;
	/** optional agent-supplied justification */
	readonly justification?: string;
	/** true when the requester is a subagent (no local TUI) */
	readonly isChild?: boolean;
}

export interface Decision {
	readonly verdict: Verdict;
	readonly reason?: string;
	readonly risk: RiskLevel;
	/** matched grant (verdict === "allow") */
	readonly grant?: ApprovedGrant;
}

export interface PolicyContextOptions {
	config: PermissionControlConfig;
	cwd: string;
	workspaceRoot: string; // realpath
	hardDenyRules: readonly PathRule[];
	sensitiveRules: readonly PathRule[];
	/** protected pi/permission config paths (compiled hard-deny) */
	projectPathRules: readonly PathRule[];
	grants: ApprovedGrant[];
}

export class PolicyContext {
	readonly config: PermissionControlConfig;
	readonly cwd: string;
	readonly workspaceRoot: string;
	readonly hardDenyRules: readonly PathRule[];
	readonly sensitiveRules: readonly PathRule[];
	readonly projectPathRules: readonly PathRule[];
	/** mutable grant list (session + project) */
	grants: ApprovedGrant[];

	constructor(opts: PolicyContextOptions) {
		this.config = opts.config;
		this.cwd = opts.cwd;
		this.workspaceRoot = opts.workspaceRoot;
		this.hardDenyRules = opts.hardDenyRules;
		this.sensitiveRules = opts.sensitiveRules;
		this.projectPathRules = opts.projectPathRules;
		this.grants = opts.grants;
	}

	get sandboxMode(): SandboxMode {
		return this.config.sandboxMode;
	}

	get approvalPolicy(): ApprovalPolicy {
		return this.config.approvalPolicy;
	}

	/** Compile a fresh PolicyContext for a (possibly different) cwd/workspace. */
	static async create(config: PermissionControlConfig, cwd: string): Promise<PolicyContext> {
		const workspaceRoot = await realpathSafe(config.workspaceRoot ? toAbsolute(config.workspaceRoot, cwd) : cwd);
		const hardDenyPaths = [...config.hardDeny.paths, ...protectedConfigPaths(cwd)];
		const hardDenyRules = await compileResolvedRules(hardDenyPaths, cwd);
		const sensitiveRules = await compileResolvedRules(
			[...config.ask.sensitivePaths ? DEFAULT_SENSITIVE_RULES : []],
			cwd,
		);
		const projectPathRules = await compileResolvedRules(protectedConfigPaths(cwd), cwd);
		// Include any configured hard-deny and protected config paths.
		return new PolicyContext({
			config,
			cwd,
			workspaceRoot,
			hardDenyRules,
			sensitiveRules,
			projectPathRules,
			grants: [],
		});
	}
}

/**
 * Requests are evaluated using real paths. Resolve non-glob rule paths too so
 * aliases such as macOS /tmp -> /private/tmp cannot bypass hard-deny or
 * protected-config matching.
 */
async function compileResolvedRules(paths: readonly string[], cwd: string): Promise<PathRule[]> {
	return Promise.all(
		paths.map(async (path) => {
			const rule = compilePathRule(path, cwd);
			if (rule.glob) return rule;
			return { ...rule, absolute: await realpathSafe(rule.absolute) };
		}),
	);
}

// Sensitive rules are always compiled from the default list plus config hardDeny.
const DEFAULT_SENSITIVE_RULES: readonly string[] = [
	"**/.env",
	"**/.env.*",
	"**/*.pem",
	"**/*.key",
	"**/*.p12",
	"**/*.pfx",
	"**/id_rsa",
	"**/id_ed25519",
	"**/credentials",
	"**/secrets",
	"**/token",
	"**/.git/config",
];

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

export function riskOf(req: AccessRequest, flags?: Partial<BashFlags>): RiskLevel {
	if (flags) {
		if (flags.privileged || flags.dangerous || flags.unparseable) return "high";
		if (flags.network) return "medium";
		if (flags.hasSensitivePaths) return "high";
		if (flags.outOfWorkspaceWrite) return "high";
		if (flags.outOfWorkspaceRead) return "medium";
	}
	switch (req.capability) {
		case "write":
		case "edit":
		case "apply_patch":
		case "run_command":
			return "low"; // refined below for bash via flags
		case "network":
			return "medium";
		default:
			return "low";
	}
}

export interface BashFlags {
	readonly privileged: boolean;
	readonly network: boolean;
	readonly dangerous: boolean;
	readonly unparseable: boolean;
	readonly outOfWorkspaceRead: boolean;
	readonly outOfWorkspaceWrite: boolean;
	readonly hasSensitivePaths: boolean;
	readonly hasHardDenyPaths: boolean;
	readonly inWorkspace: boolean;
}

// ---------------------------------------------------------------------------
// Resource normalization
// ---------------------------------------------------------------------------

export interface NormalizedResource extends Resource {
	abs?: string; // resolved realpath for path kind
}

export async function normalizeResource(
	kind: ResourceKind,
	value: string,
	cwd: string,
): Promise<NormalizedResource> {
	if (kind === "path") {
		const abs = await resolveForPolicy(value, cwd);
		return { kind, value, path: abs, abs };
	}
	if (kind === "command") {
		return { kind, value };
	}
	if (kind === "domain") {
		return { kind, value: value.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]! };
	}
	return { kind, value };
}

// ---------------------------------------------------------------------------
// Grant matching
// ---------------------------------------------------------------------------

function domainMatches(rule: string, domain: string): boolean {
	const d = domain.toLowerCase();
	const r = rule.toLowerCase().replace(/^\./, "");
	return d === r || d.endsWith(`.${r}`);
}

export function findMatchingGrant(req: AccessRequest, grants: readonly ApprovedGrant[]): ApprovedGrant | undefined {
	for (const grant of grants) {
		if (grant.capability && grant.capability !== req.capability) continue;
		if (grant.pathPrefix && req.resource.path) {
			if (!isInside(grant.pathPrefix, req.resource.path)) continue;
		}
		if (grant.commandPrefix && req.command) {
			if (!req.command.trim().startsWith(grant.commandPrefix)) continue;
		}
		if (grant.domain && req.resource.kind === "domain") {
			if (!domainMatches(grant.domain, req.resource.value)) continue;
		}
		return grant;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Bash analysis → flags + per-path classification
// ---------------------------------------------------------------------------

interface PathResolution {
	operand: PathOperand;
	real: string;
	hardDeny: boolean;
	sensitive: boolean;
	inWorkspace: boolean;
	outOfWorkspace: boolean;
}

async function resolveBashPaths(
	analysis: BashAnalysis,
	ctx: PolicyContext,
): Promise<PathResolution[]> {
	const out: PathResolution[] = [];
	const seen = new Set<string>();
	for (const sub of analysis.subCommands) {
		for (const op of sub.paths) {
			const abs = op.abs.startsWith("/") ? op.abs : toAbsolute(op.abs, ctx.cwd);
			const real = await realpathSafe(abs);
			const key = `${op.kind}\u0000${real}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const cls = await classifyPath(real, ctx.workspaceRoot, ctx.hardDenyRules, ctx.sensitiveRules);
			out.push({
				operand: op,
				real,
				hardDeny: cls === "hard-deny",
				sensitive: cls === "sensitive",
				inWorkspace: cls === "in-workspace",
				outOfWorkspace: cls === "out-of-workspace",
			});
		}
	}
	return out;
}

export function analyzeBashFlags(analysis: BashAnalysis, paths: PathResolution[]): BashFlags {
	let outOfWorkspaceRead = false;
	let outOfWorkspaceWrite = false;
	let hasSensitivePaths = false;
	let hasHardDenyPaths = false;
	let inWorkspace = false;
	for (const p of paths) {
		if (p.hardDeny) hasHardDenyPaths = true;
		if (p.sensitive) hasSensitivePaths = true;
		if (p.outOfWorkspace) {
			if (p.operand.kind === "write") outOfWorkspaceWrite = true;
			else outOfWorkspaceRead = true;
		}
		if (p.inWorkspace) inWorkspace = true;
	}
	return {
		privileged: analysis.privileged,
		network: analysis.network,
		dangerous: analysis.dangerous,
		unparseable: !analysis.parseable,
		outOfWorkspaceRead,
		outOfWorkspaceWrite,
		hasSensitivePaths,
		hasHardDenyPaths,
		inWorkspace,
	};
}

// ---------------------------------------------------------------------------
// Decision entry points
// ---------------------------------------------------------------------------

/** Full decision for a file/path tool. */
export async function decidePath(
	ctx: PolicyContext,
	req: AccessRequest,
	real: string,
): Promise<Decision> {
	// 1. protected Pi permission/trust config is never modifiable, even in full-access
	if (matchesProtectedConfig(real, ctx.projectPathRules)) {
		return { verdict: "deny", risk: "high", reason: `protected config path: ${req.resource.value}` };
	}

	// 2. full access: ignore all operational permissions (the user opted out)
	if (ctx.sandboxMode === "full-access") return { verdict: "allow", risk: "low" };

	// 3. hard deny (never overridable by approval)
	if (isHardDenied(real, ctx.hardDenyRules)) {
		return { verdict: "deny", risk: "high", reason: `hard-deny path: ${req.resource.value}` };
	}

	// 4. read-only mode blocks mutations
	const isMutation = req.capability === "write" || req.capability === "edit" || req.capability === "apply_patch";
	if (ctx.sandboxMode === "read-only" && isMutation) {
		return { verdict: "deny", risk: "low", reason: "read-only mode blocks writes" };
	}

	const cls = await classifyPath(real, ctx.workspaceRoot, ctx.hardDenyRules, ctx.sensitiveRules);

	// 5. grant match
	const grant = findMatchingGrant(req, ctx.grants);
	if (grant) return { verdict: "allow", risk: "low", grant };

	// 6. in-workspace → allow (workspace-write)
	if (cls === "in-workspace") return { verdict: "allow", risk: "low" };

	// 7. sensitive → ask (unless untrusted/never policies handled by caller)
	if (cls === "sensitive") {
		if (!ctx.config.ask.sensitivePaths) return { verdict: "allow", risk: "high" };
		return { verdict: "ask", risk: "high", reason: `sensitive path: ${req.resource.value}` };
	}

	// 8. out-of-workspace
	if (cls === "out-of-workspace") {
		if (!ctx.config.ask.outOfWorkspace) return { verdict: "allow", risk: isMutation ? "high" : "medium" };
		return {
			verdict: "ask",
			risk: isMutation ? "high" : "medium",
			reason: `${isMutation ? "write" : "read"} outside workspace: ${req.resource.value}`,
		};
	}

	return { verdict: "ask", risk: "medium", reason: "unclassified path" };
}

function matchesProtectedConfig(real: string, rules: readonly PathRule[]): boolean {
	return rules.some((r) => isInside(r.absolute, real));
}

/** Full decision for a bash command. */
export async function decideBash(ctx: PolicyContext, req: AccessRequest): Promise<Decision> {
	const analysis = analyzeCommand(req.command ?? "", ctx.cwd);
	const paths = await resolveBashPaths(analysis, ctx);
	const flags = analyzeBashFlags(analysis, paths);

	// 1. protected Pi permission/trust config is never touched, even in full-access
	if (paths.some((p) => matchesProtectedConfig(p.real, ctx.projectPathRules))) {
		return { verdict: "deny", risk: "high", reason: "command references a protected config path" };
	}

	// 2. full access: ignore all operational permissions (the user opted out)
	if (ctx.sandboxMode === "full-access") return { verdict: "allow", risk: "low" };

	// 3. hard deny paths referenced by the command
	if (flags.hasHardDenyPaths || analysis.hasHardDenyPaths) {
		return { verdict: "deny", risk: "high", reason: "command references a hard-deny path" };
	}

	// 4. read-only mode: allow only pure reads/inspection
	if (ctx.sandboxMode === "read-only") {
		if (analysis.hasInWorkspaceWrites || analysis.dangerous) {
			return { verdict: "deny", risk: "high", reason: "read-only mode blocks mutations" };
		}
	}

	// 5. grant match (command prefix)
	const grant = findMatchingGrant(req, ctx.grants);
	if (grant) return { verdict: "allow", risk: "low", grant };

	// 6. unparseable → conservative ask (fail-closed when headless)
	if (flags.unparseable) {
		return { verdict: "ask", risk: "high", reason: "command could not be parsed safely" };
	}

	const needsAsk = (cond: boolean, reason: string): string | undefined =>
		cond ? reason : undefined;

	const reasons: string[] = [];
	if (flags.privileged && ctx.config.ask.privileged) reasons.push("privileged command (sudo/su)");
	if (flags.network && ctx.config.ask.network) reasons.push("network access");
	if (flags.dangerous && ctx.config.ask.dangerousCommands) reasons.push("dangerous command");
	if (flags.hasSensitivePaths && ctx.config.ask.sensitivePaths) reasons.push("sensitive path");
	if (flags.outOfWorkspaceWrite && ctx.config.ask.outOfWorkspace) reasons.push("write outside workspace");
	if (flags.outOfWorkspaceRead && ctx.config.ask.outOfWorkspace) reasons.push("read outside workspace");

	if (reasons.length > 0) {
		return {
			verdict: "ask",
			risk: riskOf(req, flags),
			reason: reasons.join("; "),
		};
	}

	// 7. otherwise workspace-safe
	return { verdict: "allow", risk: "low" };
}

/** Convenience for a network (domain) request. */
export function decideDomain(ctx: PolicyContext, req: AccessRequest): Decision {
	if (ctx.sandboxMode === "full-access") return { verdict: "allow", risk: "low" };
	const grant = findMatchingGrant(req, ctx.grants);
	if (grant) return { verdict: "allow", risk: "low", grant };
	if (!ctx.config.ask.network) return { verdict: "allow", risk: "medium" };
	return { verdict: "ask", risk: "medium", reason: `network access to ${req.resource.value}` };
}

/**
 * Final gate for `ask` decisions — applies the approval policy and the
 * requester's UI/channel capabilities. Called by the approver, not by the
 * pure decision functions above.
 */
export function applyPolicyToAsk(ctx: PolicyContext, decision: Decision): Decision {
	switch (ctx.approvalPolicy) {
		case "untrusted":
		case "never":
			return { ...decision, verdict: "deny", reason: `${ctx.approvalPolicy} policy denies without approval` };
		default:
			return decision;
	}
}
