export interface BuildMcpToSkillPromptOptions {
	capabilities: string;
	sourceLabel?: string;
	projectSkillDir: string;
}

export function buildMcpToSkillPrompt(options: BuildMcpToSkillPromptOptions): string {
	const capabilities = options.capabilities.trim();
	const sourceLine = options.sourceLabel ? `Source: ${options.sourceLabel}` : "Source: user-provided MCP capabilities";

	return `Convert the provided MCP functionality into a project-local pi skill.

Requirements:
- Create the skill inside ${options.projectSkillDir}/<skill-name>/ with a SKILL.md file.
- The skill name must be lowercase, use hyphens only, and match the parent directory name.
- Keep everything project-local under .pi/skills. Do not write to ~/.pi.
- Do not install or depend on MCP packages, MCP adapters, MCP extensions, or MCP runtime infrastructure.
- The final result must be a normal pi skill: SKILL.md plus any helper scripts, references, or assets it needs.
- Preserve all useful capabilities exposed by the provided MCP functionality.
- If the MCP input is incomplete, make the smallest reasonable assumptions and document them clearly in the skill.
- Include concise setup and usage instructions in SKILL.md.
- After creating the files, summarize what you created and how to invoke the skill.

Skill format requirements:
- Create .pi/skills/<skill-name>/SKILL.md
- SKILL.md must start with YAML frontmatter containing at least:
  - name
  - description
- The body should explain when to use the skill, setup steps, and exact commands/scripts to run.
- Add helper scripts or reference docs next to SKILL.md when needed.

Interpret the provided MCP data broadly: if it contains tools, resources, prompts, schemas, transport config, or README text, use all of that to design the skill.

${sourceLine}

<MCP_CAPABILITIES>
${capabilities}
</MCP_CAPABILITIES>`;
}
