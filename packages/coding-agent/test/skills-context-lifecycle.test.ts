import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterAll, describe, expect, test } from "vitest";
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

function createResourceLoaderWithSkills(skills: Skill[]): ResourceLoader {
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

const createdSkillDirs: string[] = [];

function createSkill(name: string): Skill {
	const baseDir = mkdtempSync(join(tmpdir(), `pi-skill-${name}-`));
	createdSkillDirs.push(baseDir);
	const filePath = join(baseDir, "SKILL.md");
	writeFileSync(
		filePath,
		`---
name: ${name}
description: Skill ${name}
---

# ${name}

Skill body for tests.
`,
		"utf-8",
	);
	return {
		name,
		description: `Skill ${name}`,
		filePath,
		baseDir,
		sourceInfo: createSourceInfo(filePath, {
			source: "project",
			scope: "temporary",
			origin: "top-level",
		}),
		disableModelInvocation: false,
	};
}

afterAll(() => {
	for (const dir of createdSkillDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

describe("skills context lifecycle", () => {
	test("loads/unloads skills into system prompt and keeps last 5 events", () => {
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

		expect(session.systemPrompt).not.toContain("<LOADED_SKILLS>");

		(session as any)._loadSkillIntoContext("ui");
		expect(session.systemPrompt).toContain("<LOADED_SKILLS>");
		expect(session.systemPrompt).toContain("<SKILL_ui ");
		expect(session.systemPrompt).toContain('name="ui"');
		expect(session.systemPrompt).toContain("Skill body for tests.");

		(session as any)._unloadSkillFromContext("ui");
		expect(session.systemPrompt).not.toContain("<LOADED_SKILLS>");

		// 6 events -> keep last 5
		(session as any)._loadSkillIntoContext("ui");
		(session as any)._unloadSkillFromContext("ui");
		(session as any)._loadSkillIntoContext("ui");
		(session as any)._unloadSkillFromContext("ui");
		(session as any)._loadSkillIntoContext("ui");
		(session as any)._unloadSkillFromContext("ui");

		const history = (session as any)._getSkillsContextHistory();
		expect(history).toHaveLength(5);
		expect(history[history.length - 1].action).toBe("unloaded");

		session.dispose();
	});

	test("lists discovered skill summaries from resource loader", () => {
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

		const lines = (session as unknown as { _listDiscoveredSkillLines(): string[] })._listDiscoveredSkillLines();
		expect(lines.some((l) => l.startsWith("ui:"))).toBe(true);

		session.dispose();
	});

	test("restores active skills from session custom entries", () => {
		const cwd = process.cwd();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent1 = new Agent({
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

		const s1 = new AgentSession({
			agent: agent1,
			sessionManager,
			settingsManager,
			cwd,
			modelRegistry,
			resourceLoader,
		});
		(s1 as any)._loadSkillIntoContext("ui");
		s1.dispose();

		const agent2 = new Agent({
			getApiKey: () => "test",
			initialState: {
				model,
				systemPrompt: "base",
				tools: createCodingTools(cwd),
			},
		});
		const s2 = new AgentSession({
			agent: agent2,
			sessionManager,
			settingsManager,
			cwd,
			modelRegistry,
			resourceLoader,
		});

		expect(s2.systemPrompt).toContain("<SKILL_ui ");
		expect(s2.systemPrompt).toContain("Skill body for tests.");
		s2.dispose();
	});
});
