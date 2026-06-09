# Tool Output Contracts and Agent Handoff - Implementation Summary

## Problem Statement

The loop executor was failing because:
1. **Tool Output Mismatch**: Tool specs described incorrect output formats (e.g., `{ url, title, summary, publishedDate, score }` for web_search) that didn't match actual Exa API output (`{ title, url, snippet }`)
2. **Goal Evaluator Failure**: Research Agent outputs raw search results, but doneCriteria expected structured newsletter content
3. **Missing Handoff Contracts**: Agents didn't know what format they'd receive from upstream agents
4. **Spec Generator Ignorance**: The spec generator didn't know actual tool output formats

## Solution Implemented

### 1. Accurate Tool Output Schemas

**Files Modified:**
- `src/services/tool-spec/types.ts` - Added `outputSchema` and `handoffFormat` fields to ToolSpec interface
- `src/services/tool-spec/internal-tools.ts` - Updated all internal tools with exact output schemas:
  - `internal.web_search`: Exa API output format with `{ text, model, provider, sources: [{ title, url, snippet }] }`
  - `internal.memory_search`: Memory search output with `{ text, data: { sources: [{ id, text, score, confidence, reason }] } }`
  - `internal.llm_only`: LLM synthesis output with `{ text }`
- `src/services/tool-spec/composio-tools.ts` - Added generic output schema for Composio tools

**Key Changes:**
- Each tool now has a JSON Schema describing its exact output structure
- Each tool documents how its output is passed to downstream agents via handoff
- Schemas match actual API responses (verified against Exa SDK)

### 2. Architect Tool Awareness

**Files Modified:**
- `src/services/loop-engine/architect.ts` - Enhanced system prompt with:
  - "TOOL OUTPUT CONTRACTS & AGENT HANDOFF" section explaining short-circuit vs LLM synthesis tools
  - Instructions to generate inputContract/outputContract based on actual tool output schemas
  - Agent handoff format documentation (`handoff.<agent_id>`)
  - Updated example agents with correct outputContract schemas matching actual tool outputs

**Key Changes:**
- Architect now understands that short-circuit tools return raw output (no LLM synthesis)
- Architect generates doneCriteria that validate raw tool output format, not synthesized content
- Architect designs inputContract/outputContract to explicitly document handoff format between agents

### 3. Tool Reference Markdown

**Files Modified:**
- `src/services/tool-spec/render-markdown.ts` - Enhanced tool reference to include:
  - Output Schema (JSON format) for each tool
  - Handoff Format documentation explaining how output is passed to downstream agents

**Key Changes:**
- Tool reference now shows exact JSON schema for each tool's output
- Clear documentation of handoff mechanism for agent-to-agent communication

### 4. Goal Evaluator Alignment

**Files Modified:**
- `src/services/loop-engine/goal-eval.ts` - Added short-circuit tool validation:
  - `isShortCircuitTool()` - Detects tools that return raw output without LLM synthesis
  - `validateShortCircuitOutput()` - Validates raw tool output against expected structure
  - Updated `evaluateAgentGoal()` to skip LLM judge for short-circuit tools

**Key Changes:**
- For short-circuit tools (web_search, memory_search, composio.*.search), goal evaluator validates raw output structure
- Validates that sources array has required fields (title, url, snippet for web_search; id, text for memory_search)
- Skips LLM judge for short-circuit tools since they don't produce synthesized content
- Prevents false failures when raw tool output doesn't match doneCriteria expecting synthesized content

## How It Works Now

### Agent Flow Example: Research → Draft

1. **Research Agent** (uses `internal.web_search`):
   - Tool returns raw Exa API output: `{ text, model, provider, sources: [{ title, url, snippet }] }`
   - Goal evaluator validates raw output structure (not synthesized content)
   - doneCriteria checks: "At least 5 sources returned", "Each source has title, url, and snippet"
   - Output passed to next agent as `handoff.web_research`

2. **Draft Agent** (uses `internal.llm_only`):
   - Receives `handoff.web_research` with raw search results
   - inputContract explicitly references `handoff.web_research.sources` array
   - LLM synthesizes raw results into structured newsletter
   - doneCriteria checks: "Includes a Subject line", "Includes one complete draft"
   - Output passed as `handoff.draft_writer`

### Handoff Mechanism

- Each agent's output is stored in `handoff.<agent_id>`
- Downstream agents receive the full output object (text, data, sources, etc.)
- inputContract/outputContract explicitly document what is passed between agents
- Example: Draft Agent's inputContract references `handoff.web_research.sources` to access search results

## Testing

All existing tests pass (245/246, 1 pre-existing failure unrelated to changes).

Type checking passes with no errors.

## Files Changed

1. `src/services/tool-spec/types.ts` - Added outputSchema and handoffFormat to ToolSpec
2. `src/services/tool-spec/internal-tools.ts` - Updated internal tools with accurate schemas
3. `src/services/tool-spec/composio-tools.ts` - Added output schema for Composio tools
4. `src/services/tool-spec/render-markdown.ts` - Enhanced tool reference with schemas
5. `src/services/loop-engine/architect.ts` - Added tool output contracts to system prompt
6. `src/services/loop-engine/goal-eval.ts` - Added short-circuit tool validation

## Impact

- **Research Agent** now correctly validates raw search results instead of expecting synthesized newsletter
- **Draft Agent** receives properly documented handoff from Research Agent
- **Goal Evaluator** no longer fails on short-circuit tools that return raw output
- **Architect** generates accurate agent contracts based on actual tool output schemas
- **Spec Generator** produces doneCriteria that match actual tool capabilities

## Future Improvements

1. Add more detailed Composio tool output schemas (currently generic)
2. Add validation for Composio search tool output structure
3. Consider adding output schema validation at runtime (not just in goal evaluator)
4. Add more use case examples showing multi-agent handoff patterns
