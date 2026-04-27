# LLM Functions

LLM functions are project-local specialist agents under `.pi/llm-functions/<name>/`.
Function names may contain ASCII letters, digits, `_`, and `-`.

They run through the built-in `llm_function` tool. The main agent receives the function response as a normal blocking tool result and must incorporate that result before continuing.

The main agent system prompt always includes the currently discovered project-local llm-functions so the model can use exact function names.

## Layout

```text
.pi/llm-functions/review-code/
  INSTRUCTION.md
  model.json
  mcp.json
```

`INSTRUCTION.md` is the function system prompt. `model.json` is required and uses exact provider/model IDs:

```json
{
  "provider": "openai",
  "model": "gpt-5.3-codex",
  "thinking": "high"
}
```

`mcp.json` is optional. When present, it uses the same `mcpServers` format as project `.pi/mcp.json`, but it is local to that function.

## Execution Policy

Only one `llm_function` runs at a time in the current process. Calls are serialized even if the model emits multiple `llm_function` calls in one response.

Functions currently run read-only built-in tools: `read`, `grep`, `find`, and `ls`. Function-local MCP tools are added from the function's `mcp.json`.

## review-code

The default `review-code` function reviews code or diffs and returns concise actionable findings. It does not edit files.
