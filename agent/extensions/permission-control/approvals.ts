/**
 * approvals.ts — approval grants (once / session / project) and the FIFO
 * approval-prompt coordinator.
 *
 * The coordinator serializes user prompts so concurrent `ask` decisions from
 * parallel tool calls never interleave dialogs: each request acquires the
 * queue, re-checks the "current" predicate (another grant may already have
 * been granted while waiting), and only then prompts. Requests are abortable
 * (per-request signal + global reset on session shutdown).
 */

export type GrantScope = "once" | "session" | "project" | "global";

export interface ApprovedGrant {
	readonly scope: GrantScope;
	/** capability this grant covers (undefined = any) */
	readonly capability?: string;
	/** allowed path prefix (realpath) */
	readonly pathPrefix?: string;
	/** allowed command prefix (e.g. "curl example.com") */
	readonly commandPrefix?: string;
	/** allowed network domain */
	readonly domain?: string;
	readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// FIFO coordinator
// ---------------------------------------------------------------------------

/**
 * Minimal serialized-queue primitive: `acquire` returns a release function and
 * waits its turn. Supports abort and global reset (used on session shutdown to
 * fail pending prompts fast).
 */
export class AsyncQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private generation = 0;
	private resetWaiters: Array<() => void> = [];

	async acquire(signal?: AbortSignal, cancellationMessage = "Request cancelled"): Promise<() => void> {
		if (signal?.aborted) throw new Error(cancellationMessage);
		const generation = this.generation;
		let release: (() => void) | undefined;
		const previous = this.tail;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		const finish = (): void => release?.();

		let wakeReset: (() => void) | undefined;
		const resetSignal = new Promise<void>((resolve) => {
			wakeReset = resolve;
			this.resetWaiters.push(resolve);
		});
		const dropResetWaiter = (): void => {
			if (!wakeReset) return;
			const index = this.resetWaiters.indexOf(wakeReset);
			if (index >= 0) this.resetWaiters.splice(index, 1);
			wakeReset = undefined;
		};

		try {
			if (!signal) {
				await Promise.race([previous, resetSignal]);
			} else {
				let abort: (() => void) | undefined;
				try {
					await Promise.race([
						previous,
						resetSignal,
						new Promise<never>((_resolve, reject) => {
							abort = () => reject(new Error(cancellationMessage));
							signal.addEventListener("abort", abort, { once: true });
						}),
					]);
				} finally {
					if (abort) signal.removeEventListener("abort", abort);
				}
			}
			if (this.generation !== generation) throw new Error(cancellationMessage);
			return finish;
		} catch (error) {
			void previous.finally(finish);
			throw error;
		} finally {
			dropResetWaiter();
		}
	}

	reset(): void {
		this.generation += 1;
		this.tail = Promise.resolve();
		const waiters = this.resetWaiters.splice(0);
		for (const wake of waiters) wake();
	}
}

export class ApprovalCoordinator {
	private readonly queue = new AsyncQueue();
	private resetController = new AbortController();

	/**
	 * Resolve an approval decision. `current()` returns a concrete value when
	 * no prompt is needed (e.g. a grant already covers it); `request(signal)`
	 * runs the actual user prompt. Prompts are strictly serialized.
	 */
	async resolve<T>(
		current: () => T | undefined,
		request: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<T> {
		const immediate = current();
		if (immediate !== undefined) return immediate;

		const combined = combineAbortSignals(signal, this.resetController.signal);
		let release: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			release = await this.queue.acquire(combined.signal, "Permission request cancelled");
			const resolved = current();
			if (resolved !== undefined) return resolved;
			if (combined.signal.aborted) throw new Error("Permission request cancelled");

			let timedOut = false;
			if (timeoutMs && timeoutMs > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, timeoutMs);
			}
			const controller = new AbortController();
			const onReset = () => controller.abort();
			combined.signal.addEventListener("abort", onReset, { once: true });

			const result = await request(controller.signal);
			if (combined.signal.aborted && !timedOut) throw new Error("Permission request cancelled");
			if (timedOut) throw new ApprovalTimeout();
			return result;
		} finally {
			if (timer) clearTimeout(timer);
			release?.();
			combined.dispose();
		}
	}

	reset(): void {
		const controller = this.resetController;
		this.resetController = new AbortController();
		this.queue.reset();
		controller.abort();
	}
}

export class ApprovalTimeout extends Error {
	constructor() {
		super("Approval request timed out");
		this.name = "ApprovalTimeout";
	}
}

export function combineAbortSignals(
	...sources: Array<AbortSignal | undefined>
): { signal: AbortSignal; dispose: () => void } {
	const signals = sources.filter((s): s is AbortSignal => s !== undefined);
	const only = signals[0];
	if (signals.length === 1 && only) return { signal: only, dispose: () => undefined };
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
	if (signals.some((s) => s.aborted)) controller.abort();
	return {
		signal: controller.signal,
		dispose: () => {
			for (const signal of signals) signal.removeEventListener("abort", abort);
		},
	};
}

// ---------------------------------------------------------------------------
// Grant store
// ---------------------------------------------------------------------------

export interface GrantStoreOptions {
	/** called when a project-scope grant should be persisted */
	persistProject?: (grants: ApprovedGrant[]) => void | Promise<void>;
	/** called when a global-scope grant should be persisted */
	persistGlobal?: (grants: ApprovedGrant[]) => void | Promise<void>;
}

export class GrantStore {
	private readonly sessionGrants: ApprovedGrant[] = [];
	private readonly onceGrants: ApprovedGrant[] = [];
	/** project-scope grants loaded from config */
	private projectGrants: ApprovedGrant[] = [];
	/** global-scope grants loaded from config */
	private globalGrants: ApprovedGrant[] = [];
	private readonly opts: GrantStoreOptions;

	constructor(opts: GrantStoreOptions = {}) {
		this.opts = opts;
	}

	/** Load project grants (from persisted rules) at session start. */
	setProjectGrants(grants: ApprovedGrant[]): void {
		this.projectGrants = grants;
	}

	/** Load global grants (from persisted rules) at session start. */
	setGlobalGrants(grants: ApprovedGrant[]): void {
		this.globalGrants = grants;
	}

	all(): ApprovedGrant[] {
		return [...this.globalGrants, ...this.projectGrants, ...this.sessionGrants, ...this.onceGrants];
	}

	async add(grant: ApprovedGrant): Promise<void> {
		if (grant.scope === "project") {
			if (!this.projectGrants.some(sameGrant(grant))) {
				this.projectGrants.push(grant);
				await this.opts.persistProject?.(this.projectGrants);
			}
			return;
		}
		if (grant.scope === "global") {
			if (!this.globalGrants.some(sameGrant(grant))) {
				this.globalGrants.push(grant);
				await this.opts.persistGlobal?.(this.globalGrants);
			}
			return;
		}
		if (grant.scope === "session") {
			if (!this.sessionGrants.some(sameGrant(grant))) this.sessionGrants.push(grant);
			return;
		}
		this.onceGrants.push(grant);
	}

	/** Consume a matched once-grant so it can't be reused. */
	consumeOnce(grant: ApprovedGrant): void {
		const idx = this.onceGrants.indexOf(grant);
		if (idx >= 0) this.onceGrants.splice(idx, 1);
	}

	clearSession(): void {
		this.sessionGrants.length = 0;
		this.onceGrants.length = 0;
	}

	get size(): number {
		return this.all().length;
	}
}

function sameGrant(a: ApprovedGrant) {
	return (b: ApprovedGrant): boolean =>
		a.capability === b.capability &&
		a.pathPrefix === b.pathPrefix &&
		a.commandPrefix === b.commandPrefix &&
		a.domain === b.domain;
}
