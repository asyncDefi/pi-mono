import { describe, expect, it } from "vitest";
import { buildMcpToSkillPrompt } from "../src/core/mcp-to-skill.js";

describe("buildMcpToSkillPrompt", () => {
	it("targets the project .pi skills directory and forbids MCP runtime dependencies", () => {
		const prompt = buildMcpToSkillPrompt({
			capabilities: '{"tools":[{"name":"search-docs"}]}',
			sourceLabel: "mcp.json",
			projectSkillDir: "/repo/.pi/skills",
		});

		expect(prompt).toContain("/repo/.pi/skills/<skill-name>/ with a SKILL.md file");
		expect(prompt).toContain("Do not install or depend on MCP packages");
		expect(prompt).toContain("Create .pi/skills/<skill-name>/SKILL.md");
		expect(prompt).toContain("Source: mcp.json");
		expect(prompt).toContain("<MCP_CAPABILITIES>");
		expect(prompt).toContain("search-docs");
	});

	it("trims surrounding whitespace from capabilities", () => {
		const prompt = buildMcpToSkillPrompt({
			capabilities: "\n\n  tool-a  \n",
			projectSkillDir: "/repo/.pi/skills",
		});

		expect(prompt).toContain("\n<MCP_CAPABILITIES>\ntool-a\n</MCP_CAPABILITIES>");
	});
});
