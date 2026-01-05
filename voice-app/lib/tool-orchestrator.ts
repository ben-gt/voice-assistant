/**
 * Agentic Tool Orchestrator
 *
 * This module provides intelligent, multi-step orchestration of tool execution:
 * - LLM-based planning: Analyzes query + context to create execution plans
 * - Multi-step execution: Tools can be chained with data dependencies
 * - Context awareness: Extracts location and other context from conversation
 * - Smart parameter resolution: Uses context and previous step outputs
 * - PARALLEL EXECUTION: Independent tools run concurrently for reduced latency
 * - RESULT CACHING: Weather (5min) and time (1min) results cached in-memory
 *
 * Architecture:
 * 1. Context Analyzer - extracts relevant info from conversation history
 * 2. Agentic Planner (LLM) - creates multi-step execution plan
 * 3. Dependency Analyzer - groups independent steps for parallel execution
 * 4. Parallel Executor - runs step groups concurrently using Promise.all
 * 5. Result Compiler - combines all results for formatting
 */

import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { executeTool } from "@/app/api/tools";
import { TOOL_DEFINITIONS, type ToolName, type ToolResult } from "@/lib/tools";

// =============================================================================
// Types
// =============================================================================

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/** A single step in an execution plan */
export interface PlanStep {
  /** Which tool to execute */
  tool: ToolName;
  /** Parameters for the tool - can reference previous step outputs with $stepN.field syntax */
  parameters: Record<string, unknown>;
  /** Why this step is needed */
  reasoning: string;
  /** Which previous step outputs this step depends on (for logging) */
  dependsOn?: number[];
}

/** The execution plan created by the planner */
export interface ExecutionPlan {
  /** Whether tools are needed at all */
  requiresTools: boolean;
  /** If no tools needed, this is the reason (e.g., "general conversation") */
  noToolReason?: string;
  /** Ordered list of steps to execute */
  steps: PlanStep[];
  /** Overall reasoning for this plan */
  reasoning: string;
  /** Extracted context that informed the plan */
  extractedContext: {
    location?: string;
    timezone?: string;
    previousTopic?: string;
  };
}

/** Result of executing a single step */
export interface StepResult {
  stepIndex: number;
  tool: ToolName;
  parameters: Record<string, unknown>;
  result: ToolResult;
}

/** Final orchestration result */
export interface OrchestrationResult {
  success: boolean;
  /** Results from each tool execution, in order */
  results: Array<{ toolName: string; result: ToolResult }>;
  /** Combined data for formatting */
  combinedData: Record<string, unknown>;
  /** Error message if failed */
  error?: string;
  /** The plan that was executed (for debugging) */
  plan?: ExecutionPlan;
}

export interface ClientLocation {
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  timezone?: string;
}

/** Tool event with optional index and count info */
export interface ToolEvent {
  type: "start" | "end" | "plan";
  tool: string;
  /** Current tool index (1-based) */
  toolIndex?: number;
  /** Total tools in plan */
  totalTools?: number;
  /** All tools in plan (for plan event) */
  allTools?: string[];
}

export interface OrchestratorOptions {
  /** Callback for tool execution events */
  onToolEvent?: (event: ToolEvent) => Promise<void>;
  /** Pre-fetched client location (from browser geolocation) */
  clientLocation?: ClientLocation;
}

// =============================================================================
// Cerebras Client (singleton for reuse)
// =============================================================================

let cerebrasClient: Cerebras | null = null;

function getCerebrasClient(): Cerebras {
  if (!cerebrasClient) {
    cerebrasClient = new Cerebras({
      apiKey: process.env.CEREBRAS_API_KEY,
    });
  }
  return cerebrasClient;
}

// =============================================================================
// Result Cache (in-memory with TTL)
// =============================================================================

interface CacheEntry {
  result: ToolResult;
  timestamp: number;
  expiresAt: number;
}

interface CacheConfig {
  /** TTL in milliseconds */
  ttl: number;
}

/** Cache configuration per tool type */
const CACHE_CONFIG: Partial<Record<ToolName, CacheConfig>> = {
  get_weather: { ttl: 5 * 60 * 1000 }, // 5 minutes
  get_current_time: { ttl: 1 * 60 * 1000 }, // 1 minute
};

/** In-memory cache storage */
const resultCache = new Map<string, CacheEntry>();

/** Cache cleanup interval ID (for cleanup on shutdown) */
let cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Generate a cache key from tool name and parameters
 * IMPORTANT: All parameters must be included to avoid serving wrong cached results
 * (e.g., weather for same location but different units)
 */
function generateCacheKey(tool: ToolName, params: Record<string, unknown>): string {
  // Normalize parameters for consistent keys
  // Include ALL parameters to prevent cache collisions
  const normalizedParams = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      const value = params[key];
      if (value !== undefined && value !== null) {
        // Normalize strings but preserve other types exactly
        if (typeof value === "string") {
          acc[key] = value.toLowerCase().trim();
        } else if (typeof value === "number" || typeof value === "boolean") {
          acc[key] = value;
        } else {
          // For objects/arrays, stringify for consistent comparison
          acc[key] = JSON.stringify(value);
        }
      }
      return acc;
    }, {} as Record<string, unknown>);

  // Include tool name and all normalized params in key
  return `${tool}:${JSON.stringify(normalizedParams)}`;
}

/**
 * Get a cached result if available and not expired
 */
function getCachedResult(tool: ToolName, params: Record<string, unknown>): ToolResult | null {
  const config = CACHE_CONFIG[tool];
  if (!config) return null;

  const key = generateCacheKey(tool, params);
  const entry = resultCache.get(key);

  if (!entry) return null;

  const now = Date.now();
  if (now > entry.expiresAt) {
    // Cache expired, remove it
    resultCache.delete(key);
    console.log(`[Cache] Expired entry for ${tool}`);
    return null;
  }

  const ageSeconds = Math.round((now - entry.timestamp) / 1000);
  console.log(`[Cache] HIT for ${tool} (age: ${ageSeconds}s)`);
  return entry.result;
}

/**
 * Store a result in the cache
 */
function setCachedResult(tool: ToolName, params: Record<string, unknown>, result: ToolResult): void {
  const config = CACHE_CONFIG[tool];
  if (!config || !result.success) return;

  const key = generateCacheKey(tool, params);
  const now = Date.now();

  resultCache.set(key, {
    result,
    timestamp: now,
    expiresAt: now + config.ttl,
  });

  console.log(`[Cache] Stored ${tool} result (TTL: ${config.ttl / 1000}s)`);
}

/**
 * Clear expired cache entries (call periodically)
 */
function cleanupCache(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of resultCache.entries()) {
    if (now > entry.expiresAt) {
      resultCache.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[Cache] Cleaned ${cleaned} expired entries`);
  }
}

// Run cache cleanup every 2 minutes
if (typeof setInterval !== "undefined" && !cacheCleanupInterval) {
  cacheCleanupInterval = setInterval(cleanupCache, 2 * 60 * 1000);
}

/**
 * Stop the cache cleanup interval (call on shutdown/cleanup)
 */
export function stopCacheCleanup(): void {
  if (cacheCleanupInterval) {
    clearInterval(cacheCleanupInterval);
    cacheCleanupInterval = null;
    console.log("[Cache] Cleanup interval stopped");
  }
}

// =============================================================================
// Dependency Graph & Parallel Execution
// =============================================================================

/** Represents a group of steps that can execute in parallel */
interface ExecutionGroup {
  /** Step indices in this group */
  stepIndices: number[];
  /** Group execution order (0 = first group, 1 = second, etc.) */
  groupOrder: number;
}

/**
 * Analyze plan steps for dependencies and group independent steps together.
 * Uses topological sorting to determine execution order while maximizing parallelism.
 *
 * Algorithm:
 * 1. Build dependency graph from $stepN references and explicit dependsOn
 * 2. Compute "levels" - steps with same level can run in parallel
 * 3. Level 0 = no dependencies, Level 1 = depends on Level 0, etc.
 */
function analyzeParallelGroups(steps: PlanStep[]): ExecutionGroup[] {
  if (steps.length === 0) return [];
  if (steps.length === 1) return [{ stepIndices: [0], groupOrder: 0 }];

  // Build dependency map: stepIndex -> set of step indices it depends on
  const dependencies = new Map<number, Set<number>>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const deps = new Set<number>();

    // Check explicit dependsOn
    if (step.dependsOn && step.dependsOn.length > 0) {
      for (const dep of step.dependsOn) {
        if (dep >= 0 && dep < i) {
          deps.add(dep);
        }
      }
    }

    // Check parameter references for $stepN patterns
    const paramStr = JSON.stringify(step.parameters);
    const refPattern = /\$step(\d+)/g;
    let match;
    while ((match = refPattern.exec(paramStr)) !== null) {
      const depIndex = parseInt(match[1], 10);
      if (depIndex >= 0 && depIndex < i) {
        deps.add(depIndex);
      }
    }

    dependencies.set(i, deps);
  }

  // Compute levels using modified Kahn's algorithm
  // Level = max level of dependencies + 1
  const levels = new Map<number, number>();

  function computeLevel(stepIndex: number, visited: Set<number> = new Set()): number {
    if (visited.has(stepIndex)) {
      console.warn(`[Parallel] Circular dependency detected at step ${stepIndex}`);
      return 0;
    }

    if (levels.has(stepIndex)) {
      return levels.get(stepIndex)!;
    }

    visited.add(stepIndex);
    const deps = dependencies.get(stepIndex) || new Set();

    if (deps.size === 0) {
      levels.set(stepIndex, 0);
      return 0;
    }

    let maxDepLevel = -1;
    for (const dep of deps) {
      maxDepLevel = Math.max(maxDepLevel, computeLevel(dep, new Set(visited)));
    }

    const level = maxDepLevel + 1;
    levels.set(stepIndex, level);
    return level;
  }

  // Compute level for each step
  for (let i = 0; i < steps.length; i++) {
    computeLevel(i);
  }

  // Group steps by level
  const levelGroups = new Map<number, number[]>();
  for (let i = 0; i < steps.length; i++) {
    const level = levels.get(i) || 0;
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)!.push(i);
  }

  // Convert to ExecutionGroups, sorted by level
  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);
  const groups: ExecutionGroup[] = sortedLevels.map((level, idx) => ({
    stepIndices: levelGroups.get(level)!,
    groupOrder: idx,
  }));

  // Log parallelism analysis
  console.log(`[Parallel] Analyzed ${steps.length} steps into ${groups.length} execution groups:`);
  for (const group of groups) {
    const tools = group.stepIndices.map(i => steps[i].tool).join(", ");
    console.log(`  Group ${group.groupOrder}: [${tools}] (${group.stepIndices.length} step(s))`);
  }

  return groups;
}

// =============================================================================
// Location Context Database
// =============================================================================

const KNOWN_LOCATIONS: Record<string, { region: string; timezone: string; units: "celsius" | "fahrenheit" }> = {
  "lowood": { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  "brisbane": { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  "sydney": { region: "NSW, Australia", timezone: "Australia/Sydney", units: "celsius" },
  "melbourne": { region: "Victoria, Australia", timezone: "Australia/Melbourne", units: "celsius" },
  "perth": { region: "WA, Australia", timezone: "Australia/Perth", units: "celsius" },
  "adelaide": { region: "SA, Australia", timezone: "Australia/Adelaide", units: "celsius" },
  "darwin": { region: "NT, Australia", timezone: "Australia/Darwin", units: "celsius" },
  "hobart": { region: "Tasmania, Australia", timezone: "Australia/Hobart", units: "celsius" },
  "gold coast": { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  "ipswich": { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  "toowoomba": { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  "cairns": { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  "townsville": { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  "canberra": { region: "ACT, Australia", timezone: "Australia/Sydney", units: "celsius" },
  "new york": { region: "New York, USA", timezone: "America/New_York", units: "fahrenheit" },
  "los angeles": { region: "California, USA", timezone: "America/Los_Angeles", units: "fahrenheit" },
  "london": { region: "UK", timezone: "Europe/London", units: "celsius" },
  "tokyo": { region: "Japan", timezone: "Asia/Tokyo", units: "celsius" },
  "singapore": { region: "Singapore", timezone: "Asia/Singapore", units: "celsius" },
};

// =============================================================================
// Context Analyzer
// =============================================================================

interface ExtractedContext {
  /** User's location if mentioned in conversation */
  location?: string;
  /** Full location with region/country for search queries */
  fullLocation?: string;
  /** Timezone from location */
  timezone?: string;
  /** Temperature units preference */
  units?: "celsius" | "fahrenheit";
  /** Previous topic being discussed */
  previousTopic?: string;
  /** Any URLs mentioned */
  mentionedUrls?: string[];
}

/**
 * Extract relevant context from conversation history
 */
function extractContextFromHistory(messages: ConversationMessage[]): ExtractedContext {
  const context: ExtractedContext = {};

  // Look through messages from most recent to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const lower = msg.content.toLowerCase();

    // Extract location if not already found
    if (!context.location) {
      // Check known locations (longer names first to match "gold coast" before "coast")
      const sortedLocations = Object.entries(KNOWN_LOCATIONS).sort((a, b) => b[0].length - a[0].length);

      for (const [loc, info] of sortedLocations) {
        const regex = new RegExp(`\\b${loc.replace(/\s+/g, "\\s+")}\\b`, "i");
        if (regex.test(lower)) {
          context.location = loc.charAt(0).toUpperCase() + loc.slice(1);
          context.fullLocation = `${context.location}, ${info.region}`;
          context.timezone = info.timezone;
          context.units = info.units;
          break;
        }
      }

      // Try pattern matching for other locations
      if (!context.location) {
        const patterns = [
          /(?:i'm in|i am in|i live in|located in|from)\s+([a-z][a-z\s]{1,30}?)(?:\s*[.,!?]|$)/i,
          /(?:weather|temperature|time)\s+(?:in|at|for)\s+([a-z][a-z\s]{1,30}?)(?:\s*[.,!?]|$)/i,
          /(?:near|around)\s+([a-z][a-z\s]{1,30}?)(?:\s*[.,!?]|$)/i,
        ];

        for (const pattern of patterns) {
          const match = msg.content.match(pattern);
          if (match?.[1]) {
            const extracted = match[1].trim();
            const knownInfo = KNOWN_LOCATIONS[extracted.toLowerCase()];
            if (knownInfo) {
              context.location = extracted;
              context.fullLocation = `${extracted}, ${knownInfo.region}`;
              context.timezone = knownInfo.timezone;
              context.units = knownInfo.units;
            } else {
              context.location = extracted;
              context.fullLocation = extracted;
            }
            break;
          }
        }
      }
    }

    // Extract URLs
    const urlMatches = msg.content.match(/https?:\/\/[^\s]+/gi);
    if (urlMatches) {
      context.mentionedUrls = [...(context.mentionedUrls || []), ...urlMatches];
    }

    // Detect previous topics (for "try again" type queries)
    if (msg.role === "assistant" && !context.previousTopic) {
      if (lower.includes("weather") || lower.includes("temperature") || lower.includes("degrees")) {
        context.previousTopic = "weather";
      } else if (lower.includes("time") || lower.includes("o'clock") || lower.includes("date")) {
        context.previousTopic = "time";
      } else if (lower.includes("search") || lower.includes("found") || lower.includes("results")) {
        context.previousTopic = "search";
      }
    }
  }

  return context;
}

// =============================================================================
// Agentic Planner
// =============================================================================

/**
 * Build the tool descriptions for the planner prompt
 */
function buildToolDescriptions(): string {
  const descriptions: string[] = [];

  for (const [name, def] of Object.entries(TOOL_DEFINITIONS)) {
    const params = Object.entries(def.parameters.properties)
      .map(([pName, pDef]) => {
        const required = def.parameters.required.includes(pName) ? " (required)" : " (optional)";
        return `    - ${pName}${required}: ${(pDef as { description: string }).description}`;
      })
      .join("\n");

    descriptions.push(`${name}: ${def.description}\n  Parameters:\n${params}`);
  }

  return descriptions.join("\n\n");
}

/**
 * System prompt for the agentic planner
 */
const PLANNER_SYSTEM_PROMPT = `You are an intelligent query planner for a voice assistant. Your job is to analyze user queries and conversation context to create execution plans.

AVAILABLE TOOLS:
${buildToolDescriptions()}

YOUR TASK:
Analyze the user's query and conversation context, then output a JSON execution plan.

OUTPUT FORMAT (JSON only, no markdown):
{
  "requiresTools": true/false,
  "noToolReason": "only if requiresTools is false - explain why",
  "steps": [
    {
      "tool": "tool_name",
      "parameters": { "param": "value" },
      "reasoning": "why this step is needed",
      "dependsOn": [0] // optional: indices of previous steps this depends on
    }
  ],
  "reasoning": "overall plan explanation",
  "extractedContext": {
    "location": "extracted location or null",
    "timezone": "timezone or null",
    "previousTopic": "what was being discussed or null"
  }
}

CRITICAL RULES:

1. LOCATION AWARENESS (VERY IMPORTANT):
   - ALWAYS check conversation context for location mentions
   - For ANY query involving local/nearby/nearest things, you MUST include location in search
   - Example: "nearest bakery" with context showing "Lowood QLD" -> search "bakery near Lowood Queensland Australia"
   - If location is needed but not in context, use get_user_location tool FIRST
   - For weather/time without explicit location, check context first, then use get_user_location

2. PARALLEL EXECUTION (PERFORMANCE OPTIMIZATION):
   - Steps WITHOUT $stepN references or dependsOn can run IN PARALLEL for faster execution
   - MAXIMIZE parallelism: put independent tools in separate steps without dependencies
   - Example: get_current_time and get_weather (with known location) are INDEPENDENT - no dependsOn needed
   - Example: "What time is it and what's the weather?" -> 2 parallel steps, both at step 0 level
   - Only use dependsOn when a step ACTUALLY needs output from a previous step
   - The executor automatically detects parallelism from $stepN references and dependsOn arrays

3. MULTI-STEP PLANNING:
   - Some queries need multiple tools in sequence
   - Example: "Will I need an umbrella?" needs weather tool, then analysis
   - Example: "What's on my shopping list?" needs list_views, then get_view_data
   - Always get location BEFORE tools that need it if not in context

4. SEARCH QUERY CONSTRUCTION:
   - When user asks about local things (nearest, nearby, local, around here), ALWAYS include location
   - Bad: query "nearest bakery" -> searches globally, wrong results
   - Good: query "bakery near Lowood Queensland Australia" -> correct local results
   - Include business type + "near" + full location (city, state/region, country)

5. PARAMETER REFERENCES:
   - Use $step0, $step1, etc. to reference previous step outputs
   - Example: After get_user_location, use "$step0.data.city" for location
   - Example: After list_views, use the view_id from results in get_view_data
   - ONLY use $stepN when you NEED data from that step - unnecessary refs prevent parallelism

6. CONVERSATION INTENT:
   - "try again", "use the tool", "check again" -> look at previousTopic to determine which tool
   - Greetings and general chat don't need tools (requiresTools: false)

7. VIEW QUERIES (FARMBOARD/DATA ACCESS):
   - "farmboard", "board", "views", "lists", "data" -> need list_views first
   - CLEAR INTENT (2-step): "shopping list", "my calendar", "tasks", "schedule" -> list_views then get_view_data
   - AMBIGUOUS/EXPLORATORY (1-step ONLY): "what can you see", "suggest something", "show me options", "help me", "what do you have" -> list_views ONLY (let user choose)
   - CRITICAL: If user intent is NOT specific to a particular view type, STOP at list_views
   - Only proceed to get_view_data when user explicitly names or describes a specific view type
   - When in doubt, show the list and ask user to choose - don't auto-select

8. WEATHER QUERIES:
   - "will it rain", "do I need umbrella", "is it cold", "what's it like outside" -> weather
   - Include units: celsius for Australia/UK/most places, fahrenheit for USA

EXAMPLES:

Query: "What's my nearest bakery?"
Context: Previous message mentioned "Lowood QLD"
Plan:
{
  "requiresTools": true,
  "steps": [
    {
      "tool": "web_search",
      "parameters": { "query": "bakery near Lowood Queensland Australia" },
      "reasoning": "User wants nearest bakery, using location from context"
    }
  ],
  "reasoning": "Local search with location from conversation context",
  "extractedContext": { "location": "Lowood, Queensland, Australia" }
}

Query: "What's the weather like?"
Context: No location mentioned
Plan:
{
  "requiresTools": true,
  "steps": [
    {
      "tool": "get_user_location",
      "parameters": {},
      "reasoning": "Need to determine user's location first"
    },
    {
      "tool": "get_weather",
      "parameters": { "location": "$step0.data.city, $step0.data.region", "units": "celsius" },
      "reasoning": "Get weather for detected location",
      "dependsOn": [0]
    }
  ],
  "reasoning": "No location in context, so detect location first then get weather",
  "extractedContext": {}
}

Query: "Will I need an umbrella tomorrow?"
Context: User mentioned "Brisbane" earlier
Plan:
{
  "requiresTools": true,
  "steps": [
    {
      "tool": "get_weather",
      "parameters": { "location": "Brisbane, Queensland, Australia", "units": "celsius" },
      "reasoning": "Get weather to check for rain forecast"
    }
  ],
  "reasoning": "Check weather for Brisbane from context to determine rain likelihood",
  "extractedContext": { "location": "Brisbane", "timezone": "Australia/Brisbane" }
}

Query: "What's on my shopping list?"
Context: None needed
Plan:
{
  "requiresTools": true,
  "steps": [
    {
      "tool": "list_views",
      "parameters": {},
      "reasoning": "First get available views to find shopping list"
    },
    {
      "tool": "get_view_data",
      "parameters": { "view_id": "$step0.shopping_list_id" },
      "reasoning": "Get shopping list contents using ID from previous step",
      "dependsOn": [0]
    }
  ],
  "reasoning": "Need to list views first to get shopping list ID, then fetch its data",
  "extractedContext": {}
}

Query: "What can you see from farmboard?" or "suggest something" or "help me"
Context: None needed (AMBIGUOUS - no specific view mentioned)
Plan:
{
  "requiresTools": true,
  "steps": [
    {
      "tool": "list_views",
      "parameters": {},
      "reasoning": "User wants to see options - STOP HERE, let them choose"
    }
  ],
  "reasoning": "Ambiguous query - show available views and ask user to choose, do NOT auto-select",
  "extractedContext": {}
}

Query: "What's on my tasks?" or "show me my calendar"
Context: None needed (CLEAR INTENT - specific view type mentioned)
Plan:
{
  "requiresTools": true,
  "steps": [
    {
      "tool": "list_views",
      "parameters": {},
      "reasoning": "First get available views to find the matching view"
    },
    {
      "tool": "get_view_data",
      "parameters": { "view_id": "$step0.matching_view_id" },
      "reasoning": "Get data from the tasks/calendar view",
      "dependsOn": [0]
    }
  ],
  "reasoning": "Clear intent for tasks/calendar - find and fetch that specific view",
  "extractedContext": {}
}

Query: "Should I take an umbrella to the bakery?"
Context: User mentioned "Brisbane" earlier
Plan:
{
  "requiresTools": true,
  "steps": [
    {
      "tool": "get_current_time",
      "parameters": { "timezone": "Australia/Brisbane" },
      "reasoning": "Get current time to know what part of day for weather context"
    },
    {
      "tool": "get_weather",
      "parameters": { "location": "Brisbane, Queensland, Australia", "units": "celsius" },
      "reasoning": "Get weather to check for rain - PARALLEL with get_current_time (no dependency)"
    },
    {
      "tool": "web_search",
      "parameters": { "query": "bakery near Brisbane Queensland Australia hours" },
      "reasoning": "Search for bakery info - PARALLEL with time and weather (no dependency)"
    }
  ],
  "reasoning": "All 3 tools are INDEPENDENT - no $stepN refs needed. They run in PARALLEL for speed.",
  "extractedContext": { "location": "Brisbane", "timezone": "Australia/Brisbane" }
}

Query: "What time is it and what's the weather?"
Context: User location is "Sydney"
Plan:
{
  "requiresTools": true,
  "steps": [
    {
      "tool": "get_current_time",
      "parameters": { "timezone": "Australia/Sydney" },
      "reasoning": "Get current time for Sydney"
    },
    {
      "tool": "get_weather",
      "parameters": { "location": "Sydney, NSW, Australia", "units": "celsius" },
      "reasoning": "Get weather for Sydney - runs PARALLEL with time (independent)"
    }
  ],
  "reasoning": "Both tools independent, no dependsOn needed, will run in parallel",
  "extractedContext": { "location": "Sydney", "timezone": "Australia/Sydney" }
}

Output ONLY the JSON. No thinking, no explanation, just valid JSON.`;

/**
 * Build the user message for planning
 */
function buildPlannerUserMessage(query: string, context: ConversationMessage[], extractedContext: ExtractedContext): string {
  let message = "";

  // Add extracted context summary
  message += "EXTRACTED CONTEXT:\n";
  if (extractedContext.location) {
    message += `- Location: ${extractedContext.fullLocation || extractedContext.location}\n`;
  }
  if (extractedContext.timezone) {
    message += `- Timezone: ${extractedContext.timezone}\n`;
  }
  if (extractedContext.units) {
    message += `- Temperature units: ${extractedContext.units}\n`;
  }
  if (extractedContext.previousTopic) {
    message += `- Previous topic: ${extractedContext.previousTopic}\n`;
  }
  if (!extractedContext.location && !extractedContext.previousTopic) {
    message += "- No location or topic context found\n";
  }
  message += "\n";

  // Add recent conversation
  const recentContext = context.slice(-6);
  if (recentContext.length > 0) {
    message += "RECENT CONVERSATION:\n";
    for (const msg of recentContext) {
      message += `${msg.role.toUpperCase()}: ${msg.content}\n`;
    }
    message += "\n";
  }

  message += `USER QUERY: ${query}`;

  return message;
}

/**
 * Parse the planner's JSON response
 */
function parsePlannerResponse(response: string): ExecutionPlan | null {
  try {
    // Strip markdown code blocks if present
    let jsonStr = response.trim();
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith("```")) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    // Strip <think> tags if present
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

    const parsed = JSON.parse(jsonStr);

    // Validate structure
    if (typeof parsed.requiresTools !== "boolean") {
      console.warn("[Planner] Missing requiresTools, defaulting to false");
      parsed.requiresTools = false;
    }

    if (!parsed.requiresTools) {
      return {
        requiresTools: false,
        noToolReason: parsed.noToolReason || "General conversation",
        steps: [],
        reasoning: parsed.reasoning || "No tools needed",
        extractedContext: parsed.extractedContext || {},
      };
    }

    // Validate steps
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      console.warn("[Planner] No steps provided, treating as conversation");
      return {
        requiresTools: false,
        noToolReason: "No execution steps provided",
        steps: [],
        reasoning: "Planner did not provide steps",
        extractedContext: parsed.extractedContext || {},
      };
    }

    // Validate each step
    const validSteps: PlanStep[] = [];
    for (const step of parsed.steps) {
      if (!step.tool || !(step.tool in TOOL_DEFINITIONS)) {
        console.warn(`[Planner] Invalid tool: ${step.tool}`);
        continue;
      }

      validSteps.push({
        tool: step.tool as ToolName,
        parameters: step.parameters || {},
        reasoning: step.reasoning || "No reasoning provided",
        dependsOn: step.dependsOn,
      });
    }

    if (validSteps.length === 0) {
      return {
        requiresTools: false,
        noToolReason: "No valid tools in plan",
        steps: [],
        reasoning: "All planned steps had invalid tools",
        extractedContext: parsed.extractedContext || {},
      };
    }

    return {
      requiresTools: true,
      steps: validSteps,
      reasoning: parsed.reasoning || "Plan created",
      extractedContext: parsed.extractedContext || {},
    };
  } catch (error) {
    console.error("[Planner] Failed to parse response:", error, "Response:", response);
    return null;
  }
}

/**
 * Create an execution plan using the LLM
 */
async function createExecutionPlan(
  query: string,
  context: ConversationMessage[],
  clientLocation?: ClientLocation
): Promise<ExecutionPlan> {
  const cerebras = getCerebrasClient();

  // First extract context from conversation
  let extractedContext = extractContextFromHistory(context);

  // IMPORTANT: If we have actual browser location, use it instead of conversation context
  if (clientLocation?.city) {
    const fullLocation = [clientLocation.city, clientLocation.region, clientLocation.country]
      .filter(Boolean)
      .join(", ");
    extractedContext = {
      ...extractedContext,
      location: clientLocation.city,
      fullLocation,
      timezone: clientLocation.timezone || extractedContext.timezone,
    };
    console.log(`[Planner] Using browser location: ${fullLocation}`);
  }

  console.log(`[Planner] Creating plan for: "${query.substring(0, 80)}..."`);
  console.log(`[Planner] Extracted context:`, extractedContext);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await cerebras.chat.completions.create({
      model: "llama-3.1-8b", // Fast model for planning
      messages: [
        { role: "system", content: PLANNER_SYSTEM_PROMPT },
        { role: "user", content: buildPlannerUserMessage(query, context, extractedContext) },
      ],
      max_tokens: 512,
      temperature: 0.1, // Low temperature for consistent planning
    });

    const content = response.choices[0]?.message?.content || "";
    const plan = parsePlannerResponse(content);

    if (plan) {
      console.log(`[Planner] Plan created: ${plan.steps.length} steps, reasoning: "${plan.reasoning}"`);
      return plan;
    }

    // Fallback if parsing failed
    console.warn("[Planner] Parsing failed, falling back to conversation");
    return {
      requiresTools: false,
      noToolReason: "Failed to parse planner response",
      steps: [],
      reasoning: "Planning failed",
      extractedContext: {},
    };
  } catch (error) {
    console.error("[Planner] LLM call failed:", error);
    return {
      requiresTools: false,
      noToolReason: "Planner LLM call failed",
      steps: [],
      reasoning: "Planning error",
      extractedContext: {},
    };
  }
}

// =============================================================================
// Plan Executor
// =============================================================================

/**
 * Resolve parameter references like $step0.data.city to actual values
 */
function resolveParameterReferences(
  parameters: Record<string, unknown>,
  stepResults: StepResult[]
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === "string" && value.includes("$step")) {
      // Handle all references (both single "$step0.data.city" and compound "$step0.data.city, $step0.data.region")
      let resolvedValue = value;
      const refPattern = /\$step(\d+)\.([a-zA-Z0-9_.]+)/g;
      let refMatch;
      let allResolved = true;

      while ((refMatch = refPattern.exec(value)) !== null) {
        const stepIndex = parseInt(refMatch[1], 10);
        const path = refMatch[2];

        if (stepIndex < stepResults.length) {
          const stepResult = stepResults[stepIndex];
          let current: unknown = stepResult.result;
          const parts = path.split(".");

          for (const part of parts) {
            if (current && typeof current === "object" && part in current) {
              current = (current as Record<string, unknown>)[part];
            } else {
              console.warn(`[Executor] Cannot resolve path ${path} from step ${stepIndex}`);
              current = undefined;
              allResolved = false;
              break;
            }
          }

          if (current !== undefined) {
            resolvedValue = resolvedValue.replace(refMatch[0], String(current));
          }
        } else {
          console.warn(`[Executor] Step ${stepIndex} not yet executed for reference ${refMatch[0]}`);
          allResolved = false;
        }
      }

      resolved[key] = allResolved ? resolvedValue : undefined;
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * Special handling for list_views -> get_view_data chain
 * Finds the appropriate view ID based on the query context
 */
function resolveViewId(
  parameters: Record<string, unknown>,
  stepResults: StepResult[],
  query: string
): Record<string, unknown> {
  const resolved = { ...parameters };

  // Check if we need to resolve a view_id and list_views was a previous step
  const viewId = resolved.view_id;
  const isValidObjectId = typeof viewId === "string" && /^[0-9a-f]{24}$/i.test(viewId);
  const needsResolution = viewId === undefined || (typeof viewId === "string" && viewId.startsWith("$step")) || (typeof viewId === "string" && !isValidObjectId);
  if (needsResolution) {
    // Find the list_views result
    const listViewsResult = stepResults.find(r => r.tool === "list_views");
    if (listViewsResult?.result.success && listViewsResult.result.data) {
      // list_views returns { views: [...], count: N }
      const viewsData = listViewsResult.result.data as { views?: Array<{ id: string; name: string; description?: string | null }> };
      const views = viewsData?.views || [];

      const lowerQuery = query.toLowerCase();
      console.log(`[Executor] Resolving view_id for query: "${query}", views: ${views.map(v => v.name).join(", ")}`);

      // First: try direct name matching
      for (const view of views) {
        const viewNameLower = view.name.toLowerCase();
        // Check if query words match view name
        const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 2);
        if (queryWords.some(w => viewNameLower.includes(w) || w.includes(viewNameLower.split(" ")[0]))) {
          resolved.view_id = view.id;
          console.log(`[Executor] Resolved view_id by name: ${view.id} (${view.name})`);
          return resolved;
        }
      }

      // Second: keyword-based matching
      const keywordMap: Record<string, string[]> = {
        shopping: ["shopping", "grocery", "groceries", "buy", "store"],
        calendar: ["calendar", "family calendar"],
        schedule: ["schedule", "family schedule"],
        tasks: ["task", "tasks", "todo"],
        appointments: ["appointment", "appointments"],
        whiteboard: ["whiteboard", "board"],
        people: ["people", "person", "contacts"],
        locations: ["location", "locations", "places"],
      };

      for (const view of views) {
        const viewNameLower = view.name.toLowerCase();
        const viewDescLower = (view.description || "").toLowerCase();

        for (const [category, keywords] of Object.entries(keywordMap)) {
          if (keywords.some(kw => lowerQuery.includes(kw))) {
            if (
              viewNameLower.includes(category) ||
              viewDescLower.includes(category) ||
              keywords.some(kw => viewNameLower.includes(kw) || viewDescLower.includes(kw))
            ) {
              resolved.view_id = view.id;
              console.log(`[Executor] Resolved view_id by keyword "${category}": ${view.id} (${view.name})`);
              return resolved;
            }
          }
        }
      }

      // No match - don't default, let it fail properly
      console.warn(`[Executor] No matching view for query "${query}"`);
    }
  }

  return resolved;
}

/** Options for executeStep */
interface ExecuteStepOptions {
  stepIndex: number;
  step: PlanStep;
  stepResults: StepResult[];
  query: string;
  onToolEvent?: (event: ToolEvent) => Promise<void>;
  clientLocation?: ClientLocation;
  /** 1-based tool execution number (for progress display) */
  executionNumber?: number;
  /** Total tools being executed */
  totalTools?: number;
}

/**
 * Execute a single step with caching support
 */
async function executeStep(options: ExecuteStepOptions): Promise<StepResult> {
  const {
    stepIndex,
    step,
    stepResults,
    query,
    onToolEvent,
    clientLocation,
    executionNumber,
    totalTools,
  } = options;

  console.log(`[Executor] Step ${stepIndex + 1}: ${step.tool} - ${step.reasoning}`);

  // Log original parameters if they contain references
  const hasRefs = Object.values(step.parameters).some(v => typeof v === "string" && v.includes("$step"));
  if (hasRefs) {
    console.log(`[Executor] Step ${stepIndex + 1} original parameters:`, step.parameters);
  }

  // Resolve any parameter references to previous step outputs
  let resolvedParams = resolveParameterReferences(step.parameters, stepResults);

  // Special handling for view_id resolution
  if (step.tool === "get_view_data") {
    resolvedParams = resolveViewId(resolvedParams, stepResults, query);
  }

  console.log(`[Executor] Step ${stepIndex + 1} resolved parameters:`, resolvedParams);

  // Emit tool start event with index info
  if (onToolEvent) {
    await onToolEvent({
      type: "start",
      tool: step.tool,
      toolIndex: executionNumber,
      totalTools,
    });
  }

  let result: ToolResult;

  // Check cache first (for cacheable tools)
  const cachedResult = getCachedResult(step.tool, resolvedParams);
  if (cachedResult) {
    result = cachedResult;
  } else if (step.tool === "get_user_location" && clientLocation) {
    // Special handling for get_user_location - use client location if available
    console.log(`[Executor] Using client-provided browser location`);
    result = {
      success: true,
      data: {
        location: `${clientLocation.city || ""}, ${clientLocation.region || ""}, ${clientLocation.country || ""}`.replace(/^, |, $/g, ""),
        city: clientLocation.city || "",
        region: clientLocation.region || "",
        country: clientLocation.country || "",
        countryCode: clientLocation.countryCode || "",
        timezone: clientLocation.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        coordinates: {
          latitude: clientLocation.latitude,
          longitude: clientLocation.longitude,
        },
        source: "browser",
      },
    };
  } else {
    // Execute the tool normally
    result = await executeTool(step.tool, resolvedParams);

    // Cache the result if successful
    if (result.success) {
      setCachedResult(step.tool, resolvedParams, result);
    }
  }

  // Emit tool end event
  if (onToolEvent) {
    await onToolEvent({ type: "end", tool: step.tool });
  }

  return {
    stepIndex,
    tool: step.tool,
    parameters: resolvedParams,
    result,
  };
}

/** Result of plan execution with partial success support */
interface PlanExecutionResult {
  /** True if all steps succeeded, false if any failed */
  success: boolean;
  /** True if some steps succeeded but others failed */
  partial: boolean;
  /** Completed step results (only successful ones) */
  stepResults: StepResult[];
  /** Failed steps with their errors */
  failedSteps: Array<{ stepIndex: number; tool: ToolName; error: string }>;
  /** Primary error message (from first failure) */
  error?: string;
}

/**
 * Check if a step has failed dependencies (its dependent steps failed)
 */
function hasFailedDependency(
  stepIndex: number,
  plan: ExecutionPlan,
  failedIndices: Set<number>
): boolean {
  const step = plan.steps[stepIndex];

  // Check explicit dependsOn
  if (step.dependsOn?.some(dep => failedIndices.has(dep))) {
    return true;
  }

  // Check parameter references
  const paramStr = JSON.stringify(step.parameters);
  const refPattern = /\$step(\d+)/g;
  let match;
  while ((match = refPattern.exec(paramStr)) !== null) {
    const depIndex = parseInt(match[1], 10);
    if (failedIndices.has(depIndex)) {
      return true;
    }
  }

  return false;
}

/**
 * Execute a plan with parallel execution for independent steps.
 * Uses Promise.allSettled for graceful degradation - continues with partial results
 * even when some tools fail.
 *
 * This function:
 * 1. Analyzes the plan for dependencies using analyzeParallelGroups()
 * 2. Groups independent steps that can run concurrently
 * 3. Executes each group using Promise.allSettled for resilient parallel execution
 * 4. Passes results to dependent steps in subsequent groups
 * 5. Skips steps whose dependencies failed
 * 6. Returns partial results when possible
 */
async function executePlan(
  plan: ExecutionPlan,
  query: string,
  onToolEvent?: (event: ToolEvent) => Promise<void>,
  clientLocation?: ClientLocation
): Promise<PlanExecutionResult> {
  const stepResults: (StepResult | undefined)[] = new Array(plan.steps.length);
  const failedSteps: Array<{ stepIndex: number; tool: ToolName; error: string }> = [];
  const failedIndices = new Set<number>();
  const startTime = Date.now();
  let executionCounter = 0; // Track execution number for progress display

  // Analyze dependencies and create parallel execution groups
  const executionGroups = analyzeParallelGroups(plan.steps);
  const totalTools = plan.steps.length;

  console.log(`[Executor] Executing ${totalTools} steps in ${executionGroups.length} group(s)`);

  // Emit plan info event so UI knows what's coming
  if (onToolEvent) {
    await onToolEvent({
      type: "plan",
      tool: "",
      totalTools,
      allTools: plan.steps.map(s => s.tool),
    });
  }

  // Execute each group sequentially, but steps within a group run in parallel
  for (const group of executionGroups) {
    const groupTools = group.stepIndices.map(i => plan.steps[i].tool).join(", ");
    console.log(`[Executor] Starting group ${group.groupOrder} with ${group.stepIndices.length} step(s): [${groupTools}]`);

    const groupStartTime = Date.now();

    // Filter out steps whose dependencies failed
    const executableSteps = group.stepIndices.filter(stepIndex => {
      if (hasFailedDependency(stepIndex, plan, failedIndices)) {
        const step = plan.steps[stepIndex];
        console.warn(`[Executor] Skipping step ${stepIndex + 1} (${step.tool}) - dependency failed`);
        failedSteps.push({
          stepIndex,
          tool: step.tool,
          error: "Skipped due to failed dependency",
        });
        failedIndices.add(stepIndex);
        return false;
      }
      return true;
    });

    if (executableSteps.length === 0) {
      console.log(`[Executor] Group ${group.groupOrder} - all steps skipped due to failed dependencies`);
      continue;
    }

    // Execute all executable steps in this group in parallel
    // Assign execution numbers for progress display
    const groupPromises = executableSteps.map(stepIndex => {
      executionCounter++;
      const step = plan.steps[stepIndex];
      return executeStep({
        stepIndex,
        step,
        stepResults: stepResults.filter((r): r is StepResult => r !== undefined),
        query,
        onToolEvent,
        clientLocation,
        executionNumber: executionCounter,
        totalTools,
      });
    });

    // Wait for all steps using Promise.allSettled (doesn't fail fast)
    const settledResults = await Promise.allSettled(groupPromises);

    const groupDuration = Date.now() - groupStartTime;
    console.log(`[Executor] Group ${group.groupOrder} completed in ${groupDuration}ms`);

    // Process results - both fulfilled and rejected
    for (let i = 0; i < settledResults.length; i++) {
      const settled = settledResults[i];
      const stepIndex = executableSteps[i];
      const step = plan.steps[stepIndex];

      if (settled.status === "fulfilled") {
        const result = settled.value;

        if (result.result.success) {
          stepResults[result.stepIndex] = result;
          console.log(`[Executor] Step ${result.stepIndex + 1} (${result.tool}) completed successfully`);
        } else {
          // Tool returned error but didn't throw
          const error = result.result.error || `Step ${result.stepIndex + 1} (${result.tool}) failed`;
          console.warn(`[Executor] Step ${result.stepIndex + 1} (${result.tool}) failed:`, error);
          failedSteps.push({ stepIndex: result.stepIndex, tool: result.tool, error });
          failedIndices.add(result.stepIndex);
        }
      } else {
        // Promise was rejected (threw an error)
        const error = settled.reason?.message || `Step ${stepIndex + 1} (${step.tool}) threw an error`;
        console.error(`[Executor] Step ${stepIndex + 1} (${step.tool}) threw:`, error);
        failedSteps.push({ stepIndex, tool: step.tool, error });
        failedIndices.add(stepIndex);
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  const successfulResults = stepResults.filter((r): r is StepResult => r !== undefined);

  console.log(`[Executor] Completed in ${totalDuration}ms - ${successfulResults.length}/${plan.steps.length} steps succeeded`);

  // Determine overall success/partial status
  const allSucceeded = failedSteps.length === 0;
  const someSucceeded = successfulResults.length > 0;
  const partial = !allSucceeded && someSucceeded;

  if (partial) {
    console.log(`[Executor] Partial success: ${successfulResults.length} succeeded, ${failedSteps.length} failed`);
  }

  return {
    success: allSucceeded,
    partial,
    stepResults: successfulResults,
    failedSteps,
    error: failedSteps.length > 0 ? failedSteps[0].error : undefined,
  };
}

// =============================================================================
// Result Compiler
// =============================================================================

/**
 * Compile step results into a combined result for formatting
 */
function compileResults(
  plan: ExecutionPlan,
  stepResults: StepResult[]
): Record<string, unknown> {
  // If no steps, return conversation type
  if (stepResults.length === 0) {
    return { type: "conversation" };
  }

  // Single step: return the primary result
  if (stepResults.length === 1) {
    const step = stepResults[0];
    return {
      type: getResultType(step.tool),
      toolName: step.tool,
      data: step.result.data,
      params: step.parameters,
    };
  }

  // Multiple steps: determine the primary result based on the final step
  const finalStep = stepResults[stepResults.length - 1];
  const combinedData: Record<string, unknown> = {
    type: getResultType(finalStep.tool),
    toolName: finalStep.tool,
    data: finalStep.result.data,
    params: finalStep.parameters,
    // Include intermediate results for context
    intermediateResults: stepResults.slice(0, -1).map(r => ({
      tool: r.tool,
      data: r.result.data,
    })),
  };

  // Special handling for view data chains
  if (finalStep.tool === "get_view_data") {
    const listViewsStep = stepResults.find(r => r.tool === "list_views");
    if (listViewsStep?.result.success) {
      // list_views returns { views: [...], count: N }
      const viewsData = listViewsStep.result.data as { views?: Array<{ id: string; name: string; description?: string | null }> };
      const views = viewsData?.views || [];
      const viewId = finalStep.parameters.view_id as string;
      const matchedView = views.find(v => v.id === viewId);
      if (matchedView) {
        combinedData.type = "view_data";
        combinedData.viewName = matchedView.name;
        combinedData.viewDescription = matchedView.description || "";
      }
    }
  }

  // Special handling for weather with location detection
  if (finalStep.tool === "get_weather") {
    const locationStep = stepResults.find(r => r.tool === "get_user_location");
    if (locationStep?.result.success) {
      combinedData.detectedLocation = locationStep.result.data;
    }
  }

  return combinedData;
}

/**
 * Map tool name to result type for formatting
 */
function getResultType(tool: ToolName): string {
  const typeMap: Record<ToolName, string> = {
    get_weather: "weather",
    get_current_time: "time",
    list_views: "views_list",
    get_view_data: "view_data",
    fetch_url: "url",
    web_search: "search",
    get_user_location: "location",
  };
  return typeMap[tool] || tool;
}

// =============================================================================
// Main Orchestrator
// =============================================================================

/**
 * Main orchestration function that handles query analysis, planning, and execution.
 */
export async function orchestrateQuery(
  query: string,
  context: ConversationMessage[],
  options: OrchestratorOptions = {}
): Promise<OrchestrationResult> {
  const { onToolEvent, clientLocation } = options;

  console.log(`[Orchestrator] Processing: "${query.substring(0, 100)}..."`);
  if (clientLocation) {
    console.log(`[Orchestrator] Client location provided: ${clientLocation.city}, ${clientLocation.region}`);
  }

  // Step 1: Create execution plan using LLM
  const plan = await createExecutionPlan(query, context, clientLocation);

  // Step 2: Handle non-tool queries
  if (!plan.requiresTools) {
    console.log(`[Orchestrator] No tools needed: ${plan.noToolReason}`);
    return {
      success: true,
      results: [],
      combinedData: { type: "conversation" },
      plan,
    };
  }

  console.log(`[Orchestrator] Executing plan with ${plan.steps.length} steps`);

  // Step 3: Execute the plan (with graceful degradation for partial failures)
  const executionResult = await executePlan(plan, query, onToolEvent, clientLocation);
  const { success, partial, stepResults, failedSteps, error } = executionResult;

  // Step 4: Compile results from successful steps
  const results = stepResults.map(r => ({
    toolName: r.tool,
    result: r.result,
  }));

  // Handle complete failure (no successful steps)
  if (!success && !partial) {
    console.error(`[Orchestrator] Complete failure - no steps succeeded`);
    return {
      success: false,
      results,
      combinedData: {},
      error,
      plan,
    };
  }

  // Compile results (works with partial results too)
  const combinedData = compileResults(plan, stepResults);

  // For partial success, add info about what failed
  if (partial) {
    const failedToolNames = failedSteps.map(f => f.tool).join(", ");
    console.log(`[Orchestrator] Partial success - failed tools: ${failedToolNames}`);
    combinedData.partialFailure = true;
    combinedData.failedTools = failedSteps.map(f => ({ tool: f.tool, error: f.error }));
  }

  console.log(`[Orchestrator] Completed ${partial ? "partially" : "successfully"} with ${results.length} tool executions`);

  return {
    success: success || partial, // Treat partial as success for response generation
    results,
    combinedData,
    error: partial ? `Some tools failed: ${failedSteps.map(f => f.tool).join(", ")}` : undefined,
    plan,
  };
}

// =============================================================================
// Response Formatting (preserved from original)
// =============================================================================

/**
 * Build the context string for the LLM to format as a response
 */
export function buildFormattingContext(result: OrchestrationResult): string {
  if (!result.success) {
    return `ERROR: ${result.error}`;
  }

  const { combinedData } = result;

  switch (combinedData.type) {
    case "weather": {
      const data = combinedData.data as {
        location: string;
        temperature: number;
        feels_like: number;
        humidity: number;
        wind_speed: number;
        conditions: string;
        units: string;
      };
      return `WEATHER DATA (respond naturally):
Location: ${data.location}
Temperature: ${data.temperature} degrees ${data.units}
Feels like: ${data.feels_like} degrees ${data.units}
Conditions: ${data.conditions}
Humidity: ${data.humidity}%
Wind: ${data.wind_speed} km/h

Respond naturally, spelling out numbers for speech.`;
    }

    case "time": {
      const data = combinedData.data as {
        timezone: string;
        formatted: string;
      };
      const params = combinedData.params as { location?: string };
      return `TIME DATA (respond naturally):
Time: ${data.formatted}
Timezone: ${data.timezone}
${params?.location ? `Location: ${params.location}` : ""}

Respond naturally with the day, date and time. Spell out numbers for speech.`;
    }

    case "views_list": {
      // list_views returns { views: [...], count: N }
      const viewsData = combinedData.data as { views?: Array<{ id: string; name: string; description?: string | null }>; count?: number };
      const views = viewsData?.views || [];
      const viewsList = views.map(v => `- ${v.name}${v.description ? `: ${v.description}` : ""}`).join("\n");
      return `AVAILABLE VIEWS (${views.length} total):
${viewsList}

Ask which view they'd like to access.`;
    }

    case "view_data": {
      const viewName = combinedData.viewName;
      const data = combinedData.data;
      return `${String(viewName).toUpperCase()} DATA:
${JSON.stringify(data, null, 2)}

Respond naturally, summarizing the key items.`;
    }

    case "search": {
      const searchData = combinedData.data as { query?: string; results?: Array<{ title: string; snippet: string }> };
      const results = searchData?.results || [];
      if (results.length === 0) {
        return `No search results found. Let the user know you couldn't find relevant information.`;
      }
      const resultsList = results.map((r, i) => `${i + 1}. ${r.title}: ${r.snippet}`).join("\n");
      return `SEARCH RESULTS:
${resultsList}

Summarize the most relevant information naturally.`;
    }

    case "url": {
      const data = combinedData.data as { title?: string; content: string };
      const content = data.content.length > 1500 ? data.content.substring(0, 1500) + "..." : data.content;
      return `PAGE CONTENT:
Title: ${data.title || "Unknown"}
${content}

Summarize the key points naturally for voice output.`;
    }

    case "location": {
      const data = combinedData.data as {
        city: string;
        region: string;
        country: string;
        timezone: string;
      };
      return `USER LOCATION:
City: ${data.city}
Region: ${data.region}
Country: ${data.country}
Timezone: ${data.timezone}

Respond naturally, mentioning the detected location.`;
    }

    case "conversation":
      return "";

    default:
      return JSON.stringify(combinedData);
  }
}

/**
 * Get the system prompt for the formatting LLM call
 */
export function getFormattingSystemPrompt(): string {
  return `You are formatting data for VOICE output. The user is LISTENING, not reading.

CRITICAL RULES:
1. NEVER mention links, URLs, websites, or "click here" - users cannot click anything
2. NEVER say "refer to", "check out", "visit", or "see the link" - there are no links
3. NEVER say "more information at" or "details available on" - just give the information
4. The data provided is ACCURATE - do NOT modify facts
5. Format for natural speech (no markdown, no symbols)
6. Spell out numbers ("twenty-three" not "23")
7. Keep responses concise (1-3 sentences for simple data)
8. Use natural pauses (commas, periods)
9. ONLY respond in English
10. NO emojis or special characters

BAD: "You can find more details at the Bureau of Meteorology website."
GOOD: "There's a medium chance of showers this afternoon, clearing by evening."

BAD: "Check out this link for the forecast."
GOOD: "The forecast shows rain is expected around three PM."

Just speak the actual information naturally. If data shows an error, apologize briefly.`;
}

// =============================================================================
// Cache Management Utilities (for debugging/testing)
// =============================================================================

/**
 * Get cache statistics for monitoring
 */
export function getCacheStats(): {
  size: number;
  entries: Array<{ key: string; tool: string; ageSeconds: number; ttlRemaining: number }>;
} {
  const now = Date.now();
  const entries: Array<{ key: string; tool: string; ageSeconds: number; ttlRemaining: number }> = [];

  for (const [key, entry] of resultCache.entries()) {
    const tool = key.split(":")[0];
    entries.push({
      key,
      tool,
      ageSeconds: Math.round((now - entry.timestamp) / 1000),
      ttlRemaining: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
    });
  }

  return { size: resultCache.size, entries };
}

/**
 * Clear all cached results (useful for testing)
 */
export function clearCache(): void {
  const size = resultCache.size;
  resultCache.clear();
  console.log(`[Cache] Cleared ${size} entries`);
}

/**
 * Manually trigger cache cleanup (removes expired entries)
 */
export function runCacheCleanup(): number {
  const before = resultCache.size;
  cleanupCache();
  return before - resultCache.size;
}
