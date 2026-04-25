import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import type { McpClient, McpServer, McpToolCallResult } from "../src/core/mcp.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { ResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createSourceInfo } from "../src/core/source-info.js";
import { createCodingTools } from "../src/core/tools/index.js";

class FakeMcpClient implements McpClient {
	closed = false;

	async connect(): Promise<void> {}

	async listTools() {
		return [
			{
				name: "ping",
				description: "Ping test tool",
				inputSchema: {
					type: "object",
					properties: {
						message: { type: "string" },
					},
				},
			},
		];
	}

	async callTool(_name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
		return { content: [{ type: "text", text: `pong ${String(args.message ?? "")}` }] };
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

function createResourceLoaderWithMcp(server: McpServer): ResourceLoader {
	const runtime = createExtensionRuntime();
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getMcpServers: () => ({ servers: [server], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

describe("MCP context lifecycle", () => {
	test("loads MCP tools into the active tool set and system prompt", async () => {
		const cwd = process.cwd();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test",
			initialState: {
				model,
				systemPrompt: "base",
				tools: createCodingTools(cwd),
			},
		});

		const server: McpServer = {
			name: "docs",
			description: "Docs search",
			configPath: `${cwd}/.pi/mcp.json`,
			config: { type: "stdio", command: "node", args: [] },
			sourceInfo: createSourceInfo(`${cwd}/.pi/mcp.json`, {
				source: "project",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(cwd, cwd),
			cwd,
			modelRegistry: ModelRegistry.create(AuthStorage.create(`${cwd}/auth.json`), cwd),
			resourceLoader: createResourceLoaderWithMcp(server),
			mcpClientFactory: () => new FakeMcpClient(),
		});

		const loadResult = await (session as any)._loadMcpIntoContext("docs");
		expect(loadResult.toolNames).toEqual(["mcp__docs__ping"]);
		expect(session.getActiveToolNames()).toContain("mcp__docs__ping");
		expect(session.systemPrompt).toContain("<LOADED_MCP>");
		expect(session.systemPrompt).toContain("mcp__docs__ping");

		const tool = session.getToolDefinition("mcp__docs__ping");
		expect(tool).toBeDefined();
		const toolResult = await tool!.execute("call", { message: "ok" }, undefined, undefined, undefined as any);
		expect((toolResult.content[0] as { text: string }).text).toBe("pong ok");

		await (session as any)._unloadMcpFromContext("docs");
		expect(session.getActiveToolNames()).not.toContain("mcp__docs__ping");
		expect(session.systemPrompt).not.toContain("<LOADED_MCP>");

		session.dispose();
	});
});
