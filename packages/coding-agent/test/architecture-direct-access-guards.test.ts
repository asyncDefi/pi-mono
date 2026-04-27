import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ARCHITECTURE_ACCESS_MESSAGE,
	ARCHITECTURE_FILE_NAME,
	ARCHITECTURE_READ_MESSAGE,
	ARCHITECTURE_UPDATE_MESSAGE,
} from "../src/core/architecture.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { createFindToolDefinition } from "../src/core/tools/find.js";
import { createGrepToolDefinition } from "../src/core/tools/grep.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";

const tempDirs: string[] = [];

function createTempProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-architecture-guards-"));
	tempDirs.push(cwd);
	mkdirSync(join(cwd, "src"));
	writeFileSync(
		join(cwd, ARCHITECTURE_FILE_NAME),
		'{\n\t"schemaVersion": 1,\n\t"systems": [],\n\t"relations": []\n}\n',
		"utf-8",
	);
	writeFileSync(join(cwd, "src", "index.ts"), "export const value = 1;\n", "utf-8");
	return cwd;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("architecture.json direct access guards", () => {
	const noCtx = undefined as unknown as ExtensionContext;

	test("read returns architecture_context warning instead of file contents", async () => {
		const cwd = createTempProject();
		const read = createReadToolDefinition(cwd);

		const result = await read.execute("read", { path: ARCHITECTURE_FILE_NAME }, undefined, undefined, noCtx);

		expect((result.content[0] as { text: string }).text).toBe(ARCHITECTURE_READ_MESSAGE);
		expect((result.content[0] as { text: string }).text).not.toContain("schemaVersion");
	});

	test("write and edit reject architecture.json updates", async () => {
		const cwd = createTempProject();
		const write = createWriteToolDefinition(cwd);
		const edit = createEditToolDefinition(cwd);

		await expect(
			write.execute("write", { path: ARCHITECTURE_FILE_NAME, content: "{}" }, undefined, undefined, noCtx),
		).rejects.toThrow(ARCHITECTURE_UPDATE_MESSAGE);
		await expect(
			edit.execute(
				"edit",
				{
					path: ARCHITECTURE_FILE_NAME,
					edits: [{ oldText: '"systems": []', newText: '"systems": []' }],
				},
				undefined,
				undefined,
				noCtx,
			),
		).rejects.toThrow(ARCHITECTURE_UPDATE_MESSAGE);
	});

	test("find hides architecture.json results", async () => {
		const cwd = createTempProject();
		const find = createFindToolDefinition(cwd, {
			operations: {
				exists: () => true,
				glob: () => [join(cwd, ARCHITECTURE_FILE_NAME), join(cwd, "src", "index.ts")],
			},
		});

		const result = await find.execute("find", { pattern: "**/*.ts", path: "." }, undefined, undefined, noCtx);
		const text = (result.content[0] as { text: string }).text;

		expect(text).toContain("src/index.ts");
		expect(text).not.toContain(ARCHITECTURE_FILE_NAME);
	});

	test("grep rejects direct architecture.json search", async () => {
		const cwd = createTempProject();
		const grep = createGrepToolDefinition(cwd);

		await expect(
			grep.execute("grep", { pattern: "schemaVersion", path: ARCHITECTURE_FILE_NAME }, undefined, undefined, noCtx),
		).rejects.toThrow(ARCHITECTURE_READ_MESSAGE);
	});

	test("bash rejects explicit architecture.json references", async () => {
		const cwd = createTempProject();
		const bash = createBashToolDefinition(cwd);

		await expect(
			bash.execute("bash", { command: `cat ${ARCHITECTURE_FILE_NAME}` }, undefined, undefined, noCtx),
		).rejects.toThrow(ARCHITECTURE_ACCESS_MESSAGE);
	});
});
