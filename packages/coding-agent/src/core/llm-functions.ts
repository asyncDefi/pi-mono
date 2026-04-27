import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type Api, type AssistantMessage, type Model, streamSimple } from "@mariozechner/pi-ai";
import { AgentSession } from "./agent-session.js";
import { createExtensionRuntime } from "./extensions/loader.js";

export {
	type DiscoverLlmFunctionsResult,
	discoverLlmFunctions,
	formatLlmFunctionsForPrompt,
	getLlmFunctionReadOnlyToolNames,
	getLlmFunctionsDir,
	type LlmFunctionConfig,
	type LlmFunctionDiagnostic,
	type LlmFunctionModelConfig,
	type LlmFunctionReadOnlyToolName,
	loadLlmFunction,
} from "./llm-functions-config.js";

import { getLlmFunctionReadOnlyToolNames, type LlmFunctionConfig, loadLlmFunction } from "./llm-functions-config.js";
import {
	createMcpClient,
	createMcpToolDefinition,
	type LoadedMcpServer,
	type LoadedMcpTool,
	type McpClientFactory,
	type McpServer,
	type McpTool,
	mcpToolName,
} from "./mcp.js";
import { convertToLlm } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

export interface LlmFunctionRunResult {
	name: string;
	model: string;
	output: string;
	tools: string[];
	mcpServers: string[];
}

export interface RunLlmFunctionOptions {
	cwd: string;
	name: string;
	task: string;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
	mcpClientFactory?: McpClientFactory;
}

function resolveLlmFunctionModel(config: LlmFunctionConfig, modelRegistry: ModelRegistry): Model<Api> {
	const model = modelRegistry.find(config.modelConfig.provider, config.modelConfig.model);
	if (!model) {
		throw new Error(
			`Model "${config.modelConfig.provider}/${config.modelConfig.model}" for llm-function "${config.name}" was not found`,
		);
	}
	if (!modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(
			`No API key found for llm-function model "${config.modelConfig.provider}/${config.modelConfig.model}"`,
		);
	}
	return model;
}

function createLoadedMcpTools(existingNames: Set<string>, server: McpServer, tools: McpTool[]): LoadedMcpTool[] {
	return tools.map((tool, index) => {
		let toolName = mcpToolName(server.name, tool.name);
		if (existingNames.has(toolName)) {
			toolName = mcpToolName(server.name, `${tool.name}-${index + 1}`);
		}
		existingNames.add(toolName);
		return { tool, toolName };
	});
}

async function loadFunctionMcpServers(
	cwd: string,
	servers: McpServer[],
	mcpClientFactory: McpClientFactory,
	signal: AbortSignal | undefined,
): Promise<LoadedMcpServer[]> {
	const loadedServers: LoadedMcpServer[] = [];
	const existingToolNames = new Set<string>();
	for (const server of servers) {
		if (signal?.aborted) {
			await Promise.all(loadedServers.map((loaded) => loaded.client.close().catch(() => undefined)));
			throw new Error("llm-function was aborted");
		}
		const client = mcpClientFactory(server, cwd);
		try {
			await client.connect(signal);
			const tools = await client.listTools(signal);
			loadedServers.push({
				server,
				client,
				tools: createLoadedMcpTools(existingToolNames, server, tools),
			});
		} catch (error) {
			await Promise.all([
				client.close().catch(() => undefined),
				...loadedServers.map((loaded) => loaded.client.close().catch(() => undefined)),
			]);
			throw error;
		}
	}
	return loadedServers;
}

function getAssistantText(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function createLlmFunctionResourceLoader(config: LlmFunctionConfig): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getMcpServers: () => ({ servers: config.mcpServers, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => config.instruction,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function runLlmFunctionUnlocked(options: RunLlmFunctionOptions): Promise<LlmFunctionRunResult> {
	const config = loadLlmFunction(options.cwd, options.name);
	const model = resolveLlmFunctionModel(config, options.modelRegistry);
	const mcpClientFactory = options.mcpClientFactory ?? createMcpClient;
	const loadedMcpServers = await loadFunctionMcpServers(
		options.cwd,
		config.mcpServers,
		mcpClientFactory,
		options.signal,
	);

	try {
		const mcpDefinitions = loadedMcpServers.flatMap((loaded) =>
			loaded.tools.map((tool) => createMcpToolDefinition(loaded, tool)),
		);
		const activeToolNames = [
			...getLlmFunctionReadOnlyToolNames(),
			...mcpDefinitions.map((definition) => definition.name),
		];
		const agent = new Agent({
			initialState: {
				model,
				thinkingLevel: model.reasoning ? (config.modelConfig.thinking ?? "medium") : "off",
				systemPrompt: "",
				tools: [],
			},
			convertToLlm,
			streamFn: async (requestModel, context, streamOptions) => {
				const auth = await options.modelRegistry.getApiKeyAndHeaders(requestModel);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				return streamSimple(requestModel, context, {
					...streamOptions,
					apiKey: auth.apiKey,
					headers:
						auth.headers || streamOptions?.headers
							? { ...(auth.headers ?? {}), ...(streamOptions?.headers ?? {}) }
							: undefined,
				});
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(options.cwd),
			settingsManager: SettingsManager.inMemory(),
			cwd: options.cwd,
			modelRegistry: options.modelRegistry,
			resourceLoader: createLlmFunctionResourceLoader(config),
			customTools: mcpDefinitions,
			initialActiveToolNames: activeToolNames,
			allowedToolNames: activeToolNames,
			includeLlmFunctionsContext: false,
			mcpClientFactory,
		});

		try {
			const abort = () => agent.abort();
			if (options.signal?.aborted) {
				throw new Error("llm-function was aborted");
			}
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				options.onUpdate?.(`Running llm-function "${config.name}"...`);
				await session.prompt(`Task:\n${options.task}`, { expandPromptTemplates: false, source: "extension" });
			} finally {
				options.signal?.removeEventListener("abort", abort);
			}

			const finalMessage = getLastAssistantMessage(session.messages);
			if (!finalMessage) {
				throw new Error(`llm-function "${config.name}" produced no assistant response`);
			}
			if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
				throw new Error(finalMessage.errorMessage || `llm-function "${config.name}" ${finalMessage.stopReason}`);
			}

			return {
				name: config.name,
				model: `${model.provider}/${model.id}`,
				output: getAssistantText(finalMessage).trim() || "(no output)",
				tools: session.getActiveToolNames(),
				mcpServers: loadedMcpServers.map((loaded) => loaded.server.name),
			};
		} finally {
			session.dispose();
		}
	} finally {
		await Promise.all(loadedMcpServers.map((loaded) => loaded.client.close().catch(() => undefined)));
	}
}

let llmFunctionMutex: Promise<void> = Promise.resolve();

async function waitForLlmFunctionTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) {
		return false;
	}
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			resolve(ready);
		};
		const abort = () => finish(false);
		signal?.addEventListener("abort", abort, { once: true });
		previous.then(
			() => finish(true),
			() => finish(true),
		);
	});
}

export async function runLlmFunction(options: RunLlmFunctionOptions): Promise<LlmFunctionRunResult> {
	const previous = llmFunctionMutex;
	const previousSettled = previous.catch(() => undefined);
	let release!: () => void;
	const lock = new Promise<void>((resolveLock) => {
		release = resolveLock;
	});
	llmFunctionMutex = previousSettled.then(() => lock);

	const ready = await waitForLlmFunctionTurn(previousSettled, options.signal);
	if (!ready) {
		previousSettled.finally(release);
		throw new Error("llm-function was aborted");
	}

	try {
		return await runLlmFunctionUnlocked(options);
	} finally {
		release();
	}
}
