import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: string;
}

/** Parse YAML frontmatter + markdown body */
function parseFrontmatter(
	content: string,
): { frontmatter: Record<string, string>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };
	const raw = match[1] ?? "";
	const body = match[2] ?? "";
	const frontmatter: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
		if (key) frontmatter[key] = value;
	}
	return { frontmatter, body: body.trim() };
}

function loadAgentsFromDir(dir: string): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	const agents: AgentConfig[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name || !frontmatter.description) continue;
		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model || undefined,
			thinking: frontmatter.thinking || undefined,
			systemPrompt: body,
			source: dir,
		});
	}
	return agents;
}

/** Built-in agent directory (the extension's own agents/) */
function builtinAgentsDir(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "agents");
}

/** User-level agent directory ~/.pi/agent/agents */
export function userAgentsDir(home = process.env.HOME ?? ""): string {
	return path.join(home, ".pi", "agent", "agents");
}

/**
 * Discover agents: built-in agents/ + user-level ~/.pi/agent/agents.
 * A user-level agent with the same name overrides the built-in one.
 */
export function discoverAgents(cwd?: string): AgentConfig[] {
	const dirs = [builtinAgentsDir()];
	if (cwd) {
		// project-level .pi/agents is intentionally not enabled (safety)
	}
	const byName = new Map<string, AgentConfig>();
	for (const dir of dirs) {
		for (const agent of loadAgentsFromDir(dir)) {
			byName.set(agent.name, agent);
		}
	}
	return [...byName.values()];
}
