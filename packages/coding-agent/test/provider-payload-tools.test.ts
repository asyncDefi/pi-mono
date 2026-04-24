import { describe, expect, it } from "vitest";
import { extractOutboundToolSummaries } from "../src/core/provider-payload-tools.js";

describe("extractOutboundToolSummaries", () => {
	it("reads Anthropic-style tools", () => {
		const tools = extractOutboundToolSummaries({
			model: "claude-3",
			tools: [
				{ name: "read", description: "Read files", input_schema: { type: "object", properties: {} } },
				{ name: "mcp_search", description: "MCP", input_schema: { type: "object", properties: { q: {} } } },
			],
		});
		expect(tools).toEqual([
			{
				name: "read",
				description: "Read files",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "mcp_search",
				description: "MCP",
				parameters: { type: "object", properties: { q: {} } },
			},
		]);
	});

	it("reads OpenAI-style tools", () => {
		const tools = extractOutboundToolSummaries({
			tools: [
				{
					type: "function",
					function: {
						name: "alpha",
						description: "A",
						parameters: { type: "object" },
					},
				},
			],
		});
		expect(tools).toEqual([{ name: "alpha", description: "A", parameters: { type: "object" } }]);
	});

	it("returns empty for missing or invalid payload", () => {
		expect(extractOutboundToolSummaries(null)).toEqual([]);
		expect(extractOutboundToolSummaries({})).toEqual([]);
		expect(extractOutboundToolSummaries({ tools: "nope" })).toEqual([]);
	});
});
