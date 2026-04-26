import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createStdioMcpProcessEnv,
	getImplicitStdioMcpEnvKeys,
	loadMcpServers,
	mcpToolName,
	resolveStdioMcpSpawnCommand,
} from "../src/core/mcp.js";

function portableSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

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

	it("defaults Python stdio MCP servers to UTF-8 mode unless configured", () => {
		const config = { type: "stdio" as const, command: "C:\\tools\\python.exe", args: ["-m", "errors_log"] };
		const env = createStdioMcpProcessEnv(config, {});
		expect(getImplicitStdioMcpEnvKeys(config, {})).toEqual(["PYTHONUTF8", "PYTHONIOENCODING"]);
		expect(env.PYTHONUTF8).toBe("1");
		expect(env.PYTHONIOENCODING).toBe("utf-8");

		const explicitEnv = createStdioMcpProcessEnv(
			{
				type: "stdio",
				command: "python",
				args: ["-m", "errors_log"],
				env: { PYTHONUTF8: "0", PYTHONIOENCODING: "cp1251" },
			},
			{},
		);
		expect(explicitEnv.PYTHONUTF8).toBe("0");
		expect(explicitEnv.PYTHONIOENCODING).toBe("cp1251");
	});

	it("wraps Windows cmd shims resolved from PATH", () => {
		const result = resolveStdioMcpSpawnCommand(
			{ type: "stdio", command: "errors-log-mcp", args: ["--stdio"] },
			{
				cwd: "/project",
				env: {
					ComSpec: "C:\\Windows\\System32\\cmd.exe",
					Path: "/tool/bin",
					PATHEXT: ".EXE;.CMD",
				},
				fileExists: (path) => portableSlashes(path).endsWith("/tool/bin/errors-log-mcp.CMD"),
				platform: "win32",
			},
		);

		expect(result.command).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(result.args.slice(0, 2)).toEqual(["/d", "/c"]);
		expect(portableSlashes(result.args[2])).toMatch(/\/tool\/bin\/errors-log-mcp\.CMD$/);
		expect(result.args.slice(3)).toEqual(["--stdio"]);
	});

	it("keeps Windows exe MCP commands shell-free", () => {
		const result = resolveStdioMcpSpawnCommand(
			{ type: "stdio", command: "python", args: ["-m", "errors_log"] },
			{
				cwd: "/project",
				env: {
					Path: "/tool/bin",
					PATHEXT: ".EXE;.CMD",
				},
				fileExists: (path) => portableSlashes(path).endsWith("/tool/bin/python.EXE"),
				platform: "win32",
			},
		);

		expect(portableSlashes(result.command)).toMatch(/\/tool\/bin\/python\.EXE$/);
		expect(result.args).toEqual(["-m", "errors_log"]);
	});

	it("leaves non-Windows MCP commands unchanged", () => {
		const result = resolveStdioMcpSpawnCommand(
			{ type: "stdio", command: "errors-log-mcp", args: ["--stdio"] },
			{
				cwd: "/project",
				env: { Path: "/tool/bin", PATHEXT: ".EXE;.CMD" },
				fileExists: () => true,
				platform: "linux",
			},
		);

		expect(result).toEqual({ command: "errors-log-mcp", args: ["--stdio"] });
	});
});
