/**
 * paths.ts — path normalization, symlink resolution, workspace containment,
 * and sensitive-path classification for the permission-control extension.
 *
 * Everything here is a *policy* concern. Paths are normalized to absolute
 * form, `~` is expanded, relative paths are resolved against a base (cwd),
 * and symlinks are resolved so that `workspace/../secret` or a symlink
 * pointing outside the workspace is treated as the real target path.
 */

import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep, dirname, basename } from "node:path";
import { realpath, lstat } from "node:fs/promises";

export type PathClass =
	| "in-workspace" // inside the workspace root
	| "out-of-workspace" // outside the workspace root (needs ask)
	| "sensitive" // soft-sensitive: ask by default
	| "hard-deny"; // non-overridable deny (cannot be approved around)

/** Default paths that can never be approved around. */
export const DEFAULT_HARD_DENY_PATHS: readonly string[] = [
	"~/.ssh", // SSH keys/config
	"~/.gnupg", // GPG keyrings
	"~/.aws/credentials",
	"~/.aws/config",
	"~/.config/gh/hosts.yml",
	"~/.config/gcloud",
	"~/.kube/config",
	"~/.netrc",
	"~/.npmrc", // often contains registry tokens
	"~/.env",
	// Pi's own permission/trust configuration must not be modified by the agent.
	"~/.pi/agent/permission-control.json",
	"~/.pi/agent/permission-control-rules.json",
	"~/.pi/agent/permission-control-audit.jsonl",
	"~/.pi/agent/trust.json",
];

/** Default soft-sensitive paths: ask (promptable) unless promoted to hard deny. */
export const DEFAULT_SENSITIVE_PATHS: readonly string[] = [
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
	"**/*.secret",
	"**/token",
	"**/.git/config",
];

const HOME = homedir();

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHome(p: string): string {
	if (p === "~") return HOME;
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(HOME, p.slice(2));
	return p;
}

/** Turn a user-supplied path into an absolute, normalized path. */
export function toAbsolute(p: string, base: string): string {
	const expanded = expandHome(String(p ?? ""));
	if (isAbsolute(expanded)) return normalize(expanded);
	return resolve(base, expanded);
}

/**
 * Resolve a path to its real (symlink-free) form.
 * For non-existent paths (e.g. a file that is about to be created) resolves
 * the deepest existing ancestor and re-appends the missing tail.
 */
export async function realpathSafe(p: string): Promise<string> {
	const absolute = normalize(p);
	try {
		const resolved = await realpath(absolute);
		return resolved;
	} catch {
		// Walk up until we find an existing ancestor, resolve it, then re-append.
		let tail = "";
		let current = absolute;
		for (;;) {
			try {
				const resolved = await realpath(current);
				return tail ? join(resolved, tail) : resolved;
			} catch {
				const parent = dirname(current);
				if (parent === current) return absolute;
				tail = tail ? join(basename(current), tail) : basename(current);
				current = parent;
			}
		}
	}
}

/** Path containment: is `child` inside `parent` (or equal)? Case-insensitive on Windows. */
export function isInside(parent: string, child: string): boolean {
	const p = normalize(parent).replace(/[\\/]+$/, "");
	const c = normalize(child);
	if (c === p) return true;
	const prefix = process.platform === "win32" ? p.toLowerCase() : p;
	const candidate = process.platform === "win32" ? c.toLowerCase() : c;
	return candidate === prefix || candidate.startsWith(prefix + sep);
}

/** A configured path pattern from config. Supports `~`, absolute, and glob-ish `**` prefixes. */
export interface PathRule {
	readonly raw: string;
	readonly absolute: string; // expanded absolute form (for simple rules)
	readonly glob: boolean; // true when the rule contains glob characters
}

export function compilePathRule(raw: string, cwd: string): PathRule {
	const expanded = expandHome(raw);
	const hasGlob = /[*?[\]{}]/.test(expanded);
	return { raw, absolute: hasGlob ? expanded : normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded)), glob: hasGlob };
}

/**
 * Match an absolute real path against a set of path rules.
 * Simple rules use prefix containment; glob rules are matched with a small
 * `**`-aware matcher (a leading `**` followed by a slash matches any directory depth).
 */
export function matchesPathRule(path: string, rules: readonly PathRule[]): boolean {
	const normalized = normalize(path);
	for (const rule of rules) {
		if (!rule.glob) {
			if (isInside(rule.absolute, normalized)) return true;
			continue;
		}
		if (globMatch(normalized, rule.absolute)) return true;
	}
	return false;
}

/** Minimal glob matcher supporting `*`, `?`, and `**` (no char classes). */
function globMatch(input: string, pattern: string): boolean {
	// Convert the pattern into a regex.
	let regex = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i]!;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				// `**` — if followed by `/`, matches zero or more directories.
				if (pattern[i + 2] === "/") {
					regex += "(?:.*/)?";
					i += 3;
					continue;
				}
				regex += ".*";
				i += 2;
				continue;
			}
			regex += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			regex += "[^/]";
			i += 1;
			continue;
		}
		regex += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		i += 1;
	}
	return new RegExp(`^${regex}$`).test(input.replace(/\/+$/, ""));
}

/** Try to resolve symlinks so we never evaluate a path by its spelling alone. */
export async function resolveForPolicy(p: string, base: string): Promise<string> {
	return realpathSafe(toAbsolute(p, base));
}

/**
 * Classify a path against the policy rules.
 *
 * @param absPath already-normalized absolute path (realpath recommended)
 * @param workspaceRoot realpath'd workspace root
 * @param hardDenyRules compiled hard-deny path rules
 * @param sensitiveRules compiled sensitive path rules
 */
export async function classifyPath(
	absPath: string,
	workspaceRoot: string,
	hardDenyRules: readonly PathRule[],
	sensitiveRules: readonly PathRule[],
): Promise<PathClass> {
	if (matchesPathRule(absPath, hardDenyRules)) return "hard-deny";
	if (matchesPathRule(absPath, sensitiveRules)) return "sensitive";
	if (isInside(workspaceRoot, absPath)) return "in-workspace";
	return "out-of-workspace";
}

/** Convenience: does the (real) path match any compiled hard-deny rule? */
export function isHardDenied(absPath: string, hardDenyRules: readonly PathRule[]): boolean {
	return matchesPathRule(absPath, hardDenyRules);
}
