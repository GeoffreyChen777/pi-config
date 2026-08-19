/**
 * bash.ts — structured, conservative analysis of bash commands.
 *
 * The permission layer must not trust a raw command string. This module:
 *
 *  - lexes the command with a shell-aware tokenizer (single/double quotes,
 *    `\` escapes, comments). Unbalanced/underivable input fails parsing.
 *  - recursively decomposes pipelines (`|`), `&&`, `||`, `;`, newlines,
 *    background `&`, redirects, `bash -c`/`sh -c`/`env`/`sudo`/`xargs`
 *    wrappers and command substitution `$(...)`/backticks.
 *  - classifies each leaf command (network, dangerous, privileged, safe)
 *    and extracts path operands for workspace/sensitive checks.
 *
 * When anything cannot be parsed reliably, the analyzer returns
 * `parseable: false` and the policy layer treats the command as `ask`
 * (conservative fail-closed) rather than guessing.
 */

export type OperandKind = "read" | "write" | "unknown";

export interface PathOperand {
	/** raw token as it appeared in the command line */
	readonly raw: string;
	/** absolute, normalized path (base = command cwd) */
	readonly abs: string;
	readonly kind: OperandKind;
}

export interface SubCommandAnalysis {
	/** argv of the leaf command (wrapper prefixes already stripped) */
	readonly argv: readonly string[];
	/** executable name (basename, lowercase) */
	readonly exe: string;
	readonly privileged: boolean; // sudo / su
	readonly network: boolean;
	readonly dangerous: boolean;
	readonly paths: readonly PathOperand[];
	/** nested command string (from bash -c / substitution), analyzed recursively */
	readonly nested?: BashAnalysis;
	readonly unparseable: boolean;
}

export interface BashAnalysis {
	readonly parseable: boolean;
	readonly subCommands: readonly SubCommandAnalysis[];
	// Aggregated flags (OR across all leaves + nested commands).
	readonly privileged: boolean;
	readonly network: boolean;
	readonly dangerous: boolean;
	readonly hasOutOfWorkspacePaths: boolean;
	readonly hasSensitivePaths: boolean;
	readonly hasHardDenyPaths: boolean;
	/** any explicit write-ish path operand inside the workspace */
	readonly hasInWorkspaceWrites: boolean;
	readonly anyInWorkspacePath: boolean;
	readonly error?: string;
}

// ---------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------

const NETWORK_COMMANDS = new Set([
	"curl", "wget", "aria2c", "ftp", "sftp", "scp", "rsync", "ssh", "telnet", "nc", "ncat",
	"netcat", "nslookup", "dig", "host", "whois", "ping", "traceroute", "tracepath", "mtr",
	"git", // fetch/push/clone are network; non-network git is classified below
	"npm", "npx", "pnpm", "yarn", "bunx", "deno", "cargo", "go", "pip", "pip3", "pipx",
	"uv", "poetry", "conda", "mamba", "brew", "apt", "apt-get", "dnf", "yum", "apk",
	"docker", "podman", "kubectl", "helm", "gh", "glab", "aws", "gcloud", "az",
	"jupyter", "nbqa", "uvx",
]);

const DANGEROUS_COMMANDS = new Set([
	"rm", "rmdir", "mv", "dd", "mkfs", "mkfs.ext4", "mkfs.ext2", "mkfs.xfs", "mkfs.btrfs",
	"fdisk", "parted", "gdisk", "sfdisk", "mount", "umount", "shred", "wipefs",
	"chmod", "chown", "chgrp", "setfacl", "usermod", "useradd", "userdel", "groupadd",
	"passwd", "chpasswd", "visudo", "sudoers", "iptables", "nft", "ip6tables",
	"route", "ip", "tc", "reboot", "shutdown", "halt", "poweroff", "init", "systemctl",
	"kill", "pkill", "killall", "xkill", "renice", "prlimit",
	"truncate", "fallocate", "mkswap", "swapon", "swapoff",
	"tcpdump", "ettercap", "aireplay-ng",
]);

const SAFE_INSPECTION_COMMANDS = new Set([
	"ls", "cat", "head", "tail", "less", "more", "grep", "rg", "rgrep", "find", "locate",
	"wc", "sort", "uniq", "cut", "awk", "sed", "tr", "diff", "git", "stat", "file",
	"echo", "printf", "true", "false", "test", "[", "basename", "dirname", "readlink",
	"realpath", "pwd", "which", "type", "man", "help", "env", "export", "uname", "date",
	"whoami", "id", "groups", "hostname", "uptime", "ps", "top", "htop", "jobs",
	"node", "python", "python3", "tsc", "eslint", "prettier", "make", "cmake", "ninja",
	"gcc", "g++", "clang", "go", "cargo", "npm", "npx", "pnpm", "yarn", "vitest", "jest",
	"mocha", "bun", "deno", "java", "javac", "mvn", "gradle", "ruby", "rake", "php",
	"lua", "perl", "sqlite3", "redis-cli", "psql", "mysql", "mongosh",
	"tar", "gzip", "gunzip", "zip", "unzip", "xz", "bzip2", "zstd", "7z",
]);

const WRITE_REDIRECT_OPS = new Set([">", ">>", "2>", "2>>", "&>", "&>>", "<>", ">|"]);

/** Commands whose sole purpose is modifying the current shell (must not run in sandbox sub-shell). */
const SHELL_BUILTIN_NOOPS = new Set(["source", ".", "alias", "unset", "shopt", "set", "cd", "pushd", "popd"]);

function isNetworkCommand(exe: string): boolean {
	if (NETWORK_COMMANDS.has(exe)) return true;
	// git subcommands that touch the network
	if (exe === "git") return true; // conservatively classify git as network-capable
	return false;
}

function isDangerousCommand(exe: string): boolean {
	return DANGEROUS_COMMANDS.has(exe);
}

function isSafeInspection(exe: string): boolean {
	return SAFE_INSPECTION_COMMANDS.has(exe);
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

export interface Token {
	readonly value: string;
	readonly isRedirect: boolean;
	readonly isPipe: boolean;
	readonly isAnd: boolean;
	readonly isOr: boolean;
	readonly isSemi: boolean;
	readonly isBg: boolean;
	readonly isCommandSub: boolean; // $(...) or `...`
}

/**
 * Shell-aware tokenizer. Returns `null` when the input cannot be tokenized
 * (unbalanced quotes, unterminated substitutions, etc.) — the caller must
 * fail closed.
 */
export function tokenize(command: string): Token[] | null {
	const tokens: Token[] = [];
	let i = 0;
	const n = command.length;
	let inSingle = false;
	let inDouble = false;
	let comment = false;
	let current = "";
	let currentIsRedirect = false;
	let subDepth = 0;

	const flush = (isRedirect = false, isPipe = false, isAnd = false, isOr = false, isSemi = false, isBg = false) => {
		if (current.length > 0 || isPipe || isAnd || isOr || isSemi || isBg) {
			tokens.push({
				value: current,
				isRedirect: isRedirect || currentIsRedirect,
				isPipe,
				isAnd,
				isOr,
				isSemi,
				isBg,
				isCommandSub: false,
			});
			current = "";
			currentIsRedirect = false;
		}
	};

	while (i < n) {
		const ch = command[i]!;
		if (comment) {
			i += 1;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else current += ch;
			i += 1;
			continue;
		}
		if (inDouble) {
			if (ch === '"') inDouble = false;
			else current += ch;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			// escaped char (also escapes newlines)
			const next = command[i + 1];
			if (next !== undefined) current += next;
			i += 2;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			i += 1;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(command[i - 1]!))) {
			comment = true;
			i += 1;
			continue;
		}
		if (ch === "\n" || ch === "\r") {
			flush(false, false, false, false, true);
			i += 1;
			continue;
		}
		if (ch === "&") {
			if (command[i + 1] === "&") {
				flush(false, false, true);
				i += 2;
				continue;
			}
			flush(false, false, false, false, false, true);
			i += 1;
			continue;
		}
		if (ch === "|") {
			if (command[i + 1] === "|") {
				flush(false, false, false, true);
				i += 2;
				continue;
			}
			flush(false, true);
			i += 1;
			continue;
		}
		if (ch === ";") {
			flush(false, false, false, false, true);
			i += 1;
			continue;
		}
		if (ch === "(" && command[i + 1] === "$") {
			// $(
			flush(false, false, false, false, false, false);
			tokens.push({ value: "", isRedirect: false, isPipe: false, isAnd: false, isOr: false, isSemi: false, isBg: false, isCommandSub: true });
			subDepth += 1;
			i += 2;
			// collect until matching ')'
			let depth = 0;
			let body = "";
			let done = false;
			while (i < n) {
				const c = command[i]!;
				if (c === "(") depth += 1;
				else if (c === ")") {
					if (depth === 0) {
						done = true;
						i += 1;
						break;
					}
					depth -= 1;
				}
				body += c;
				i += 1;
			}
			if (!done) return null; // unterminated $(
			// recursively tokenize body and emit as a substitution token value
			tokens.push({ value: body, isRedirect: false, isPipe: false, isAnd: false, isOr: false, isSemi: false, isBg: false, isCommandSub: true });
			continue;
		}
		if (ch === "`") {
			// backtick substitution: collect until closing backtick
			flush(false, false, false, false, false, false);
			let body = "";
			let done = false;
			i += 1;
			while (i < n) {
				const c = command[i]!;
				if (c === "\\") {
					const next = command[i + 1];
					if (next !== undefined) body += next;
					i += 2;
					continue;
				}
				if (c === "`") {
					done = true;
					i += 1;
					break;
				}
				body += c;
				i += 1;
			}
			if (!done) return null;
			tokens.push({ value: body, isRedirect: false, isPipe: false, isAnd: false, isOr: false, isSemi: false, isBg: false, isCommandSub: true });
			continue;
		}
		if (ch === "(") {
			// subshell ( ... ) — treat the group as an opaque conservative block
			let depth = 0;
			let body = "";
			let done = false;
			while (i < n) {
				const c = command[i]!;
				if (c === "(") depth += 1;
				else if (c === ")") {
					if (depth === 0) {
						done = true;
						i += 1;
						break;
					}
					depth -= 1;
				}
				body += c;
				i += 1;
			}
			if (!done) return null;
			tokens.push({ value: body, isRedirect: false, isPipe: false, isAnd: false, isOr: false, isSemi: false, isBg: false, isCommandSub: true });
			continue;
		}
		if (ch === ">" || ch === "<") {
			// redirect operator (handle >>, 2>, &>, >|, 2>&1 ...)
			let op = ch;
			if ((ch === ">" && command[i + 1] === ">") || (ch === "<" && command[i + 1] === "<")) {
				op += command[i + 1]!;
				i += 2;
			} else if (ch === ">" && command[i + 1] === "|") {
				op = ">|";
				i += 2;
			} else if (ch === ">" && command[i + 1] === "&") {
				op = ">&";
				i += 2;
			} else {
				i += 1;
			}
			flush();
			tokens.push({ value: op, isRedirect: true, isPipe: false, isAnd: false, isOr: false, isSemi: false, isBg: false, isCommandSub: false });
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			i += 1;
			continue;
		}
		// check for numbered fd redirects like 2> 
		if (/^[0-9]+$/.test(ch) && (command[i + 1] === ">" || command[i + 1] === "<")) {
			current += ch;
			i += 1;
			continue;
		}
		current += ch;
		i += 1;
	}
	if (inSingle || inDouble) return null; // unbalanced quotes
	flush();
	if (subDepth > 0) return null;
	return tokens;
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

function isWrapper(exe: string): boolean {
	return exe === "env" || exe === "nohup" || exe === "nice" || exe === "timeout" || exe === "setsid" || exe === "stdbuf" || exe === "xargs" || exe === "sudo" || exe === "su" || exe === "command" || exe === "bash" || exe === "sh" || exe === "zsh" || exe === "fish" || exe === "dash" || exe === "ksh";
}

const NESTED_WRAPPERS = new Set(["env", "nohup", "nice", "timeout", "setsid", "stdbuf", "xargs", "command", "bash", "sh", "zsh", "fish", "dash", "ksh"]);

function basenameOf(p: string): string {
	const cleaned = p.replace(/^["']+|["']+$/g, "");
	const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
	return base.toLowerCase();
}

function looksLikePath(token: string): boolean {
	if (token.startsWith("-")) return false;
	if (token.includes("=")) {
		// only treat as path if it looks like a file-ish value (rare); skip env assignments
		return false;
	}
	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return false; // plain word (could be a command name or option value)
	if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~/")) return true;
	if (/^[\w.-]+(\/[\w.@-]+)+/.test(token)) return true; // contains a slash
	return false;
}

/** Extract path operands from an argv slice, honoring `--` separators and obvious options. */
function extractPathOperands(argv: readonly string[], cwd: string, mode: "read" | "write"): PathOperand[] {
	const out: PathOperand[] = [];
	let seenDoubleDash = false;
	let skipNext = false;
	let inFlagArg = false;
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i]!;
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (tok === "--") {
			seenDoubleDash = true;
			continue;
		}
		if (!seenDoubleDash && tok.startsWith("-")) {
			// -o file / -f file style: the next token is often a path
			if (/^-[a-zA-Z]+[oOfF]?$/.test(tok) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
				inFlagArg = true;
				continue;
			}
			continue;
		}
		if (inFlagArg) {
			inFlagArg = false;
			if (looksLikePath(tok)) out.push({ raw: tok, abs: tok, kind: mode });
			continue;
		}
		if (looksLikePath(tok)) {
			out.push({ raw: tok, abs: tok, kind: mode });
		}
	}
	return out.map((p) => ({ ...p, abs: p.abs } as PathOperand));
}

/** Analyze a sequence of tokens, splitting into top-level commands. */
export function analyzeTokens(tokens: readonly Token[], cwd: string): BashAnalysis {
	const subCommands: SubCommandAnalysis[] = [];
	let privileged = false;
	let network = false;
	let dangerous = false;
	let hasOutOfWorkspacePaths = false;
	let hasSensitivePaths = false;
	let hasHardDenyPaths = false;
	let hasInWorkspaceWrites = false;
	let anyInWorkspacePath = false;
	let parseable = true;

	const mergeNested = (nested: BashAnalysis | undefined) => {
		if (!nested) return;
		if (!nested.parseable) parseable = false;
		privileged = privileged || nested.privileged;
		network = network || nested.network;
		dangerous = dangerous || nested.dangerous;
		hasOutOfWorkspacePaths = hasOutOfWorkspacePaths || nested.hasOutOfWorkspacePaths;
		hasSensitivePaths = hasSensitivePaths || nested.hasSensitivePaths;
		hasHardDenyPaths = hasHardDenyPaths || nested.hasHardDenyPaths;
		hasInWorkspaceWrites = hasInWorkspaceWrites || nested.hasInWorkspaceWrites;
		anyInWorkspacePath = anyInWorkspacePath || nested.anyInWorkspacePath;
	};

	// Split into simple-command token groups.
	let current: Token[] = [];
	const groups: Token[][] = [];
	for (const tok of tokens) {
		if (tok.isPipe || tok.isAnd || tok.isOr || tok.isSemi || tok.isBg) {
			groups.push(current);
			current = [];
		} else {
			current.push(tok);
		}
	}
	groups.push(current);

	for (const group of groups) {
		if (group.length === 0) continue;

		// A command substitution alone in a group: analyze it as a nested command.
		const subs = group.filter((t) => t.isCommandSub);
		if (subs.length > 0) {
			for (const sub of subs) {
				const nested = analyzeCommand(sub.value, cwd);
				mergeNested(nested);
			}
		}
		const words = group.filter((t) => !t.isCommandSub && !t.isRedirect);
		const redirects = group.filter((t) => t.isRedirect);
		if (words.length === 0) {
			// only redirects/substitutions
			if (subs.length === 0) continue;
			continue;
		}

		// Detect command substitution tokens nested inside plain words (rare; be conservative).
		for (const tok of group) {
			if (tok.isCommandSub && tok.value) {
				mergeNested(analyzeCommand(tok.value, cwd));
			}
		}

		// Build argv, peeling wrappers.
		let argv = words.map((w) => w.value).filter((v) => v !== undefined && v !== null) as string[];
		// env-assignment prefix (VAR=value ...)
		let idx = 0;
		while (idx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[idx]!)) idx += 1;
		argv = argv.slice(idx);

		if (argv.length === 0) continue;

		// Resolve nested wrappers recursively.
		const resolved = resolveWrapper(argv, cwd);
		const exe = basenameOf(resolved.argv[0] ?? "");

		// Redirect targets are write operands.
		let redirectTargets: string[] = [];
		for (let r = 0; r < redirects.length; r++) {
			const rtok = redirects[r]!;
			if (WRITE_REDIRECT_OPS.has(rtok.value) && r + 1 < redirects.length) {
				redirectTargets.push(redirects[r + 1]!.value);
				r += 1;
			}
		}

		// Redirect targets are write operands; other path-like args are reads.
		const operands: PathOperand[] = [];
		for (const t of redirectTargets) {
			operands.push({ raw: t, abs: t, kind: "write" });
		}
		operands.push(...extractPathOperands(resolved.argv.slice(1), cwd, "read"));

		const sub: SubCommandAnalysis = {
			argv: resolved.argv,
			exe,
			privileged: resolved.privileged,
			network: isNetworkCommand(exe),
			dangerous: isDangerousCommand(exe),
			paths: operands,
			nested: resolved.nested,
			unparseable: false,
		};

		mergeNested(resolved.nested);
		privileged = privileged || sub.privileged;
		network = network || sub.network;
		dangerous = dangerous || sub.dangerous;

		subCommands.push(sub);

		// Mark raw flags for out-of-workspace/sensitive; real resolution happens in policy.ts.
		for (const op of operands) {
			const abs = op.abs;
			if (isWorkspaceHint(abs, cwd)) {
				anyInWorkspacePath = true;
				if (op.kind === "write") hasInWorkspaceWrites = true;
			} else if (abs.startsWith("/") || abs.startsWith("~/")) {
				hasOutOfWorkspacePaths = true;
			}
		}
	}

	return {
		parseable,
		subCommands,
		privileged,
		network,
		dangerous,
		hasOutOfWorkspacePaths,
		hasSensitivePaths,
		hasHardDenyPaths,
		hasInWorkspaceWrites,
		anyInWorkspacePath,
	};
}

/** Rough workspace hint: is the raw absolute path inside cwd's tree? (realpath done later) */
function isWorkspaceHint(abs: string, cwd: string): boolean {
	if (abs.startsWith("/") || abs.startsWith("~/")) {
		return false; // absolute outside cwd spelling — resolved later by policy
	}
	if (abs.startsWith("./") || abs.startsWith("../")) return true;
	return false;
}

interface ResolvedWrapper {
	argv: readonly string[];
	privileged: boolean;
	nested?: BashAnalysis;
}

/**
 * Peel wrapper commands (env / sudo / xargs / bash -c ...) recursively.
 * Returns the innermost argv plus flags and any nested analysis.
 */
function resolveWrapper(argv: readonly string[], cwd: string): ResolvedWrapper {
	let rest = [...argv];
	let privileged = false;
	let nested: BashAnalysis | undefined;
	const exe0 = basenameOf(rest[0] ?? "");
	if (!isWrapper(exe0)) return { argv: rest, privileged, nested };

	if (exe0 === "sudo" || exe0 === "su") {
		privileged = true;
		rest = rest.slice(1);
		// sudo -u user cmd ... / sudo --preserve-env cmd ...
		while (rest.length > 0 && rest[0]!.startsWith("-")) rest = rest.slice(1);
		// su: `su user -c "cmd"` or `su - user -c "cmd"`
		if (exe0 === "su") {
			const dashIdx = rest.indexOf("-c");
			if (dashIdx >= 0 && dashIdx + 1 < rest.length) {
				nested = analyzeCommand(rest[dashIdx + 1]!, cwd);
				rest = rest.slice(dashIdx + 2);
			}
		}
		if (rest.length === 0) return { argv: rest, privileged, nested };
		const inner = resolveWrapper(rest, cwd);
		return {
			argv: inner.argv,
			privileged: privileged || inner.privileged,
			nested: inner.nested ? inner.nested : nested,
		};
	}

	if (exe0 === "env" || exe0 === "nohup" || exe0 === "nice" || exe0 === "timeout" || exe0 === "setsid" || exe0 === "stdbuf" || exe0 === "command") {
		rest = rest.slice(1);
		// skip option flags and their values (env -i VAR=..., timeout 10 cmd, nice -n 5 cmd)
		let i = 0;
		while (i < rest.length && rest[i]!.startsWith("-")) i += 1;
		// skip VAR=value pairs
		while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i]!)) i += 1;
		rest = rest.slice(i);
		if (rest.length === 0) return { argv: rest, privileged, nested };
		const inner = resolveWrapper(rest, cwd);
		return { argv: inner.argv, privileged: privileged || inner.privileged, nested: inner.nested };
	}

	if (exe0 === "xargs") {
		// xargs [-I {}] [-n N] [cmd ...] — the command after options is the target
		rest = rest.slice(1);
		let i = 0;
		while (i < rest.length && rest[i]!.startsWith("-")) {
			if (rest[i]!.startsWith("-I") || rest[i]!.startsWith("-n") || rest[i]!.startsWith("--max-args") || rest[i]!.startsWith("-P") || rest[i]!.startsWith("--max-procs")) {
				i += 2;
				continue;
			}
			i += 1;
		}
		rest = rest.slice(i);
		if (rest.length === 0) return { argv: [], privileged, nested };
		const inner = resolveWrapper(rest, cwd);
		return { argv: inner.argv, privileged: privileged || inner.privileged, nested: inner.nested };
	}

	// bash/sh/zsh/dash/fish/ksh -c "command" [args...]
	if (NESTED_WRAPPERS.has(exe0)) {
		const rest2 = rest.slice(1);
		const cIdx = rest2.indexOf("-c");
		if (cIdx >= 0 && cIdx + 1 < rest2.length) {
			nested = analyzeCommand(rest2[cIdx + 1]!, cwd);
			// remaining argv after the -c command string
			const remaining = rest2.slice(cIdx + 2).filter((a) => a !== "--");
			return {
				argv: remaining.length > 0 ? [basenameOf(remaining[0]!), ...remaining.slice(1)] : [],
				privileged,
				nested,
			};
		}
		// `bash script.sh` — treat the script as the command
		const script = rest2.find((a) => !a.startsWith("-") && !a.startsWith("--"));
		if (script) return { argv: [basenameOf(script)], privileged, nested };
		return { argv: [], privileged, nested };
	}

	return { argv: rest, privileged, nested };
}

/**
 * Analyze a bash command string. Conservative: returns parseable=false on
 * lexer failure or empty input.
 */
export function analyzeCommand(command: string, cwd: string): BashAnalysis {
	if (typeof command !== "string" || command.trim().length === 0) {
		return emptyAnalysis(false, "empty command");
	}
	const tokens = tokenize(command);
	if (!tokens) {
		return emptyAnalysis(false, "unparseable command (lexer)");
	}
	return analyzeTokens(tokens, cwd);
}

function emptyAnalysis(parseable: boolean, error?: string): BashAnalysis {
	return {
		parseable,
		subCommands: [],
		privileged: false,
		network: false,
		dangerous: false,
		hasOutOfWorkspacePaths: false,
		hasSensitivePaths: false,
		hasHardDenyPaths: false,
		hasInWorkspaceWrites: false,
		anyInWorkspacePath: false,
		error,
	};
}
