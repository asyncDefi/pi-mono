import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpServers, mcpToolName } from "../src/core/mcp.js";

describe("MCP config", () => {
	it("loads stdio and HTTP servers from .pi/mcp.json", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
		try {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						docs: {
							command: "node",
							args: ["./server.js"],
							description: "Docs search",
						},
						unity: {
							baseUrl: "http://localhost:8080",
						},
						disabled: {
							command: "node",
							disabled: true,
						},
					},
				}),
				"utf-8",
			);

			const result = loadMcpServers({ cwd });

			expect(result.diagnostics).toHaveLength(0);
			expect(result.servers.map((server) => server.name)).toEqual(["docs", "unity"]);
			expect(result.servers[0].config).toMatchObject({ type: "stdio", command: "node", args: ["./server.js"] });
			expect(result.servers[1].config).toMatchObject({ type: "http", url: "http://localhost:8080/mcp" });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps MCP tool names provider-safe and stable", () => {
		expect(mcpToolName("docs", "search")).toBe("mcp__docs__search");
		const longName = mcpToolName("very-long-server-name-that-still-has-safe-characters", "tool".repeat(30));
		expect(longName.length).toBeLessThanOrEqual(64);
		expect(longName).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});
