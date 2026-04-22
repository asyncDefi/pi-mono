import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { executeBashWithOperations } from "../src/core/bash-executor.js";
import {
	assertBashCommandAllowedForProjectConfig,
	assertPathAllowedForProjectConfig,
	bashCommandReferencesProjectConfigPath,
	getFdProjectConfigExcludePatterns,
	getFindCustomGlobProjectConfigIgnores,
	getProjectConfigRelativeToSearchRoot,
	getProjectConfigRoot,
	getRipgrepProjectConfigExcludeGlobs,
	isPathInsideProjectConfig,
} from "../src/core/tools/project-config-access.js";
import { createBashTool, createLocalBashOperations, createReadTool } from "../src/index.js";

describe("project-config-access", () => {
	const cwd = join(tmpdir(), `pi-project-config-test-${Date.now()}`);
	const blockedRoot = join(cwd, CONFIG_DIR_NAME);
	const nestedFile = join(blockedRoot, "skills", "x", "SKILL.md");

	beforeEach(() => {
		mkdirSync(join(blockedRoot, "skills", "x"), { recursive: true });
		writeFileSync(nestedFile, "---\nname: x\n---\n");
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("getProjectConfigRoot resolves under cwd", () => {
		expect(getProjectConfigRoot(cwd)).toBe(blockedRoot);
	});

	it("isPathInsideProjectConfig is true for root and nested files", () => {
		expect(isPathInsideProjectConfig(blockedRoot, cwd)).toBe(true);
		expect(isPathInsideProjectConfig(nestedFile, cwd)).toBe(true);
	});

	it("isPathInsideProjectConfig is false for sibling of config dir", () => {
		const sibling = join(cwd, "src", "a.ts");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(sibling, "");
		expect(isPathInsideProjectConfig(sibling, cwd)).toBe(false);
	});

	it("assertPathAllowedForProjectConfig throws inside config tree", () => {
		expect(() => assertPathAllowedForProjectConfig(nestedFile, cwd)).toThrow(/not allowed via this tool/);
	});

	it("assertPathAllowedForProjectConfig allows paths outside config", () => {
		const f = join(cwd, "readme.md");
		writeFileSync(f, "ok");
		expect(() => assertPathAllowedForProjectConfig(f, cwd)).not.toThrow();
	});

	it("getProjectConfigRelativeToSearchRoot returns relative segment from search root", () => {
		expect(getProjectConfigRelativeToSearchRoot(cwd, cwd)).toBe(CONFIG_DIR_NAME);
		expect(getProjectConfigRelativeToSearchRoot(join(cwd, "src"), cwd)).toBeNull();
	});

	it("getRipgrepProjectConfigExcludeGlobs excludes config subtree when searching cwd", () => {
		expect(getRipgrepProjectConfigExcludeGlobs(cwd, cwd)).toEqual([`!${CONFIG_DIR_NAME}/**`, `!${CONFIG_DIR_NAME}`]);
	});

	it("getFdProjectConfigExcludePatterns matches config subtree when searching cwd", () => {
		expect(getFdProjectConfigExcludePatterns(cwd, cwd)).toEqual([CONFIG_DIR_NAME, `${CONFIG_DIR_NAME}/**`]);
	});

	it("getFindCustomGlobProjectConfigIgnores returns extra ignore globs", () => {
		const ignores = getFindCustomGlobProjectConfigIgnores(cwd, cwd);
		expect(ignores.some((g) => g.includes(CONFIG_DIR_NAME))).toBe(true);
	});

	it("read tool rejects paths under project config", async () => {
		const readTool = createReadTool(cwd);
		await expect(readTool.execute("t1", { path: join(CONFIG_DIR_NAME, "skills", "x", "SKILL.md") })).rejects.toThrow(
			/not allowed via this tool/,
		);
	});

	describe("bash project-config guard", () => {
		it("bashCommandReferencesProjectConfigPath detects path-like .pi segments", () => {
			expect(bashCommandReferencesProjectConfigPath(`cat foo/${CONFIG_DIR_NAME}/settings.json`)).toBe(true);
			expect(bashCommandReferencesProjectConfigPath(`ls ./${CONFIG_DIR_NAME}`)).toBe(true);
			expect(bashCommandReferencesProjectConfigPath(`cd ${CONFIG_DIR_NAME}`)).toBe(true);
		});

		it("bashCommandReferencesProjectConfigPath ignores unrelated strings", () => {
			expect(bashCommandReferencesProjectConfigPath("echo api.pi.example.com")).toBe(false);
			expect(bashCommandReferencesProjectConfigPath("ls ./src")).toBe(false);
		});

		it("assertBashCommandAllowedForProjectConfig throws with explicit reason", () => {
			expect(() => assertBashCommandAllowedForProjectConfig(`cat ${CONFIG_DIR_NAME}/x`)).toThrow(/rejected because/);
		});

		it("bash tool rejects commands referencing project config path", async () => {
			const bashTool = createBashTool(cwd);
			await expect(bashTool.execute("t-bash", { command: `cat ${CONFIG_DIR_NAME}/settings.json` })).rejects.toThrow(
				/rejected because/,
			);
		});

		it("executeBashWithOperations rejects before spawn", async () => {
			await expect(
				executeBashWithOperations(`ls ${CONFIG_DIR_NAME}`, cwd, createLocalBashOperations()),
			).rejects.toThrow(/rejected because/);
		});
	});
});
