import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { ResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSourceInfo } from "../src/core/source-info.js";
import { createCodingTools } from "../src/core/tools/index.js";

function createResourceLoaderWithSkills(skills: Skill[] = []): ResourceLoader {
	const runtime = createExtensionRuntime();
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function createSkill(name: string): Skill {
	return {
		name,
		description: `Skill ${name}`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		sourceInfo: createSourceInfo(`/tmp/${name}/SKILL.md`, {
			source: "project",
			scope: "temporary",
			origin: "top-level",
		}),
		disableModelInvocation: false,
	};
}

describe("dont-destroy notes lifecycle", () => {
	test("set/clear/clear_all updates system prompt and keeps last 5 events", () => {
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

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(cwd, cwd);
		const authStorage = AuthStorage.create(`${cwd}/auth.json`);
		const modelRegistry = ModelRegistry.create(authStorage, cwd);
		const resourceLoader = createResourceLoaderWithSkills([createSkill("ui")]);

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd,
			modelRegistry,
			resourceLoader,
		});

		expect(session.systemPrompt).toContain("|<DONT-DESTROY>|");
		expect(session.systemPrompt).toContain("[1] (max 700 chars) (empty)");

		(session as any)._setDontDestroyNote(1, "hello");
		expect(session.systemPrompt).toContain("[1] (max 700 chars) hello");

		(session as any)._clearDontDestroyNote(1);
		expect(session.systemPrompt).toContain("[1] (max 700 chars) (empty)");

		// 6 events -> keep last 5
		(session as any)._setDontDestroyNote(1, "a");
		(session as any)._setDontDestroyNote(2, "b");
		(session as any)._setDontDestroyNote(3, "c");
		(session as any)._setDontDestroyNote(4, "d");
		(session as any)._setDontDestroyNote(5, "e");
		(session as any)._clearAllDontDestroyNotes();

		const history = (session as any)._getDontDestroyHistory();
		expect(history).toHaveLength(5);
		expect(history[history.length - 1].action).toBe("clear_all");

		session.dispose();
	});

	test("restores notes from session custom entries", () => {
		const cwd = process.cwd();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(cwd, cwd);
		const authStorage = AuthStorage.create(`${cwd}/auth.json`);
		const modelRegistry = ModelRegistry.create(authStorage, cwd);
		const resourceLoader = createResourceLoaderWithSkills();

		const agent1 = new Agent({
			getApiKey: () => "test",
			initialState: { model, systemPrompt: "base", tools: createCodingTools(cwd) },
		});
		const s1 = new AgentSession({
			agent: agent1,
			sessionManager,
			settingsManager,
			cwd,
			modelRegistry,
			resourceLoader,
		});
		(s1 as any)._setDontDestroyNote(1, "persist");
		s1.dispose();

		const agent2 = new Agent({
			getApiKey: () => "test",
			initialState: { model, systemPrompt: "base", tools: createCodingTools(cwd) },
		});
		const s2 = new AgentSession({
			agent: agent2,
			sessionManager,
			settingsManager,
			cwd,
			modelRegistry,
			resourceLoader,
		});
		expect(s2.systemPrompt).toContain("[1] (max 700 chars) persist");
		s2.dispose();
	});
});
