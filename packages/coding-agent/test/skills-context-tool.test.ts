import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createSkillsContextToolDefinition } from "../src/core/tools/skills-context.js";

function mockCtx(lines: string[]): ExtensionContext {
	return {
		skillsContext: {
			load: () => ({ loaded: true, alreadyLoaded: false }),
			unload: () => ({ unloaded: true, wasLoaded: true }),
			listActive: () => ["a"],
			listDiscovered: () => lines,
			history: () => [],
		},
	} as unknown as ExtensionContext;
}

describe("skills_context tool", () => {
	const def = createSkillsContextToolDefinition();

	it("accepts action list as alias for list_discovered", async () => {
		const ctx = mockCtx(["skill-one: First", "skill-two: Second"]);
		const r = await def.execute("c1", { action: "list" }, undefined, undefined, ctx);
		expect(r.content[0]?.type).toBe("text");
		expect((r.content[0] as { text: string }).text).toContain("skill-one:");
	});

	it("accepts list_discovered", async () => {
		const ctx = mockCtx(["x: X desc"]);
		const r = await def.execute("c2", { action: "list_discovered" }, undefined, undefined, ctx);
		expect((r.content[0] as { text: string }).text).toBe("x: X desc");
	});
});
