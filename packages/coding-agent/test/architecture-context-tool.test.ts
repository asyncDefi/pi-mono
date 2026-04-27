import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { ARCHITECTURE_FILE_NAME } from "../src/core/architecture.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { ResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createArchitectureContextToolDefinition } from "../src/core/tools/architecture-context.js";
import { createCodingTools } from "../src/core/tools/index.js";

function createResourceLoader(): ResourceLoader {
	const runtime = createExtensionRuntime();
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

const tempDirs: string[] = [];

function createSession(cwd: string, sessionManager = SessionManager.inMemory()): AgentSession {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => "test",
		initialState: {
			model,
			systemPrompt: "base",
			tools: createCodingTools(cwd),
		},
	});
	const settingsManager = SettingsManager.create(cwd, cwd);
	const authStorage = AuthStorage.create(join(cwd, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(cwd, "models.json"));
	return new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		modelRegistry,
		resourceLoader: createResourceLoader(),
	});
}

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-architecture-"));
	tempDirs.push(dir);
	return dir;
}

function extensionContext(session: AgentSession): ExtensionContext {
	return (
		session as unknown as { _extensionRunner: { createContext(): ExtensionContext } }
	)._extensionRunner.createContext();
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("architecture_context tool", () => {
	const tool = createArchitectureContextToolDefinition();

	test("uses non-recursive tool parameters for provider compatibility", () => {
		expect(JSON.stringify(tool.parameters)).not.toContain("ArchitectureContainer");
		expect(JSON.stringify(tool.parameters)).not.toContain("$ref");
	});

	test("init creates a valid empty architecture graph", async () => {
		const cwd = createTempDir();
		const session = createSession(cwd);
		const ctx = extensionContext(session);

		const result = await tool.execute("call-1", { action: "init" }, undefined, undefined, ctx);

		expect((result.content[0] as { text: string }).text).toContain("Created");
		expect(existsSync(join(cwd, ARCHITECTURE_FILE_NAME))).toBe(true);
		const validate = await tool.execute("call-2", { action: "validate" }, undefined, undefined, ctx);
		expect((validate.content[0] as { text: string }).text).toBe("architecture.json is valid");
		session.dispose();
	});

	test("upserts systems, scripts, and relations through patch actions", async () => {
		const cwd = createTempDir();
		const session = createSession(cwd);
		const ctx = extensionContext(session);

		await tool.execute("init", { action: "init" }, undefined, undefined, ctx);
		await tool.execute(
			"system",
			{
				action: "upsert_system",
				system: {
					id: "agent-runtime",
					name: "Agent Runtime",
					responsibility: "Owns session orchestration.",
					boundaries: ["Coordinates tools without embedding tool state."],
				},
			},
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"script",
			{
				action: "upsert_script",
				containerId: "agent-runtime",
				script: {
					id: "agent-session",
					path: "packages/coding-agent/src/core/agent-session.ts",
					responsibility: "Coordinates session lifecycle and prompt state.",
					publicSurface: ["AgentSession"],
				},
			},
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"relation",
			{
				action: "upsert_relation",
				relation: {
					id: "runtime-owns-session",
					kind: "owns",
					from: "agent-runtime",
					to: "agent-session",
					summary: "The runtime system owns the session lifecycle script.",
				},
			},
			undefined,
			undefined,
			ctx,
		);

		const systems = await tool.execute("list", { action: "list_systems" }, undefined, undefined, ctx);
		expect((systems.content[0] as { text: string }).text).toContain("agent-runtime: Agent Runtime");
		const loaded = await tool.execute("get", { action: "get", id: "agent-runtime" }, undefined, undefined, ctx);
		expect((loaded.content[0] as { text: string }).text).toContain("runtime-owns-session");
		session.dispose();
	});

	test("rejects invalid relations", async () => {
		const cwd = createTempDir();
		const session = createSession(cwd);
		const ctx = extensionContext(session);

		await tool.execute("init", { action: "init" }, undefined, undefined, ctx);
		await expect(
			tool.execute(
				"bad-relation",
				{
					action: "upsert_relation",
					relation: {
						id: "missing-link",
						kind: "uses",
						from: "missing-a",
						to: "missing-b",
						summary: "Invalid missing nodes.",
					},
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("references missing");
		session.dispose();
	});

	test("rejects duplicate graph ids", async () => {
		const cwd = createTempDir();
		const session = createSession(cwd);
		const ctx = extensionContext(session);

		await tool.execute("init", { action: "init" }, undefined, undefined, ctx);
		await tool.execute(
			"system",
			{
				action: "upsert_system",
				system: {
					id: "duplicate",
					name: "Duplicate",
					responsibility: "Existing system id.",
				},
			},
			undefined,
			undefined,
			ctx,
		);
		await expect(
			tool.execute(
				"script",
				{
					action: "upsert_script",
					containerId: "duplicate",
					script: {
						id: "duplicate",
						path: "src/duplicate.ts",
						responsibility: "This duplicates its parent id.",
					},
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("duplicate id");
		session.dispose();
	});

	test("loads architecture into the system prompt and restores active ids", async () => {
		const cwd = createTempDir();
		const sessionManager = SessionManager.inMemory();
		const s1 = createSession(cwd, sessionManager);
		const ctx1 = extensionContext(s1);

		await tool.execute("init", { action: "init" }, undefined, undefined, ctx1);
		await tool.execute(
			"system",
			{
				action: "upsert_system",
				system: {
					id: "tools",
					name: "Tools",
					responsibility: "Expose built-in capabilities to the model.",
				},
			},
			undefined,
			undefined,
			ctx1,
		);
		await tool.execute("load", { action: "load", id: "tools" }, undefined, undefined, ctx1);

		expect(s1.systemPrompt).toContain("<LOADED_ARCHITECTURE>");
		expect(s1.systemPrompt).toContain("tools: Tools");
		const active = await tool.execute("active", { action: "list_active" }, undefined, undefined, ctx1);
		expect((active.content[0] as { text: string }).text).toBe("tools");
		s1.dispose();

		const s2 = createSession(cwd, sessionManager);
		expect(s2.systemPrompt).toContain("<LOADED_ARCHITECTURE>");
		expect(s2.systemPrompt).toContain("tools: Tools");
		const ctx2 = extensionContext(s2);
		await tool.execute("unload", { action: "unload", id: "tools" }, undefined, undefined, ctx2);
		expect(s2.systemPrompt).not.toContain("<LOADED_ARCHITECTURE>");
		s2.dispose();
	});
});
