import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import type { SubagentSessionHandle } from "./session.ts";
import {
	ENV_AGENT,
	ENV_CHANNEL_ROOT,
	ENV_CHILD_INDEX,
	ENV_ROLE,
	ENV_RUN_ID,
	ROLE_CHILD,
	channelDir,
	ensureDir,
} from "./message.ts";

// ============================================================================
// Subagent spawn (isolated `pi --mode json -p` process)
// ============================================================================

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Array<{ role: string; content?: unknown; [k: string]: unknown }>;
	stderr: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface SpawnOptions {
	agent: AgentConfig;
	task: string;
	cwd?: string;
	messageRoot: string;
	runId: string;
	childIndex: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface InteractiveSpawnOptions extends SpawnOptions {
	onSession?: (session: SubagentSessionHandle) => void;
	onEvent?: (event: any) => void;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const FORCE_KILL_DELAY_MS = 5000;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<string> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

export function getFinalOutput(messages: SingleResult["messages"]): string {
	let out = "";
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const content = msg.content;
		if (Array.isArray(content)) {
			for (const block of content as Array<{ type?: string; text?: string }>) {
				if (block.type === "text" && block.text) out += block.text;
			}
		} else if (typeof content === "string") {
			out += content;
		}
	}
	return out.trim();
}

/**
 * Spawn a conversational RPC-backed subagent run. Unlike the legacy JSON
 * one-shot process, this keeps one in-memory session alive for the duration of
 * the task so the main TUI can attach, stream events, steer it, and return to
 * main without losing the subagent's context.
 */
export async function spawnInteractiveSubagent(opts: InteractiveSpawnOptions): Promise<SingleResult> {
	const { agent, task, cwd, messageRoot, runId, childIndex, signal } = opts;
	const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
	};

	let tmpPromptPath: string | null = null;
	let client: RpcClient | undefined;
	let unsubscribe: (() => void) | undefined;
	let abortHandler: (() => void) | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	let wasAborted = false;
	const sessionListeners = new Set<(event: any) => void>();

	const emitSessionEvent = (event: any) => {
		for (const listener of sessionListeners) {
			try {
				listener(event);
			} catch {
				/* one overlay listener must not break the run */
			}
		}
	};

	try {
		const args: string[] = ["--no-session"];
		if (agent.thinking) args.push("--thinking", agent.thinking);
		const tools = agent.tools ? [...agent.tools] : [];
		for (const tool of ["send_message", "read_inbox", "reply_message"]) {
			if (!tools.includes(tool)) tools.push(tool);
		}
		if (tools.length > 0) args.push("--tools", tools.join(","));
		if (agent.systemPrompt.trim()) {
			tmpPromptPath = await writePromptToTempFile(agent.name, agent.systemPrompt);
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) env[key] = value;
		}
		env[ENV_ROLE] = ROLE_CHILD;
		env[ENV_CHANNEL_ROOT] = messageRoot;
		env[ENV_RUN_ID] = runId;
		env[ENV_AGENT] = agent.name;
		env[ENV_CHILD_INDEX] = String(childIndex);
		ensureDir(channelDir(messageRoot, runId, agent.name, childIndex));

		const currentScript = process.argv[1];
		const cliPath =
			currentScript && fs.existsSync(currentScript)
				? currentScript
				: path.join(getPackageDir(), "dist", "cli.js");
		client = new RpcClient({
			cliPath,
			cwd: cwd ?? process.cwd(),
			env,
			model: agent.model,
			args,
		});

		unsubscribe = client.onEvent((event: any) => {
			opts.onEvent?.(event);
			emitSessionEvent(event);
			if (event?.type === "message_end" && event.message) {
				const message = event.message;
				result.messages.push(message);
				if (message.role === "assistant") {
					result.usage.turns++;
					const usage = message.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
						result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!result.model && message.model) result.model = message.model;
					if (message.stopReason) result.stopReason = message.stopReason;
					if (message.errorMessage) result.errorMessage = message.errorMessage;
				}
			}
		});

		await client.start();
		const activeClient = client;
		let acceptInitialPrompt!: () => void;
		let rejectInitialPrompt!: (error: unknown) => void;
		const initialPromptAccepted = new Promise<void>((resolve, reject) => {
			acceptInitialPrompt = resolve;
			rejectInitialPrompt = reject;
		});
		void initialPromptAccepted.catch(() => {});
		const session: SubagentSessionHandle = {
			agent: agent.name,
			getMessages: () => activeClient.getMessages(),
			isStreaming: async () => (await activeClient.getState()).isStreaming,
			send: async (message: string) => {
				await initialPromptAccepted;
				const state = await activeClient.getState();
				if (state.isStreaming) await activeClient.steer(message);
				else await activeClient.prompt(message);
			},
			abort: () => activeClient.abort(),
			subscribe: (listener) => {
				sessionListeners.add(listener);
				return () => sessionListeners.delete(listener);
			},
		};
		opts.onSession?.(session);

		const timeout = new Promise<never>((_resolve, reject) => {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				reject(new Error(`Subagent timed out after ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			timeoutTimer.unref?.();
		});
		const aborted = new Promise<never>((_resolve, reject) => {
			abortHandler = () => {
				wasAborted = true;
				reject(new Error("Subagent was aborted"));
			};
			if (signal?.aborted) abortHandler();
			else signal?.addEventListener("abort", abortHandler, { once: true });
		});

		// Register the settled waiter before prompting so an extremely fast run
		// cannot finish in the gap between prompt acceptance and listener setup.
		const settled = activeClient.waitForIdle(timeoutMs + 1000);
		try {
			await activeClient.prompt(`Task: ${task}`);
			acceptInitialPrompt();
		} catch (error) {
			rejectInitialPrompt(error);
			throw error;
		}
		try {
			await Promise.race([settled, timeout, aborted]);
		} catch (error) {
			await activeClient.abort().catch(() => {});
			if (wasAborted) throw error;
			if (timedOut) {
				result.exitCode = 124;
				result.stopReason = "error";
				result.errorMessage = `Subagent timed out after ${Math.round(timeoutMs / 1000)}s`;
			} else {
				result.exitCode = 1;
				result.stopReason = "error";
				result.errorMessage = error instanceof Error ? error.message : String(error);
			}
		}
		result.stderr = activeClient.getStderr();
		return result;
	} finally {
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
		unsubscribe?.();
		if (client) await client.stop().catch(() => {});
		emitSessionEvent({
			type: "session_closed",
			error: timedOut
				? `Subagent timed out after ${Math.round(timeoutMs / 1000)}s`
				: wasAborted
					? "Subagent was aborted"
					: undefined,
		});
		sessionListeners.clear();
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
				fs.rmdirSync(path.dirname(tmpPromptPath));
			} catch {
				/* ignore */
			}
	}
}

/** Spawn a subagent (isolated context, message channel + system prompt), parse the JSON event stream */
export async function spawnSubagent(opts: SpawnOptions): Promise<SingleResult> {
	const { agent, task, cwd, messageRoot, runId, childIndex, signal } = opts;
	const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
	const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { ...emptyUsage },
		model: agent.model,
	};

	let tmpPromptPath: string | null = null;
	try {
		const args: string[] = ["--mode", "json", "-p", "--no-session"];
		if (agent.model) args.push("--model", agent.model);
		if (agent.thinking) args.push("--thinking", agent.thinking);
		// tool allowlist must include the messaging tools or subagents can't see them
		const tools = agent.tools ? [...agent.tools] : [];
		for (const t of ["send_message", "read_inbox", "reply_message"]) {
			if (!tools.includes(t)) tools.push(t);
		}
		if (tools.length > 0) args.push("--tools", tools.join(","));
		if (agent.systemPrompt.trim()) {
			tmpPromptPath = await writePromptToTempFile(agent.name, agent.systemPrompt);
			args.push("--append-system-prompt", tmpPromptPath);
		}
		args.push(`Task: ${task}`);

		// inject the messaging environment
		const env: NodeJS.ProcessEnv = { ...process.env };
		env[ENV_ROLE] = ROLE_CHILD;
		env[ENV_CHANNEL_ROOT] = messageRoot;
		env[ENV_RUN_ID] = runId;
		env[ENV_AGENT] = agent.name;
		env[ENV_CHILD_INDEX] = String(childIndex);
		ensureDir(channelDir(messageRoot, runId, agent.name, childIndex));

		let wasAborted = false;
		let timedOut = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? process.cwd(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env,
			});
			let buffer = "";
			let settled = false;
			let exited = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;

			const cleanup = () => {
				clearTimeout(timeoutTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			};
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(code);
			};
			const terminate = () => {
				if (exited) return;
				try {
					proc.kill("SIGTERM");
				} catch {
					/* process may already be gone */
				}
				forceKillTimer = setTimeout(() => {
					if (exited) return;
					try {
						proc.kill("SIGKILL");
					} catch {
						/* process may already be gone */
					}
				}, FORCE_KILL_DELAY_MS);
				forceKillTimer.unref?.();
			};
			const timeoutTimer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, timeoutMs);
			timeoutTimer.unref?.();

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.usage.turns++;
						const u = msg.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							result.usage.contextTokens = u.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
				}
				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message);
				}
			};
			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				exited = true;
				if (buffer.trim()) processLine(buffer);
				finish(code ?? (timedOut ? 124 : 0));
			});
			proc.on("error", (err) => {
				result.stderr += `${err instanceof Error ? err.message : String(err)}\n`;
				finish(1);
			});
			if (signal) {
				abortHandler = () => {
					wasAborted = true;
					terminate();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		result.exitCode = timedOut ? 124 : exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		if (timedOut) {
			result.stopReason = "error";
			result.errorMessage = `Subagent timed out after ${Math.round(timeoutMs / 1000)}s`;
		}
		return result;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
				fs.rmdirSync(path.dirname(tmpPromptPath));
			} catch {
				/* ignore */
			}
	}
}
