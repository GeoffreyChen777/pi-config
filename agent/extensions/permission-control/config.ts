/**
 * config.ts — configuration model, defaults, atomic load/save for the
 * permission-control extension.
 *
 * Configuration sources (merged in this order):
 *   1. built-in defaults
 *   2. global  ~/.pi/agent/permission-control.json
 *   3. project .pi/permission-control.json        (only when the project is trusted)
 *
 * Persistent rules (Allow for project / global) are written atomically
 * (write temp file + rename) so a crash can never leave a half-written rule.
 * The config files themselves are protected: the permission layer hard-denies
 * agent writes to them (see policy.ts).
 */

import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SandboxMode = "read-only" | "workspace-write" | "full-access";
export type ApprovalPolicy = "on-request" | "untrusted" | "never" | "approve-for-me";
export type RiskLevel = "low" | "medium" | "high";

export interface ApproveForMeConfig {
	/** provider id; defaults to the active model's provider */
	provider?: string;
	/** model id; defaults to the active model */
	model?: string;
	/** @deprecated retained only when reading older config files */
	autoApproveRisk?: RiskLevel[] | "low" | "medium" | "high" | "low-medium" | "none";
	/** per-judge-call timeout */
	timeoutMs?: number;
}

export interface PermissionRules {
	/** absolute path prefixes (realpaths) allowed for this scope */
	allowPaths: string[];
	/** command prefixes allowed for this scope */
	allowCommands: string[];
	/** capability names allowed for this scope */
	allowCapabilities: string[];
	/** network domains allowed for this scope */
	allowDomains: string[];
}

export interface HardDenyConfig {
	paths: string[];
	commands: string[];
}

export interface AskConfig {
	outOfWorkspace: boolean;
	network: boolean;
	dangerousCommands: boolean;
	privileged: boolean;
	sensitivePaths: boolean;
}

export interface AuditConfig {
	enabled: boolean;
	/** default: ~/.pi/agent/permission-control-audit.jsonl */
	path?: string;
	/** redact tokens/ids in messages shown to the user (audit file keeps details) */
	redact: boolean;
}

export interface SandboxBackendConfig {
	/** use @landstrip/landstrip as the OS sandbox backend for bash when available */
	enabled: boolean;
	/** when true, bash is denied entirely if the landstrip binary is unavailable */
	requireLandstrip: boolean;
	/** extra allowRead paths passed to landstrip policies */
	allowRead: string[];
	/** extra allowWrite paths passed to landstrip policies */
	allowWrite: string[];
	/** extra denyRead paths passed to landstrip policies */
	denyRead: string[];
	/** extra denyWrite paths passed to landstrip policies */
	denyWrite: string[];
	/** allow network inside landstrip for granted domains (default false) */
	allowNetwork: boolean;
}

export interface PermissionControlConfig {
	enabled: boolean;
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
	/** how long a forwarded subagent approval may wait before timing out */
	subagentApprovalTimeoutMs: number;
	/** how long the main-session user has to answer a TUI prompt (0 = no timeout) */
	promptTimeoutMs: number;
	workspaceRoot?: string;
	hardDeny: HardDenyConfig;
	ask: AskConfig;
	audit: AuditConfig;
	sandbox: SandboxBackendConfig;
	approveForMe?: ApproveForMeConfig;
	rules: PermissionRules;
}

export function defaultConfig(): PermissionControlConfig {
	return {
		enabled: true,
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
		subagentApprovalTimeoutMs: 120_000,
		promptTimeoutMs: 0,
		hardDeny: {
			paths: ["~/.ssh", "~/.gnupg", "~/.aws/credentials", "~/.netrc", "~/.pi/agent/trust.json"],
			commands: [],
		},
		ask: {
			outOfWorkspace: true,
			network: true,
			dangerousCommands: true,
			privileged: true,
			sensitivePaths: true,
		},
		audit: {
			enabled: true,
			path: join(getAgentDir(), "permission-control-audit.jsonl"),
			redact: true,
		},
		sandbox: {
			enabled: true,
			requireLandstrip: false,
			allowRead: [],
			allowWrite: [],
			denyRead: [],
			denyWrite: [],
			allowNetwork: false,
		},
		approveForMe: {
			timeoutMs: 30_000,
		},
		rules: {
			allowPaths: [],
			allowCommands: [],
			allowCapabilities: [],
			allowDomains: [],
		},
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(v: unknown, fallback: string[]): string[] {
	if (!Array.isArray(v)) return fallback;
	return v.filter((x): x is string => typeof x === "string");
}

function mergeRules(base: PermissionRules, over: unknown): PermissionRules {
	const o = isRecord(over) ? over : {};
	const merge = (b: string[], v: unknown) => [...new Set([...b, ...stringArray(v, [])])];
	return {
		allowPaths: merge(base.allowPaths, o.allowPaths),
		allowCommands: merge(base.allowCommands, o.allowCommands),
		allowCapabilities: merge(base.allowCapabilities, o.allowCapabilities),
		allowDomains: merge(base.allowDomains, o.allowDomains),
	};
}

/** Deep-ish merge of a partial config object over the base. */
export function mergeConfig(base: PermissionControlConfig, partial: unknown): PermissionControlConfig {
	if (!isRecord(partial)) return base;
	const p = partial;
	const merged: PermissionControlConfig = {
		...base,
		enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
		sandboxMode: isSandboxMode(p.sandboxMode) ? p.sandboxMode : base.sandboxMode,
		approvalPolicy: isApprovalPolicy(p.approvalPolicy) ? p.approvalPolicy : base.approvalPolicy,
		subagentApprovalTimeoutMs: typeof p.subagentApprovalTimeoutMs === "number" ? p.subagentApprovalTimeoutMs : base.subagentApprovalTimeoutMs,
		promptTimeoutMs: typeof p.promptTimeoutMs === "number" ? p.promptTimeoutMs : base.promptTimeoutMs,
		workspaceRoot: typeof p.workspaceRoot === "string" ? p.workspaceRoot : base.workspaceRoot,
	};
	if (isRecord(p.hardDeny)) {
		merged.hardDeny = {
			paths: stringArray(p.hardDeny.paths, base.hardDeny.paths),
			commands: stringArray(p.hardDeny.commands, base.hardDeny.commands),
		};
	}
	if (isRecord(p.ask)) {
		merged.ask = {
			outOfWorkspace: typeof p.ask.outOfWorkspace === "boolean" ? p.ask.outOfWorkspace : base.ask.outOfWorkspace,
			network: typeof p.ask.network === "boolean" ? p.ask.network : base.ask.network,
			dangerousCommands: typeof p.ask.dangerousCommands === "boolean" ? p.ask.dangerousCommands : base.ask.dangerousCommands,
			privileged: typeof p.ask.privileged === "boolean" ? p.ask.privileged : base.ask.privileged,
			sensitivePaths: typeof p.ask.sensitivePaths === "boolean" ? p.ask.sensitivePaths : base.ask.sensitivePaths,
		};
	}
	if (isRecord(p.audit)) {
		merged.audit = {
			enabled: typeof p.audit.enabled === "boolean" ? p.audit.enabled : base.audit.enabled,
			path: typeof p.audit.path === "string" ? p.audit.path : base.audit.path,
			redact: typeof p.audit.redact === "boolean" ? p.audit.redact : base.audit.redact,
		};
	}
	if (isRecord(p.sandbox)) {
		merged.sandbox = {
			enabled: typeof p.sandbox.enabled === "boolean" ? p.sandbox.enabled : base.sandbox.enabled,
			requireLandstrip: typeof p.sandbox.requireLandstrip === "boolean" ? p.sandbox.requireLandstrip : base.sandbox.requireLandstrip,
			allowRead: stringArray(p.sandbox.allowRead, base.sandbox.allowRead),
			allowWrite: stringArray(p.sandbox.allowWrite, base.sandbox.allowWrite),
			denyRead: stringArray(p.sandbox.denyRead, base.sandbox.denyRead),
			denyWrite: stringArray(p.sandbox.denyWrite, base.sandbox.denyWrite),
			allowNetwork: typeof p.sandbox.allowNetwork === "boolean" ? p.sandbox.allowNetwork : base.sandbox.allowNetwork,
		};
	}
	if (isRecord(p.approveForMe)) {
		const a = p.approveForMe;
		merged.approveForMe = {
			provider: typeof a.provider === "string" ? a.provider : base.approveForMe?.provider,
			model: typeof a.model === "string" ? a.model : base.approveForMe?.model,
			...(a.autoApproveRisk !== undefined
				? { autoApproveRisk: parseAutoApproveRisk(a.autoApproveRisk) }
				: base.approveForMe?.autoApproveRisk !== undefined
					? { autoApproveRisk: base.approveForMe.autoApproveRisk }
					: {}),
			timeoutMs: typeof a.timeoutMs === "number" ? a.timeoutMs : base.approveForMe?.timeoutMs ?? 30_000,
		};
	}
	if (p.rules !== undefined || isRecord(p.rules)) {
		merged.rules = mergeRules(base.rules, p.rules);
	}
	return merged;
}

function isSandboxMode(v: unknown): v is SandboxMode {
	return v === "read-only" || v === "workspace-write" || v === "full-access";
}
function isApprovalPolicy(v: unknown): v is ApprovalPolicy {
	return v === "on-request" || v === "untrusted" || v === "never" || v === "approve-for-me";
}
function parseAutoApproveRisk(
	v: unknown,
): RiskLevel[] {
	if (Array.isArray(v)) {
		const out = v.filter((x): x is RiskLevel => x === "low" || x === "medium" || x === "high");
		// An empty array is intentional: the judge may advise, but must never
		// approve silently. Missing/non-array values still use the fallback.
		return out;
	}
	return normalizeAutoApproveRisk(v as ApproveForMeConfig["autoApproveRisk"]);
}

function normalizeAutoApproveRisk(v: ApproveForMeConfig["autoApproveRisk"]): RiskLevel[] {
	if (Array.isArray(v)) return v.filter((x): x is RiskLevel => x === "low" || x === "medium" || x === "high");
	switch (v) {
		case "low":
			return ["low"];
		case "medium":
			return ["medium"];
		case "high":
			return ["high"];
		case "low-medium":
			return ["low", "medium"];
		default:
			return [];
	}
}

export interface ConfigPaths {
	global: string;
	project: string;
}

export function configPaths(cwd: string): ConfigPaths {
	return {
		global: join(getAgentDir(), "permission-control.json"),
		project: join(cwd, ".pi", "permission-control.json"),
	};
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const text = await readFile(path, "utf-8");
		const value = JSON.parse(text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export interface LoadedConfig {
	config: PermissionControlConfig;
	paths: ConfigPaths;
	globalConfig: Record<string, unknown>;
	projectConfig: Record<string, unknown>;
}

/** Load global + project config (project only when allowed) and merge. */
export async function loadConfig(cwd: string, includeProject = true): Promise<LoadedConfig> {
	const paths = configPaths(cwd);
	const globalConfig = (await readJsonFile(paths.global)) ?? {};
	let projectConfig: Record<string, unknown> = {};
	if (includeProject) {
		projectConfig = (await readJsonFile(paths.project)) ?? {};
	}
	let config = defaultConfig();
	config = mergeConfig(config, globalConfig);
	config = mergeConfig(config, projectConfig);
	return { config, paths, globalConfig, projectConfig };
}

/** Write a JSON object to a file atomically (temp + rename). */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	const serialized = JSON.stringify(value, null, 2) + "\n";
	await writeFile(tmp, serialized, { encoding: "utf-8", mode: 0o600 });
	try {
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}

/**
 * Persist a set of rules to a scope's config file atomically.
 * `includeProject` selects project vs global config.
 */
export async function saveRules(
	cwd: string,
	rules: PermissionRules,
	scope: "project" | "global",
): Promise<void> {
	const paths = configPaths(cwd);
	const file = scope === "project" ? paths.project : paths.global;
	const existing = (await readJsonFile(file)) ?? {};
	const next = {
		...existing,
		rules: {
			allowPaths: rules.allowPaths,
			allowCommands: rules.allowCommands,
			allowCapabilities: rules.allowCapabilities,
			allowDomains: rules.allowDomains,
		},
	};
	await writeJsonAtomic(file, next);
}

/**
 * Persist a non-rules config update (mode / policy) atomically, merging into
 * the existing config file without clobbering rules.
 */
export async function saveConfigUpdate(
	cwd: string,
	update: Record<string, unknown>,
	scope: "project" | "global",
): Promise<void> {
	const paths = configPaths(cwd);
	const file = scope === "project" ? paths.project : paths.global;
	const existing = (await readJsonFile(file)) ?? {};
	const next = { ...existing, ...update };
	await writeJsonAtomic(file, next);
}

/** Ensure a default config file exists (idempotent). */
export async function ensureGlobalConfigFile(): Promise<void> {
	const path = join(getAgentDir(), "permission-control.json");
	if (!existsSync(path)) {
		await writeJsonAtomic(path, {});
	}
}

/** Paths that the agent may never modify — the permission layer hard-denies these. */
export function protectedConfigPaths(cwd: string): string[] {
	const paths = configPaths(cwd);
	const home = homedir();
	return [
		paths.global,
		paths.project,
		join(getAgentDir(), "permission-control-rules.json"),
		join(getAgentDir(), "permission-control-audit.jsonl"),
		join(getAgentDir(), "trust.json"),
		join(home, ".pi", "agent", "settings.json"),
		join(cwd, ".pi", "settings.json"),
		join(cwd, ".pi", "SYSTEM.md"),
		join(cwd, ".pi", "APPEND_SYSTEM.md"),
	];
}
