/**
 * sandbox.ts — optional OS-sandbox backend integration via `@landstrip/landstrip`.
 *
 * Design principle: the permission layer (this extension) is the *policy*
 * control plane; `@landstrip/landstrip` is reused as the *enforcement* backend
 * for bash and child processes — we never reimplement an OS sandbox.
 *
 *  - `landstripStatus()` lazily locates the native binary (never required to
 *    load the extension; failure degrades gracefully).
 *  - `buildPolicyJson()` turns the effective policy into a Landstrip policy.
 *  - `preflightFileAccess()` runs the Sandbox Policy preflight for file tools
 *    so file access is always consistent with what the OS sandbox would allow.
 *  - `wrapBashWithLandstrip()` (enabled via config) rewrites an allowed bash
 *    command to run inside `landstrip run -p <policy> -- bash -c '…'`, keeping
 *    Pi's built-in bash tool semantics (cwd, env, timeouts, process-tree kill).
 *
 * Trust model: the main Pi process and this host extension remain the trusted
 * control plane — the model cannot modify this policy file or the extension.
 */

import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionControlConfig } from "./config.ts";
import { isInside } from "./paths.ts";
import type { ApprovedGrant } from "./approvals.ts";

export interface SandboxStatus {
	available: boolean;
	binaryPath?: string;
	error?: string;
}

let cachedStatus: SandboxStatus | undefined;

/** Lazily resolve the @landstrip/landstrip native binary. */
export async function landstripStatus(): Promise<SandboxStatus> {
	if (cachedStatus) return cachedStatus;
	try {
		const ls = (await import("@landstrip/landstrip")) as {
			binaryPath?: (platform?: string, arch?: string) => string;
		};
		if (typeof ls.binaryPath !== "function") {
			cachedStatus = { available: false, error: "@landstrip/landstrip has no binaryPath export" };
			return cachedStatus;
		}
		const bin = ls.binaryPath();
		if (existsSync(bin)) {
			cachedStatus = { available: true, binaryPath: bin };
			return cachedStatus;
		}
		cachedStatus = { available: false, error: `landstrip binary not found at ${bin}` };
	} catch (error) {
		cachedStatus = {
			available: false,
			error: `@landstrip/landstrip not installed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return cachedStatus;
}

export function resetLandstripCache(): void {
	cachedStatus = undefined;
}

// ---------------------------------------------------------------------------
// Effective policy sets (shared by preflight and policy generation)
// ---------------------------------------------------------------------------

export interface EffectivePolicy {
	allowRead: string[];
	denyRead: string[];
	allowWrite: string[];
	denyWrite: string[];
	allowNetwork: boolean;
	allowLocalBinding: boolean;
}

/**
 * Process-runtime endpoints that are safe to expose inside the OS sandbox.
 *
 * `/dev/null` is not persistent storage: writes are discarded and reads return
 * EOF. Git and many shell helpers open it even for otherwise read-only work.
 * Without this exact exception Landstrip's Linux seccomp broker can reject the
 * open before an approved command starts. Never broaden this to all of `/dev`.
 */
function runtimeFilesystemAllowances(): { allowRead: string[]; allowWrite: string[] } {
	if (process.platform === "win32") {
		return { allowRead: [], allowWrite: [] };
	}
	return {
		allowRead: ["/dev/null"],
		allowWrite: ["/dev/null"],
	};
}

export function effectivePolicy(
	config: PermissionControlConfig,
	workspaceRoot: string,
	grants: readonly ApprovedGrant[],
	extra?: { allowRead?: string[]; allowWrite?: string[]; denyRead?: string[]; denyWrite?: string[] },
): EffectivePolicy {
	const runtime = runtimeFilesystemAllowances();
	const allowWrite = new Set<string>(runtime.allowWrite);
	if (config.sandboxMode !== "read-only") {
		allowWrite.add(workspaceRoot);
	}
	for (const p of config.sandbox.allowWrite ?? []) allowWrite.add(p);
	for (const p of extra?.allowWrite ?? []) allowWrite.add(p);

	const allowRead = new Set([
		workspaceRoot,
		...runtime.allowRead,
		...(config.sandbox.allowRead ?? []),
		...(extra?.allowRead ?? []),
	]);
	const denyRead = new Set([...config.sandbox.denyRead, ...(extra?.denyRead ?? [])]);
	const denyWrite = new Set([...config.sandbox.denyWrite, ...(extra?.denyWrite ?? [])]);
	let allowNetwork = config.sandbox.allowNetwork;
	for (const grant of grants) {
		if (grant.pathPrefix) {
			allowRead.add(grant.pathPrefix);
			allowWrite.add(grant.pathPrefix);
		}
		// A network/domain approval enables the sandbox network policy for the
		// session so the OS backend does not contradict the granted access.
		if (grant.capability === "network" || grant.domain) allowNetwork = true;
	}
	return {
		allowRead: [...allowRead],
		denyRead: [...denyRead],
		allowWrite: [...allowWrite],
		denyWrite: [...denyWrite],
		allowNetwork,
		allowLocalBinding: true,
	};
}

/** Same-most-specific-wins semantics as landstrip/pi-landstrip read policy. */
function readAllowed(path: string, policy: EffectivePolicy): boolean {
	let denyDepth = -1;
	for (const d of policy.denyRead) {
		const dp = depth(d, path);
		if (dp >= 0 && dp > denyDepth) denyDepth = dp;
	}
	if (denyDepth < 0) return true;
	let allowDepth = -1;
	for (const a of policy.allowRead) {
		const ap = depth(a, path);
		if (ap >= 0 && ap > allowDepth) allowDepth = ap;
	}
	return allowDepth >= denyDepth; // tie favors allow
}

function depth(base: string, path: string): number {
	const b = normalizeRoot(base);
	const p = normalizeRoot(path);
	if (p === b) return b.length;
	if (p.startsWith(b + "/")) return b.length + 1;
	return -1;
}

function normalizeRoot(p: string): string {
	let out = p.replace(/\/+$/, "");
	if (process.platform === "win32") out = out.toLowerCase();
	return out;
}

// ---------------------------------------------------------------------------
// Sandbox Policy preflight for file tools
// ---------------------------------------------------------------------------

export interface PreflightResult {
	allowed: boolean;
	reason?: string;
}

/**
 * Preflight a file access against the effective OS-sandbox policy. The
 * permission layer already decided the *policy* verdict; this confirms the
 * OS sandbox backend would agree (defense in depth, especially important when
 * bash is sandboxed with the same policy).
 */
export function preflightFileAccess(
	config: PermissionControlConfig,
	workspaceRoot: string,
	grants: readonly ApprovedGrant[],
	operation: "read" | "write",
	realPath: string,
	extra?: { denyRead?: string[]; denyWrite?: string[] },
): PreflightResult {
	const policy = effectivePolicy(config, workspaceRoot, grants, extra);
	if (operation === "write") {
		if (policy.denyWrite.some((d) => isInside(d, realPath))) {
			return { allowed: false, reason: `sandbox denyWrite blocks ${realPath}` };
		}
		if (!policy.allowWrite.some((a) => isInside(a, realPath))) {
			return { allowed: false, reason: `sandbox allowWrite does not cover ${realPath}` };
		}
		return { allowed: true };
	}
	if (policy.denyRead.some((d) => isInside(d, realPath)) && !policy.allowRead.some((a) => isInside(a, realPath))) {
		return { allowed: false, reason: `sandbox denyRead blocks ${realPath}` };
	}
	return readAllowed(realPath, policy) ? { allowed: true } : { allowed: false, reason: `sandbox read policy blocks ${realPath}` };
}

// ---------------------------------------------------------------------------
// Landstrip policy file + bash wrapper
// ---------------------------------------------------------------------------

/**
 * One landstrip policy file per session, rewritten when grants change and
 * removed on session shutdown. Keeps bash wrapping cheap and leak-free.
 */
export class SessionPolicy {
	private dir: string | null = null;
	private _path: string | null = null;
	private _config: PermissionControlConfig;
	private _workspaceRoot: string;

	constructor(config: PermissionControlConfig, workspaceRoot: string) {
		this._config = config;
		this._workspaceRoot = workspaceRoot;
	}

	get path(): string | null {
		return this._path;
	}

	async ensure(grants: readonly ApprovedGrant[]): Promise<string | null> {
		const status = await landstripStatus();
		if (!status.available || !status.binaryPath) return null;
		if (!this.dir) {
			this.dir = await mkdtemp(join(tmpdir(), "perm-control-"));
			this._path = join(this.dir, "policy.json");
		}
		const target = this._path;
		if (!target) return null;
		const policy = effectivePolicy(this._config, this._workspaceRoot, grants);
		const json = {
			filesystem: {
				allowRead: policy.allowRead,
				denyRead: policy.denyRead,
				allowWrite: policy.allowWrite,
				denyWrite: policy.denyWrite,
			},
			network: {
				allowNetwork: policy.allowNetwork,
				allowLocalBinding: policy.allowLocalBinding,
				allowAllUnixSockets: false,
				allowUnixSockets: [],
				httpProxyPort: null,
			},
			windows: {
				appContainerMode: "lpac",
				allowLoopback: policy.allowLocalBinding,
			},
		};
		await writeFile(target, JSON.stringify(json, null, 2), { encoding: "utf-8", mode: 0o600 });
		return target;
	}

	async dispose(): Promise<void> {
		if (this.dir) {
			try {
				await rm(this.dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
		this.dir = null;
		this._path = null;
	}
}

/** Single-quote a string for insertion into a `bash -c '…'` argument. */
function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap an allowed command so it runs inside the landstrip sandbox:
 *
 *   landstrip run -p <policy> -- bash -c '<command>'
 *
 * Returns null when the sandbox backend is unavailable or disabled.
 */
export async function wrapBashWithLandstrip(
	command: string,
	policyPath: string | null,
	status: SandboxStatus,
): Promise<string | null> {
	if (!policyPath || !status.available || !status.binaryPath) return null;
	return `${status.binaryPath} run -p ${shellSingleQuote(policyPath)} -- bash -c ${shellSingleQuote(command)}`;
}
