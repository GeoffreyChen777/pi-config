export interface SubagentSessionHandle {
	readonly agent: string;
	getMessages(): Promise<any[]>;
	isStreaming(): Promise<boolean>;
	send(message: string): Promise<void>;
	abort(): Promise<void>;
	subscribe(listener: (event: any) => void): () => void;
}
