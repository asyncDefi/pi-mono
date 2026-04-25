import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createMcpContextToolDefinition } from "../src/core/tools/mcp-context.js";

function mockCtx(lines: string[]): ExtensionContext {
	return {
		mcpContext: {
			load: async () => ({ loaded: true, alreadyLoaded: false, toolNames: ["mcp__docs__search"] }),
			unload: async () => ({ unloaded: true, wasLoaded: true }),
			listActive: () => ["docs: mcp__docs__search"],
			listDiscovered: () => lines,
			history: () => [],
		},
	} as unknown as ExtensionContext;
}

describe("mcp_context tool", () => {
	const def = createMcpContextToolDefinition();

	it("accepts action list as alias for list_discovered", async () => {
		const ctx = mockCtx(["docs: Docs search", "unity: Unity editor"]);
		const result = await def.execute("c1", { action: "list" }, undefined, undefined, ctx);

		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("docs:");
	});

	it("loads a configured MCP server", async () => {
		const ctx = mockCtx(["docs: Docs search"]);
		const result = await def.execute("c2", { action: "load", name: "docs" }, undefined, undefined, ctx);

		expect((result.content[0] as { text: string }).text).toContain('MCP server "docs" loaded');
		expect((result.content[0] as { text: string }).text).toContain("mcp__docs__search");
	});
});
