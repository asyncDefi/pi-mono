import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

export const ARCHITECTURE_FILE_NAME = "architecture.json";
export const ARCHITECTURE_SCHEMA_VERSION = 1;

export const ARCHITECTURE_READ_MESSAGE = "Use architecture_context to read architecture.json.";
export const ARCHITECTURE_UPDATE_MESSAGE = "Use architecture_context to update architecture.json.";
export const ARCHITECTURE_ACCESS_MESSAGE = "Use architecture_context to read or update architecture.json.";

const stringListSchema = Type.Array(Type.String());

export const architectureScriptSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		path: Type.String({ minLength: 1 }),
		name: Type.Optional(Type.String()),
		responsibility: Type.String({ minLength: 1 }),
		publicSurface: Type.Optional(stringListSchema),
		dependsOn: Type.Optional(stringListSchema),
		notes: Type.Optional(stringListSchema),
	},
	{ additionalProperties: false },
);

export const architectureContainerSchema = Type.Recursive(
	(Self) =>
		Type.Object(
			{
				id: Type.String({ minLength: 1 }),
				name: Type.String({ minLength: 1 }),
				responsibility: Type.String({ minLength: 1 }),
				boundaries: Type.Optional(stringListSchema),
				publicSurface: Type.Optional(stringListSchema),
				scripts: Type.Optional(Type.Array(architectureScriptSchema)),
				subsystems: Type.Optional(Type.Array(Self)),
				notes: Type.Optional(stringListSchema),
			},
			{ additionalProperties: false },
		),
	{ $id: "ArchitectureContainer" },
);

export const architectureRelationSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		kind: Type.String({ minLength: 1 }),
		from: Type.String({ minLength: 1 }),
		to: Type.String({ minLength: 1 }),
		summary: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const architectureGraphSchema = Type.Object(
	{
		schemaVersion: Type.Literal(ARCHITECTURE_SCHEMA_VERSION),
		systems: Type.Array(architectureContainerSchema),
		relations: Type.Array(architectureRelationSchema),
	},
	{ additionalProperties: false },
);

export type ArchitectureScript = Static<typeof architectureScriptSchema>;
export type ArchitectureContainer = Static<typeof architectureContainerSchema>;
export type ArchitectureRelation = Static<typeof architectureRelationSchema>;
export type ArchitectureGraph = Static<typeof architectureGraphSchema>;

export type ArchitectureNodeKind = "system" | "subsystem" | "script";

export interface ArchitectureNodeRef {
	id: string;
	kind: ArchitectureNodeKind;
	name: string;
	path?: string;
	parentId?: string;
	node: ArchitectureContainer | ArchitectureScript;
}

export interface ArchitectureStatus {
	path: string;
	exists: boolean;
	valid: boolean;
	systemCount: number;
	relationCount: number;
	errors: string[];
}

const architectureGraphValidator = TypeCompiler.Compile(architectureGraphSchema);

export function createEmptyArchitectureGraph(): ArchitectureGraph {
	return {
		schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
		systems: [],
		relations: [],
	};
}

export function getArchitectureFilePath(cwd: string): string {
	return path.resolve(cwd, ARCHITECTURE_FILE_NAME);
}

export function isArchitectureFilePath(absolutePath: string, cwd: string): boolean {
	return path.resolve(absolutePath) === getArchitectureFilePath(cwd);
}

export function architectureAccessMessage(access: "read" | "update" | "read_or_update"): string {
	if (access === "read") return ARCHITECTURE_READ_MESSAGE;
	if (access === "update") return ARCHITECTURE_UPDATE_MESSAGE;
	return ARCHITECTURE_ACCESS_MESSAGE;
}

export function assertPathAllowedForArchitectureFile(
	absolutePath: string,
	cwd: string,
	access: "read" | "update" | "read_or_update",
): void {
	if (isArchitectureFilePath(absolutePath, cwd)) {
		throw new Error(architectureAccessMessage(access));
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function bashCommandReferencesArchitectureFile(command: string): boolean {
	const fileName = escapeRegExp(ARCHITECTURE_FILE_NAME);
	const delim = `[\\s"'=(;|&\\x60]`;
	const after = `(?:$|[\\s"'):;|&\\x60]|\\n)`;
	const re = new RegExp(
		`(?:^|${delim})\\./${fileName}${after}` +
			`|(?:^|${delim})\\.\\\\${fileName}${after}` +
			`|[/\\\\]${fileName}${after}` +
			`|(?:^|${delim})${fileName}${after}`,
	);
	return re.test(command);
}

export function assertBashCommandAllowedForArchitectureFile(command: string): void {
	if (bashCommandReferencesArchitectureFile(command)) {
		throw new Error(ARCHITECTURE_ACCESS_MESSAGE);
	}
}

function getArchitectureRelativeToSearchRoot(searchPath: string, cwd: string): string | null {
	const architecturePath = getArchitectureFilePath(cwd);
	const searchResolved = path.resolve(searchPath);
	if (isArchitectureFilePath(searchResolved, cwd)) {
		return null;
	}
	const rel = path.relative(searchResolved, architecturePath);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		return null;
	}
	return rel.split(path.sep).join("/");
}

export function getRipgrepArchitectureExcludeGlobs(searchPath: string, cwd: string): string[] {
	const posixRel = getArchitectureRelativeToSearchRoot(searchPath, cwd);
	return posixRel ? [`!${posixRel}`] : [];
}

export function getFdArchitectureExcludePatterns(searchPath: string, cwd: string): string[] {
	const posixRel = getArchitectureRelativeToSearchRoot(searchPath, cwd);
	return posixRel ? [posixRel] : [];
}

export function getFindCustomGlobArchitectureIgnores(searchPath: string, cwd: string): string[] {
	const posixRel = getArchitectureRelativeToSearchRoot(searchPath, cwd);
	return posixRel ? [posixRel, `**/${posixRel}`] : [];
}

function formatSchemaErrors(value: unknown): string[] {
	return Array.from(architectureGraphValidator.Errors(value)).map((error) => {
		const pathText = error.path || "root";
		return `${pathText}: ${error.message}`;
	});
}

function collectContainerNodes(
	container: ArchitectureContainer,
	kind: "system" | "subsystem",
	parentId: string | undefined,
	nodes: ArchitectureNodeRef[],
): void {
	nodes.push({ id: container.id, kind, name: container.name, parentId, node: container });
	for (const script of container.scripts ?? []) {
		nodes.push({
			id: script.id,
			kind: "script",
			name: script.name ?? script.path,
			path: script.path,
			parentId: container.id,
			node: script,
		});
	}
	for (const subsystem of container.subsystems ?? []) {
		collectContainerNodes(subsystem, "subsystem", container.id, nodes);
	}
}

export function listArchitectureNodes(graph: ArchitectureGraph): ArchitectureNodeRef[] {
	const nodes: ArchitectureNodeRef[] = [];
	for (const system of graph.systems) {
		collectContainerNodes(system, "system", undefined, nodes);
	}
	return nodes;
}

export function findArchitectureNode(graph: ArchitectureGraph, id: string): ArchitectureNodeRef | undefined {
	return listArchitectureNodes(graph).find((node) => node.id === id);
}

export function collectArchitectureSubtreeIds(graph: ArchitectureGraph, id: string): Set<string> {
	const target = findArchitectureNode(graph, id);
	const ids = new Set<string>();
	if (!target) return ids;
	ids.add(target.id);
	if (target.kind === "script") return ids;

	const visit = (container: ArchitectureContainer): void => {
		for (const script of container.scripts ?? []) {
			ids.add(script.id);
		}
		for (const subsystem of container.subsystems ?? []) {
			ids.add(subsystem.id);
			visit(subsystem);
		}
	};
	visit(target.node as ArchitectureContainer);
	return ids;
}

export function validateArchitectureGraph(
	value: unknown,
): { valid: true; graph: ArchitectureGraph } | { valid: false; errors: string[] } {
	if (!architectureGraphValidator.Check(value)) {
		return { valid: false, errors: formatSchemaErrors(value) };
	}

	const graph = value as ArchitectureGraph;
	const ids = new Set<string>();
	const errors: string[] = [];
	for (const node of listArchitectureNodes(graph)) {
		if (ids.has(node.id)) {
			errors.push(`duplicate id: ${node.id}`);
		}
		ids.add(node.id);
	}
	for (const relation of graph.relations) {
		if (ids.has(relation.id)) {
			errors.push(`relation id duplicates node id: ${relation.id}`);
		}
		if (!ids.has(relation.from)) {
			errors.push(`relation "${relation.id}" references missing from node: ${relation.from}`);
		}
		if (!ids.has(relation.to)) {
			errors.push(`relation "${relation.id}" references missing to node: ${relation.to}`);
		}
		ids.add(relation.id);
	}

	return errors.length > 0 ? { valid: false, errors } : { valid: true, graph };
}

function parseArchitectureJson(raw: string, filePath: string): ArchitectureGraph {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${ARCHITECTURE_FILE_NAME}: ${message}`);
	}
	const validation = validateArchitectureGraph(parsed);
	if (!validation.valid) {
		throw new Error(`Invalid ${ARCHITECTURE_FILE_NAME} at ${filePath}:\n${validation.errors.join("\n")}`);
	}
	return validation.graph;
}

export async function readArchitectureGraph(cwd: string): Promise<ArchitectureGraph | undefined> {
	const filePath = getArchitectureFilePath(cwd);
	if (!existsSync(filePath)) return undefined;
	return parseArchitectureJson(await readFile(filePath, "utf-8"), filePath);
}

export function readArchitectureGraphSync(cwd: string): ArchitectureGraph | undefined {
	const filePath = getArchitectureFilePath(cwd);
	if (!existsSync(filePath)) return undefined;
	return parseArchitectureJson(readFileSync(filePath, "utf-8"), filePath);
}

export async function readArchitectureGraphOrEmpty(cwd: string): Promise<ArchitectureGraph> {
	return (await readArchitectureGraph(cwd)) ?? createEmptyArchitectureGraph();
}

export async function writeArchitectureGraph(cwd: string, graph: ArchitectureGraph): Promise<void> {
	const validation = validateArchitectureGraph(graph);
	if (!validation.valid) {
		throw new Error(`Invalid ${ARCHITECTURE_FILE_NAME}:\n${validation.errors.join("\n")}`);
	}
	await writeFile(getArchitectureFilePath(cwd), `${JSON.stringify(validation.graph, null, "\t")}\n`, "utf-8");
}

export async function getArchitectureStatus(cwd: string): Promise<ArchitectureStatus> {
	const filePath = getArchitectureFilePath(cwd);
	if (!existsSync(filePath)) {
		return { path: filePath, exists: false, valid: false, systemCount: 0, relationCount: 0, errors: [] };
	}
	try {
		const raw = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		const validation = validateArchitectureGraph(parsed);
		if (!validation.valid) {
			return {
				path: filePath,
				exists: true,
				valid: false,
				systemCount: 0,
				relationCount: 0,
				errors: validation.errors,
			};
		}
		return {
			path: filePath,
			exists: true,
			valid: true,
			systemCount: validation.graph.systems.length,
			relationCount: validation.graph.relations.length,
			errors: [],
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { path: filePath, exists: true, valid: false, systemCount: 0, relationCount: 0, errors: [message] };
	}
}

function cloneGraph(graph: ArchitectureGraph): ArchitectureGraph {
	return structuredClone(graph);
}

function findContainer(containers: ArchitectureContainer[], id: string): ArchitectureContainer | undefined {
	for (const container of containers) {
		if (container.id === id) return container;
		const child = findContainer(container.subsystems ?? [], id);
		if (child) return child;
	}
	return undefined;
}

function replaceSubsystem(containers: ArchitectureContainer[], subsystem: ArchitectureContainer): boolean {
	for (let i = 0; i < containers.length; i++) {
		const current = containers[i];
		if (current.id === subsystem.id) {
			containers[i] = subsystem;
			return true;
		}
		if (replaceSubsystem(current.subsystems ?? [], subsystem)) {
			return true;
		}
	}
	return false;
}

function replaceScript(containers: ArchitectureContainer[], script: ArchitectureScript): boolean {
	for (const container of containers) {
		const scripts = container.scripts ?? [];
		const index = scripts.findIndex((candidate) => candidate.id === script.id);
		if (index >= 0) {
			scripts[index] = script;
			container.scripts = scripts;
			return true;
		}
		if (replaceScript(container.subsystems ?? [], script)) {
			return true;
		}
	}
	return false;
}

export function upsertArchitectureSystem(graph: ArchitectureGraph, system: ArchitectureContainer): ArchitectureGraph {
	const next = cloneGraph(graph);
	const index = next.systems.findIndex((candidate) => candidate.id === system.id);
	if (index >= 0) {
		next.systems[index] = system;
	} else {
		next.systems.push(system);
	}
	return assertValidArchitectureGraph(next);
}

export function upsertArchitectureSubsystem(
	graph: ArchitectureGraph,
	parentId: string,
	subsystem: ArchitectureContainer,
): ArchitectureGraph {
	const next = cloneGraph(graph);
	if (!replaceSubsystem(next.systems, subsystem)) {
		const parent = findContainer(next.systems, parentId);
		if (!parent) {
			throw new Error(`Parent system/subsystem not found: ${parentId}`);
		}
		parent.subsystems = [...(parent.subsystems ?? []), subsystem];
	}
	return assertValidArchitectureGraph(next);
}

export function upsertArchitectureScript(
	graph: ArchitectureGraph,
	containerId: string,
	script: ArchitectureScript,
): ArchitectureGraph {
	const next = cloneGraph(graph);
	if (!replaceScript(next.systems, script)) {
		const container = findContainer(next.systems, containerId);
		if (!container) {
			throw new Error(`System/subsystem not found: ${containerId}`);
		}
		container.scripts = [...(container.scripts ?? []), script];
	}
	return assertValidArchitectureGraph(next);
}

export function upsertArchitectureRelation(
	graph: ArchitectureGraph,
	relation: ArchitectureRelation,
): ArchitectureGraph {
	const next = cloneGraph(graph);
	const index = next.relations.findIndex((candidate) => candidate.id === relation.id);
	if (index >= 0) {
		next.relations[index] = relation;
	} else {
		next.relations.push(relation);
	}
	return assertValidArchitectureGraph(next);
}

function removeFromContainers(containers: ArchitectureContainer[], id: string, removedIds: Set<string>): boolean {
	const index = containers.findIndex((container) => container.id === id);
	if (index >= 0) {
		const graph: ArchitectureGraph = {
			schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
			systems: [containers[index]],
			relations: [],
		};
		for (const node of listArchitectureNodes(graph)) removedIds.add(node.id);
		containers.splice(index, 1);
		return true;
	}

	for (const container of containers) {
		const scripts = container.scripts ?? [];
		const scriptIndex = scripts.findIndex((script) => script.id === id);
		if (scriptIndex >= 0) {
			removedIds.add(scripts[scriptIndex].id);
			scripts.splice(scriptIndex, 1);
			container.scripts = scripts;
			return true;
		}
		if (removeFromContainers(container.subsystems ?? [], id, removedIds)) {
			return true;
		}
	}
	return false;
}

export function removeArchitectureItem(
	graph: ArchitectureGraph,
	id: string,
): { graph: ArchitectureGraph; removed: boolean } {
	const next = cloneGraph(graph);
	const removedIds = new Set<string>();
	const relationIndex = next.relations.findIndex((relation) => relation.id === id);
	let removed = false;
	if (relationIndex >= 0) {
		next.relations.splice(relationIndex, 1);
		removed = true;
	} else {
		removed = removeFromContainers(next.systems, id, removedIds);
		if (removedIds.size > 0) {
			next.relations = next.relations.filter(
				(relation) =>
					!removedIds.has(relation.from) && !removedIds.has(relation.to) && !removedIds.has(relation.id),
			);
		}
	}
	return { graph: assertValidArchitectureGraph(next), removed };
}

function assertValidArchitectureGraph(graph: ArchitectureGraph): ArchitectureGraph {
	const validation = validateArchitectureGraph(graph);
	if (!validation.valid) {
		throw new Error(`Invalid ${ARCHITECTURE_FILE_NAME}:\n${validation.errors.join("\n")}`);
	}
	return validation.graph;
}

function formatList(title: string, values: string[] | undefined, indent = ""): string[] {
	if (!values || values.length === 0) return [];
	return [`${indent}${title}:`, ...values.map((value) => `${indent}- ${value}`)];
}

function formatContainerSummary(container: ArchitectureContainer, indent = ""): string[] {
	const lines = [
		`${indent}${container.id}: ${container.name}`,
		`${indent}Responsibility: ${container.responsibility}`,
		...formatList("Boundaries", container.boundaries, indent),
		...formatList("Public surface", container.publicSurface, indent),
		...formatList("Notes", container.notes, indent),
	];

	const childIndent = `${indent}  `;
	for (const subsystem of container.subsystems ?? []) {
		lines.push(`${indent}Subsystem: ${subsystem.id}: ${subsystem.name}`);
		lines.push(`${childIndent}Responsibility: ${subsystem.responsibility}`);
		lines.push(...formatList("Boundaries", subsystem.boundaries, childIndent));
		lines.push(...formatContainerSummaryChildren(subsystem, childIndent));
	}
	lines.push(...formatContainerScripts(container, indent));
	return lines;
}

function formatContainerSummaryChildren(container: ArchitectureContainer, indent: string): string[] {
	const lines: string[] = [];
	for (const subsystem of container.subsystems ?? []) {
		lines.push(`${indent}Subsystem: ${subsystem.id}: ${subsystem.name}`);
		lines.push(`${indent}  Responsibility: ${subsystem.responsibility}`);
		lines.push(...formatContainerSummaryChildren(subsystem, `${indent}  `));
	}
	lines.push(...formatContainerScripts(container, indent));
	return lines;
}

function formatContainerScripts(container: ArchitectureContainer, indent: string): string[] {
	const lines: string[] = [];
	for (const script of container.scripts ?? []) {
		lines.push(`${indent}Script: ${script.id} (${script.path})`);
		lines.push(`${indent}  Responsibility: ${script.responsibility}`);
		if (script.publicSurface?.length) {
			lines.push(...formatList("Public surface", script.publicSurface, `${indent}  `));
		}
		if (script.dependsOn?.length) {
			lines.push(...formatList("Depends on", script.dependsOn, `${indent}  `));
		}
	}
	return lines;
}

function formatNodeLabel(node: ArchitectureNodeRef | undefined, fallback: string): string {
	if (!node) return fallback;
	if (node.kind === "script") return `${node.id} (${node.path})`;
	return `${node.id} (${node.name})`;
}

export function formatArchitectureContextForPrompt(graph: ArchitectureGraph, activeIds: string[]): string | undefined {
	const blocks: string[] = [];
	for (const id of activeIds) {
		const node = findArchitectureNode(graph, id);
		if (!node) continue;
		const subtreeIds = collectArchitectureSubtreeIds(graph, id);
		const lines = [`<ARCHITECTURE_CONTEXT id="${id}" kind="${node.kind}">`];
		if (node.kind === "script") {
			const script = node.node as ArchitectureScript;
			lines.push(`${script.id}: ${script.name ?? script.path}`);
			lines.push(`Path: ${script.path}`);
			lines.push(`Responsibility: ${script.responsibility}`);
			lines.push(...formatList("Public surface", script.publicSurface));
			lines.push(...formatList("Depends on", script.dependsOn));
		} else {
			lines.push(...formatContainerSummary(node.node as ArchitectureContainer));
		}
		const relations = graph.relations.filter(
			(relation) => subtreeIds.has(relation.from) || subtreeIds.has(relation.to),
		);
		if (relations.length > 0) {
			lines.push("Related links:");
			for (const relation of relations) {
				const from = formatNodeLabel(findArchitectureNode(graph, relation.from), relation.from);
				const to = formatNodeLabel(findArchitectureNode(graph, relation.to), relation.to);
				lines.push(`- ${relation.id} (${relation.kind}): ${from} -> ${to}: ${relation.summary}`);
			}
		}
		lines.push("</ARCHITECTURE_CONTEXT>");
		blocks.push(lines.join("\n"));
	}
	if (blocks.length === 0) return undefined;
	return `<LOADED_ARCHITECTURE>\n${blocks.join("\n\n")}\n</LOADED_ARCHITECTURE>`;
}

export function formatArchitectureItem(graph: ArchitectureGraph, id: string): string {
	const block = formatArchitectureContextForPrompt(graph, [id]);
	if (!block) {
		throw new Error(`Unknown architecture id: ${id}`);
	}
	return block;
}

export function formatArchitectureSystemList(graph: ArchitectureGraph): string[] {
	if (graph.systems.length === 0) return ["(no systems recorded)"];
	return [...graph.systems]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((system) => `${system.id}: ${system.name} - ${system.responsibility}`);
}
