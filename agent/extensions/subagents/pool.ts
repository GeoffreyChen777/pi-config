import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./agents.ts";
import type { SubagentSessionHandle } from "./session.ts";
import {
	ENV_AGENT,
	ENV_CHANNEL_ROOT,
	ENV_CHILD_INDEX,
	ENV_ROLE,
	ENV_RUN_ID,
	ROLE_CHILD,
} from "./message.ts";

// ============================================================================
// RPC-resident subagent process pool
//
// One resident `pi --mode rpc` process per agent. Commands go over stdin,
// JSON events come back over stdout. Processes stay alive between tasks so
// they can receive inter-subagent messages.
// ============================================================================

export interface TaskResult {
	agent: string;
	task: string;
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

export function finalOutput(messages: TaskResult["messages"]): string {
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

const IDLE_RECYCLE_MS = 10 * 60 * 1000; // recycle idle processes after 10 min
const FORCE_KILL_DELAY_MS = 5000;

interface TurnWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

interface PooledProcess {
	agent: AgentConfig;
	proc: ChildProcess;
	nextId: number;
	pending: Map<string, (data: unknown) => void>;
	events: Array<Record<string, unknown>>;
	lastUsed: number;
	spawnError?: string;
	closed: boolean;
	// Run-completion notification: RPC returns the prompt response at preflight,
	// so we wait for agent_settled to include retries and queued interactions.
	turnWaiters: TurnWaiter[];
}

export class SubagentPool {
	private procs = new Map<string, PooledProcess>();
	private eventListeners = new Map<string, Set<(event: any) => void>>();
	private taskTails = new Map<string, Promise<void>>();
	private recycleTimer: ReturnType<typeof setInterval>;
	private messageRoot: string;
	private workingDirectory = process.cwd();
	private runIdCounter = new Map<string, number>();
	private idleCheckInterval = 30 * 1000;
	private disposed = false;

	constructor(messageRoot: string) {
		this.messageRoot = messageRoot;
		this.recycleTimer = setInterval(() => this.recycleIdle(), this.idleCheckInterval);
		this.recycleTimer.unref?.();
	}

	setIntercomRoot(root: string) {
		this.messageRoot = root;
	}

	setWorkingDirectory(cwd: string) {
		if (!cwd || cwd === this.workingDirectory) return;
		this.workingDirectory = cwd;
		for (const [name, pooled] of [...this.procs]) {
			this.terminateProcess(name, pooled, new Error("Subagent working directory changed."));
		}
	}

	/** Serialize tasks per agent so one agent_end cannot complete multiple callers. */
	private async withAgentLock<T>(agentName: string, run: () => Promise<T>): Promise<T> {
		const previous = this.taskTails.get(agentName) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => {}).then(() => current);
		this.taskTails.set(agentName, tail);
		await previous.catch(() => {});
		try {
			if (this.disposed) throw new Error("Subagent pool is disposed.");
			return await run();
		} finally {
			release();
			if (this.taskTails.get(agentName) === tail) this.taskTails.delete(agentName);
		}
	}

	private terminateProcess(agentName: string, pooled: PooledProcess, reason: Error): void {
		if (this.procs.get(agentName) === pooled) this.procs.delete(agentName);
		pooled.closed = true;
		this.emitAgentEvent(agentName, { type: "session_closed", error: reason.message });
		const waiters = pooled.turnWaiters.splice(0);
		for (const waiter of waiters) waiter.reject(reason);
		try {
			pooled.proc.kill("SIGTERM");
		} catch {
			/* process may already be gone */
		}
		const timer = setTimeout(() => {
			if (pooled.proc.exitCode !== null || pooled.proc.signalCode !== null) return;
			try {
				pooled.proc.kill("SIGKILL");
			} catch {
				/* process may already be gone */
			}
		}, FORCE_KILL_DELAY_MS);
		timer.unref?.();
	}

	private invocation(args: string[]): { command: string; args: string[] } {
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

	private async writePromptToTempFile(agentName: string, prompt: string): Promise<string | null> {
		if (!prompt.trim()) return null;
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const safeName = agentName.replace(/[^\w.-]+/g, "_");
		const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		return filePath;
	}

	/** Ensure a resident process exists for the agent */
	async ensureProcess(agent: AgentConfig): Promise<PooledProcess> {
		if (this.disposed) throw new Error("Subagent pool is disposed.");
		const existing = this.procs.get(agent.name);
		if (existing && !existing.closed && existing.proc.exitCode === null && existing.proc.signalCode === null) {
			return existing;
		}
		// kill the old process, if any
		if (existing) {
			this.terminateProcess(agent.name, existing, new Error(`Replacing stale subagent process for ${agent.name}.`));
		}

		const args: string[] = ["--mode", "rpc", "--no-session"];
		if (agent.model) args.push("--model", agent.model);
		if (agent.thinking) args.push("--thinking", agent.thinking);
		const tools = agent.tools ? [...agent.tools] : [];
		for (const t of ["send_message", "read_inbox", "reply_message"]) {
			if (!tools.includes(t)) tools.push(t);
		}
		if (tools.length > 0) args.push("--tools", tools.join(","));

		let tmpPromptPath: string | null = null;
		if (agent.systemPrompt.trim()) {
			tmpPromptPath = await this.writePromptToTempFile(agent.name, agent.systemPrompt);
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const runId = randomUUID();
		const childIndex = this.runIdCounter.get(agent.name) ?? 0;
		this.runIdCounter.set(agent.name, childIndex + 1);

		const env: NodeJS.ProcessEnv = { ...process.env };
		env[ENV_ROLE] = ROLE_CHILD;
		env[ENV_CHANNEL_ROOT] = this.messageRoot;
		env[ENV_RUN_ID] = runId;
		env[ENV_AGENT] = agent.name;
		env[ENV_CHILD_INDEX] = String(childIndex);

		const pooled: PooledProcess = {
			agent,
			proc: null as unknown as ChildProcess,
			nextId: 1,
			pending: new Map(),
			events: [],
			lastUsed: Date.now(),
			closed: false,
			turnWaiters: [],
		};

		const invocation = this.invocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.workingDirectory,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		pooled.proc = proc;

		let buffer = "";
		let readyResolve: (() => void) | undefined;
		const ready = new Promise<void>((r) => (readyResolve = r));
		let readyTimer: ReturnType<typeof setTimeout> | undefined;
		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) this.processLine(pooled, line);
			// any event means the RPC loop is up
			if (readyResolve && pooled.events.length > 0) {
				readyResolve();
				readyResolve = undefined;
				if (readyTimer) clearTimeout(readyTimer);
			}
		});
		proc.stderr.on("data", (data) => {
			pooled.spawnError = (pooled.spawnError ?? "") + data.toString();
		});
		proc.on("close", (code) => {
			pooled.closed = true;
			this.emitAgentEvent(agent.name, {
				type: "session_closed",
				error: `Subagent process exited (code ${code ?? "unknown"}).`,
			});
			if (readyResolve) {
				readyResolve();
				readyResolve = undefined;
				if (readyTimer) clearTimeout(readyTimer);
			}
			for (const [, resolve] of pooled.pending) {
				resolve({ type: "process_exit", code });
			}
			pooled.pending.clear();
			pooled.events.push({ type: "process_exit", code });
			const waiters = pooled.turnWaiters.splice(0);
			const error = new Error(
				`Subagent process exited before completing the task (code ${code ?? "unknown"}).${pooled.spawnError ? ` ${pooled.spawnError.trim()}` : ""}`,
			);
			for (const waiter of waiters) waiter.reject(error);
		});
		proc.on("error", (err) => {
			pooled.spawnError = err.message;
			if (readyResolve) {
				readyResolve();
				readyResolve = undefined;
				if (readyTimer) clearTimeout(readyTimer);
			}
		});

		// wait for RPC readiness: first event, or a 2s fallback timeout
		readyTimer = setTimeout(() => {
			if (readyResolve) {
				readyResolve();
				readyResolve = undefined;
			}
		}, 2000);
		try {
			await ready;
			if (this.disposed) {
				this.terminateProcess(agent.name, pooled, new Error("Subagent pool disposed during process startup."));
				throw new Error("Subagent pool is disposed.");
			}
			if (pooled.closed || proc.exitCode !== null || proc.signalCode !== null) {
				throw new Error(
					`Failed to start subagent ${agent.name}.${pooled.spawnError ? ` ${pooled.spawnError.trim()}` : ""}`,
				);
			}
			this.procs.set(agent.name, pooled);
			return pooled;
		} finally {
			if (tmpPromptPath) {
				try {
					fs.unlinkSync(tmpPromptPath);
					fs.rmdirSync(path.dirname(tmpPromptPath));
				} catch {
					/* ignore */
				}
			}
		}
	}

	private processLine(pooled: PooledProcess, line: string) {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event?.type === "response" && event?.id !== undefined) {
			const resolve = pooled.pending.get(String(event.id));
			if (resolve) {
				pooled.pending.delete(String(event.id));
				resolve(event);
			}
			return;
		}
		pooled.events.push(event);
		this.emitAgentEvent(pooled.agent.name, event);
		// The whole session-level run is finished only at agent_settled. Waiting
		// for agent_end would close the activity before queued interactive steer
		// or follow-up messages have been processed.
		if (event?.type === "agent_settled" && pooled.turnWaiters.length > 0) {
			const waiters = pooled.turnWaiters.splice(0);
			for (const waiter of waiters) waiter.resolve();
		}
	}

	private emitAgentEvent(agentName: string, event: any): void {
		for (const listener of this.eventListeners.get(agentName) ?? []) {
			try {
				listener(event);
			} catch {
				/* UI listeners must not affect the resident process */
			}
		}
	}

	private sendCommand(pooled: PooledProcess, cmd: Record<string, unknown>): string {
		if (pooled.closed || !pooled.proc.stdin || !pooled.proc.stdin.writable) {
			throw new Error(`Subagent process for ${pooled.agent.name} is not writable.`);
		}
		const id = String(pooled.nextId++);
		pooled.proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
		return id;
	}

	private sendCommandAndWait(pooled: PooledProcess, cmd: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		const id = this.sendCommand(pooled, cmd);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pooled.pending.delete(id);
				reject(new Error("RPC command timed out"));
			}, timeoutMs);
			pooled.pending.set(id, (data) => {
				clearTimeout(timer);
				resolve(data);
			});
		});
	}

	private responseData(response: any): any {
		if (!response || response.type !== "response") throw new Error("Invalid RPC response.");
		if (response.success === false) throw new Error(response.error || `RPC ${response.command || "command"} failed.`);
		return response.data;
	}

	/** Interactive handle for the exact resident process/session used by routed messages. */
	getSessionHandle(agent: AgentConfig): SubagentSessionHandle {
		return {
			agent: agent.name,
			getMessages: async () => {
				const pooled = await this.ensureProcess(agent);
				const response = await this.sendCommandAndWait(pooled, { type: "get_messages" }, 10000);
				return this.responseData(response)?.messages ?? [];
			},
			isStreaming: async () => {
				const pooled = await this.ensureProcess(agent);
				const response = await this.sendCommandAndWait(pooled, { type: "get_state" }, 10000);
				return this.responseData(response)?.isStreaming === true;
			},
			send: async (message: string) => {
				const pooled = await this.ensureProcess(agent);
				const stateResponse = await this.sendCommandAndWait(pooled, { type: "get_state" }, 10000);
				const streaming = this.responseData(stateResponse)?.isStreaming === true;
				const command = streaming ? { type: "steer", message } : { type: "prompt", message };
				const response = await this.sendCommandAndWait(pooled, command, 10000);
				this.responseData(response);
			},
			abort: async () => {
				const pooled = await this.ensureProcess(agent);
				const response = await this.sendCommandAndWait(pooled, { type: "abort" }, 10000);
				this.responseData(response);
			},
			subscribe: (listener) => {
				let listeners = this.eventListeners.get(agent.name);
				if (!listeners) {
					listeners = new Set();
					this.eventListeners.set(agent.name, listeners);
				}
				listeners.add(listener);
				return () => {
					listeners?.delete(listener);
					if (listeners?.size === 0) this.eventListeners.delete(agent.name);
				};
			},
		};
	}

	/** Send a prompt command (fire-and-forget; events land in events) */
	sendPrompt(agent: AgentConfig, message: string): string {
		const pooled = this.procs.get(agent.name);
		if (!pooled || pooled.closed) throw new Error(`No process for agent ${agent.name}`);
		pooled.lastUsed = Date.now();
		return this.sendCommand(pooled, { type: "prompt", message });
	}

	/** Run a task synchronously: send a prompt and wait for completion, collecting events */
	async runTask(
		agent: AgentConfig,
		task: string,
		timeoutMs = 6 * 60 * 60 * 1000,
		onUpdate?: (events: unknown[]) => void,
		signal?: AbortSignal,
	): Promise<TaskResult> {
		return this.withAgentLock(agent.name, async () => {
			const pooled = await this.ensureProcess(agent);
			pooled.lastUsed = Date.now();

			const result: TaskResult = {
				agent: agent.name,
				task,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: agent.model,
			};

			// event index at the start of this task
			const startIndex = pooled.events.length;
			// Register the waiter before sending the prompt so an extremely fast
			// agent_end cannot arrive in the gap and leave us waiting until timeout.
			const completion = new Promise<void>((resolve, reject) => {
				let waiter: TurnWaiter;
				let abortHandler: (() => void) | undefined;
				const cleanup = () => {
					clearTimeout(timer);
					if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				};
				const timer = setTimeout(() => {
					const i = pooled.turnWaiters.indexOf(waiter);
					if (i >= 0) pooled.turnWaiters.splice(i, 1);
					const error = new Error(`Subagent task timed out after ${Math.round(timeoutMs / 1000)}s`);
					this.terminateProcess(agent.name, pooled, error);
					cleanup();
					reject(error);
				}, timeoutMs);
				waiter = {
					resolve: () => {
						cleanup();
						resolve();
					},
					reject: (error) => {
						cleanup();
						reject(error);
					},
				};
				pooled.turnWaiters.push(waiter);
				if (signal) {
					abortHandler = () => {
						const i = pooled.turnWaiters.indexOf(waiter);
						if (i >= 0) pooled.turnWaiters.splice(i, 1);
						const error = new Error("Subagent task cancelled.");
						this.terminateProcess(agent.name, pooled, error);
						cleanup();
						reject(error);
					};
					if (signal.aborted) abortHandler();
					else signal.addEventListener("abort", abortHandler, { once: true });
				}
			});
			try {
				this.sendCommand(pooled, { type: "prompt", message: task });
			} catch (e) {
				const waiter = pooled.turnWaiters.pop();
				waiter?.reject(e instanceof Error ? e : new Error(String(e)));
			}

			// RPC returns the prompt response at preflight; wait for agent_settled
			// so retries, compaction, and interactive queued messages are included.
			await completion;

			// collect the events for this task
			const taskEvents = pooled.events.slice(startIndex);
			for (const ev of taskEvents as any[]) {
				if (ev.type === "message_end" && ev.message) {
					result.messages.push(ev.message);
					if (ev.message.role === "assistant") {
						result.usage.turns++;
						const u = ev.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							result.usage.contextTokens = u.totalTokens || 0;
						}
						if (!result.model && ev.message.model) result.model = ev.message.model;
						if (ev.message.stopReason) result.stopReason = ev.message.stopReason;
						if (ev.message.errorMessage) result.errorMessage = ev.message.errorMessage;
					}
				}
				if (ev.type === "tool_result_end" && ev.message) {
					result.messages.push(ev.message);
				}
			}
			onUpdate?.(taskEvents);
			return result;
		});
	}

	/** Get unconsumed events for an agent's process (for message-route scanning) */
	drainEvents(agentName: string): Array<Record<string, unknown>> {
		const pooled = this.procs.get(agentName);
		if (!pooled) return [];
		const out = pooled.events;
		pooled.events = [];
		return out;
	}

	/** Whether the process is alive */
	isAlive(agentName: string): boolean {
		const p = this.procs.get(agentName);
		return !!p && !p.closed && p.proc.exitCode === null && p.proc.signalCode === null;
	}

	/** Recycle idle processes */
	private recycleIdle() {
		const now = Date.now();
		for (const [name, pooled] of this.procs) {
			if (pooled.closed || pooled.proc.exitCode !== null || pooled.proc.signalCode !== null) {
				this.procs.delete(name);
				continue;
			}
			// skip processes with pending work
			if (pooled.pending.size > 0) continue;
			if (now - pooled.lastUsed > IDLE_RECYCLE_MS) {
				this.terminateProcess(name, pooled, new Error(`Subagent process ${name} recycled after being idle.`));
			}
		}
	}

	/** Shut down all processes */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.recycleTimer);
		for (const [name, pooled] of this.procs) {
			this.terminateProcess(name, pooled, new Error("Subagent pool disposed."));
		}
		this.procs.clear();
		this.taskTails.clear();
		this.eventListeners.clear();
	}
}
