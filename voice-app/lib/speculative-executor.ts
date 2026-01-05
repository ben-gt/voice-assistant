/**
 * Speculative Execution System for Voice Assistant
 *
 * This module provides low-latency query handling by:
 * 1. Fast pattern-based intent classification (no LLM, <5ms)
 * 2. Speculative tool execution for high-confidence patterns
 * 3. Parallel LLM planning with result merging/discarding
 *
 * Architecture:
 * ```
 * Query arrives
 *     |-- Intent Classifier (sync, <5ms)
 *     |   Returns { tools: [...], confidence: 0-1, params: {...} }
 *     |
 *     |-- If confidence > threshold:
 *     |   |-- Start speculative execution (async)
 *     |   |-- Start LLM planner (async, in parallel)
 *     |
 *     |-- Wait for planner result:
 *         |-- If planner agrees -> use speculative result (saved ~200ms)
 *         |-- If planner differs -> discard speculative, use planner
 * ```
 *
 * Supported intent patterns:
 * - Weather: "weather", "temperature", "rain", "umbrella", "cold", "hot"
 * - Time: "what time", "current time", "date", "day"
 * - List/Views: "shopping list", "calendar", "tasks", "schedule"
 * - Search: "find", "search", "look up", "nearest"
 */

import { executeTool } from "@/app/api/tools";
import type { ToolName, ToolResult, ToolParameters } from "@/lib/tools";
import type { ClientLocation, ConversationMessage } from "./tool-orchestrator";

// =============================================================================
// Types
// =============================================================================

/** Result from intent classification */
export interface IntentClassification {
  /** Detected intent type */
  intent: IntentType;
  /** Tools that should be executed for this intent */
  tools: ToolName[];
  /** Confidence score (0-1), where 1 is highest confidence */
  confidence: number;
  /** Extracted parameters from the query */
  extractedParams: ExtractedParams;
  /** Pattern that matched (for debugging) */
  matchedPattern?: string;
}

/** Supported intent types */
export type IntentType =
  | "weather"
  | "time"
  | "list_views"
  | "view_data"
  | "search"
  | "location"
  | "unknown";

/** Parameters extracted from query text */
export interface ExtractedParams {
  location?: string;
  timezone?: string;
  units?: "celsius" | "fahrenheit";
  searchQuery?: string;
  viewType?: ViewType;
}

/** Types of views that can be detected from query */
export type ViewType =
  | "shopping"
  | "calendar"
  | "tasks"
  | "schedule"
  | "appointments"
  | "whiteboard"
  | "general";

/** Result of speculative execution */
export interface SpeculativeResult {
  /** Whether speculative execution was attempted */
  attempted: boolean;
  /** The classified intent */
  intent: IntentClassification;
  /** Tool execution results (if attempted) */
  results?: Map<ToolName, ToolResult>;
  /** Whether the execution completed before being cancelled */
  completed: boolean;
  /** Error if execution failed */
  error?: string;
  /** Execution time in milliseconds */
  executionTimeMs: number;
}

/** Handle for cancelling speculative execution */
export interface SpeculativeExecutionHandle {
  /** Promise that resolves with the speculative result */
  promise: Promise<SpeculativeResult>;
  /** Abort controller to cancel execution */
  abort: () => void;
  /** Check if execution is still running */
  isRunning: () => boolean;
  /** Get the intent classification (available immediately) */
  getIntent: () => IntentClassification;
}

/** Configuration for speculative execution */
export interface SpeculativeConfig {
  /** Minimum confidence to trigger speculation (default: 0.9) */
  confidenceThreshold: number;
  /** Maximum time to wait for speculative result (ms) */
  maxSpeculativeWaitMs: number;
  /** Whether to enable speculative execution */
  enabled: boolean;
}

/** Comparison result between speculative intent and planner */
export interface PlanComparison {
  /** Whether the plans are compatible */
  compatible: boolean;
  /** Reason for incompatibility */
  reason?: string;
  /** Tools that match between speculative and planner */
  matchingTools: ToolName[];
  /** Tools in planner not covered by speculation */
  missingTools: ToolName[];
  /** Tools speculated but not in planner */
  extraTools: ToolName[];
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_SPECULATIVE_CONFIG: SpeculativeConfig = {
  confidenceThreshold: 0.9,
  maxSpeculativeWaitMs: 500,
  enabled: true,
};

// =============================================================================
// Known Locations Database (shared with orchestrator)
// =============================================================================

const KNOWN_LOCATIONS: Record<
  string,
  { region: string; timezone: string; units: "celsius" | "fahrenheit" }
> = {
  lowood: { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  brisbane: { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  sydney: { region: "NSW, Australia", timezone: "Australia/Sydney", units: "celsius" },
  melbourne: { region: "Victoria, Australia", timezone: "Australia/Melbourne", units: "celsius" },
  perth: { region: "WA, Australia", timezone: "Australia/Perth", units: "celsius" },
  adelaide: { region: "SA, Australia", timezone: "Australia/Adelaide", units: "celsius" },
  darwin: { region: "NT, Australia", timezone: "Australia/Darwin", units: "celsius" },
  hobart: { region: "Tasmania, Australia", timezone: "Australia/Hobart", units: "celsius" },
  "gold coast": { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  ipswich: { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  toowoomba: { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  cairns: { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  townsville: { region: "Queensland, Australia", timezone: "Australia/Brisbane", units: "celsius" },
  canberra: { region: "ACT, Australia", timezone: "Australia/Sydney", units: "celsius" },
  "new york": { region: "New York, USA", timezone: "America/New_York", units: "fahrenheit" },
  "los angeles": { region: "California, USA", timezone: "America/Los_Angeles", units: "fahrenheit" },
  london: { region: "UK", timezone: "Europe/London", units: "celsius" },
  tokyo: { region: "Japan", timezone: "Asia/Tokyo", units: "celsius" },
  singapore: { region: "Singapore", timezone: "Asia/Singapore", units: "celsius" },
};

// =============================================================================
// Intent Pattern Definitions
// =============================================================================

interface IntentPattern {
  /** Regex patterns to match against query */
  patterns: RegExp[];
  /** Keywords that indicate this intent (checked after patterns) */
  keywords: string[];
  /** Base confidence for keyword matches */
  keywordConfidence: number;
  /** Base confidence for pattern matches */
  patternConfidence: number;
  /** The intent type */
  intent: IntentType;
  /** Tools to execute */
  tools: ToolName[];
}

const INTENT_PATTERNS: IntentPattern[] = [
  // Weather patterns - highest priority
  {
    intent: "weather",
    tools: ["get_weather"],
    patterns: [
      /what(?:'s| is) the weather/i,
      /how(?:'s| is) the weather/i,
      /weather (?:in|at|for|like)/i,
      /(?:will|is) it (?:rain|snow|cold|hot|warm)/i,
      /do I need (?:an? )?umbrella/i,
      /(?:temperature|temp) (?:in|at|for)/i,
      /what(?:'s| is) it like outside/i,
      /is it going to rain/i,
      /(?:how|what)(?:'s| is) (?:the )?(?:temp|temperature)/i,
    ],
    keywords: [
      "weather",
      "temperature",
      "rain",
      "raining",
      "umbrella",
      "cold",
      "hot",
      "warm",
      "sunny",
      "cloudy",
      "forecast",
      "humid",
      "humidity",
    ],
    patternConfidence: 0.95,
    keywordConfidence: 0.85,
  },

  // Time patterns
  {
    intent: "time",
    tools: ["get_current_time"],
    patterns: [
      /what(?:'s| is) the (?:current )?time/i,
      /what time is it/i,
      /current time/i,
      /what(?:'s| is) (?:the )?(?:date|day)/i,
      /what day (?:is it|of the week)/i,
      /what(?:'s| is) today(?:'s)? date/i,
    ],
    keywords: ["time", "date", "day", "clock", "hour", "minute"],
    patternConfidence: 0.95,
    keywordConfidence: 0.8,
  },

  // View data patterns (specific view requests)
  {
    intent: "view_data",
    tools: ["list_views", "get_view_data"],
    patterns: [
      /(?:what(?:'s| is)|show me|get|read) (?:my |the )?(?:shopping|grocery) list/i,
      /(?:what(?:'s| is)|show me) on (?:my |the )?(?:shopping|grocery) list/i,
      /(?:what(?:'s| is)|show me|get) (?:my |the )?calendar/i,
      /(?:what(?:'s| is)|show me|get) (?:my |the )?(?:task|todo|to-do)(?:s| list)?/i,
      /(?:what(?:'s| is)|show me|get) (?:my |the )?schedule/i,
      /(?:what(?:'s| is)|show me|get) (?:my |the )?appointments?/i,
    ],
    keywords: [],
    patternConfidence: 0.92,
    keywordConfidence: 0.0, // Only use patterns for view_data
  },

  // List views patterns (exploratory)
  {
    intent: "list_views",
    tools: ["list_views"],
    patterns: [
      /what (?:views|lists|boards) (?:do you have|are available|can you see)/i,
      /(?:show|list) (?:me )?(?:all )?(?:available )?(?:views|lists|boards)/i,
      /what can you see (?:from|on) (?:farmboard|the board)/i,
      /what(?:'s| is) (?:on|in) (?:farmboard|the board)/i,
    ],
    keywords: ["farmboard", "views", "boards", "lists"],
    patternConfidence: 0.9,
    keywordConfidence: 0.75,
  },

  // Search patterns
  {
    intent: "search",
    tools: ["web_search"],
    patterns: [
      /(?:search|look up|find|google) (?:for )?(.+)/i,
      /(?:what|where|who|how|when|why) (?:is|are|was|were|do|does|did|can|could|would|should) .{10,}/i,
      /(?:nearest|closest|nearby) (.+)/i,
    ],
    keywords: ["search", "find", "look up", "google", "nearest", "closest", "nearby"],
    patternConfidence: 0.85,
    keywordConfidence: 0.7,
  },

  // Location patterns
  {
    intent: "location",
    tools: ["get_user_location"],
    patterns: [
      /where am I/i,
      /(?:what(?:'s| is)|get) my (?:current )?location/i,
      /my location/i,
    ],
    keywords: [],
    patternConfidence: 0.95,
    keywordConfidence: 0.0,
  },
];

// =============================================================================
// Intent Classifier Implementation
// =============================================================================

/**
 * Fast, synchronous intent classifier using pattern matching.
 * Designed to complete in <5ms for predictable query patterns.
 *
 * @param query - The user's query text
 * @param context - Recent conversation history for context extraction
 * @param clientLocation - Optional pre-fetched client location
 * @returns IntentClassification with detected intent, tools, confidence, and params
 */
export function classifyIntent(
  query: string,
  context: ConversationMessage[] = [],
  clientLocation?: ClientLocation
): IntentClassification {
  const startTime = performance.now();
  const normalizedQuery = query.toLowerCase().trim();

  let bestMatch: IntentClassification = {
    intent: "unknown",
    tools: [],
    confidence: 0,
    extractedParams: {},
  };

  // Try each intent pattern
  for (const intentPattern of INTENT_PATTERNS) {
    // First try regex patterns (higher confidence)
    for (const pattern of intentPattern.patterns) {
      const match = pattern.exec(normalizedQuery);
      if (match) {
        const confidence = intentPattern.patternConfidence;
        if (confidence > bestMatch.confidence) {
          bestMatch = {
            intent: intentPattern.intent,
            tools: [...intentPattern.tools],
            confidence,
            extractedParams: {},
            matchedPattern: pattern.source,
          };
        }
        break; // Found a pattern match for this intent
      }
    }

    // If no pattern match, try keywords
    if (bestMatch.intent !== intentPattern.intent) {
      for (const keyword of intentPattern.keywords) {
        if (normalizedQuery.includes(keyword)) {
          const confidence = intentPattern.keywordConfidence;
          if (confidence > bestMatch.confidence) {
            bestMatch = {
              intent: intentPattern.intent,
              tools: [...intentPattern.tools],
              confidence,
              extractedParams: {},
              matchedPattern: `keyword:${keyword}`,
            };
          }
          break; // Found a keyword match for this intent
        }
      }
    }
  }

  // Extract parameters based on intent type
  if (bestMatch.intent !== "unknown") {
    bestMatch.extractedParams = extractParams(
      bestMatch.intent,
      query,
      context,
      clientLocation
    );

    // Boost confidence if we extracted strong parameters
    if (bestMatch.extractedParams.location || bestMatch.extractedParams.timezone) {
      bestMatch.confidence = Math.min(1.0, bestMatch.confidence + 0.03);
    }
  }

  const duration = performance.now() - startTime;
  console.log(
    `[IntentClassifier] Classified "${query.substring(0, 50)}..." as ${bestMatch.intent} ` +
      `(confidence: ${bestMatch.confidence.toFixed(2)}) in ${duration.toFixed(1)}ms`
  );

  return bestMatch;
}

/**
 * Extract parameters from query based on intent type
 */
function extractParams(
  intent: IntentType,
  query: string,
  context: ConversationMessage[],
  clientLocation?: ClientLocation
): ExtractedParams {
  const params: ExtractedParams = {};
  const normalizedQuery = query.toLowerCase();

  // Extract location from query
  const locationMatch = extractLocationFromQuery(normalizedQuery);
  if (locationMatch) {
    params.location = locationMatch.location;
    params.timezone = locationMatch.timezone;
    params.units = locationMatch.units;
  }

  // If no location in query, check conversation context
  if (!params.location) {
    const contextLocation = extractLocationFromContext(context);
    if (contextLocation) {
      params.location = contextLocation.location;
      params.timezone = contextLocation.timezone;
      params.units = contextLocation.units;
    }
  }

  // If still no location, use client location
  if (!params.location && clientLocation?.city) {
    params.location = `${clientLocation.city}, ${clientLocation.region || ""}, ${clientLocation.country || ""}`.replace(
      /,\s*,/g,
      ","
    ).replace(/,\s*$/,"");
    params.timezone = clientLocation.timezone;
    // Default to celsius unless US
    params.units = clientLocation.countryCode === "US" ? "fahrenheit" : "celsius";
  }

  // Extract view type for list/view intents
  if (intent === "view_data" || intent === "list_views") {
    params.viewType = extractViewType(normalizedQuery);
  }

  // Extract search query for search intent
  if (intent === "search") {
    params.searchQuery = extractSearchQuery(query, params.location);
  }

  return params;
}

/**
 * Extract location mentions from the query text
 */
function extractLocationFromQuery(
  query: string
): { location: string; timezone: string; units: "celsius" | "fahrenheit" } | null {
  // Check known locations (longer names first)
  const sortedLocations = Object.entries(KNOWN_LOCATIONS).sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [loc, info] of sortedLocations) {
    const regex = new RegExp(`\\b${loc.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (regex.test(query)) {
      return {
        location: `${loc.charAt(0).toUpperCase() + loc.slice(1)}, ${info.region}`,
        timezone: info.timezone,
        units: info.units,
      };
    }
  }

  // Try to extract location from patterns like "weather in X" or "time in X"
  const locationPatterns = [
    /(?:weather|temperature|time|rain)\s+(?:in|at|for)\s+([a-z][a-z\s]{1,30}?)(?:\s*[.,!?]|$)/i,
    /(?:in|at|for|near)\s+([a-z][a-z\s]{1,30}?)(?:\s*[.,!?]|$)/i,
  ];

  for (const pattern of locationPatterns) {
    const match = query.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim();
      const knownInfo = KNOWN_LOCATIONS[extracted.toLowerCase()];
      if (knownInfo) {
        return {
          location: `${extracted}, ${knownInfo.region}`,
          timezone: knownInfo.timezone,
          units: knownInfo.units,
        };
      }
      // Return unknown location without timezone
      return {
        location: extracted,
        timezone: "UTC",
        units: "celsius",
      };
    }
  }

  return null;
}

/**
 * Extract location from conversation context
 */
function extractLocationFromContext(
  context: ConversationMessage[]
): { location: string; timezone: string; units: "celsius" | "fahrenheit" } | null {
  // Search recent messages for location mentions
  for (let i = context.length - 1; i >= 0 && i >= context.length - 6; i--) {
    const msg = context[i];
    const lower = msg.content.toLowerCase();

    // Check known locations
    const sortedLocations = Object.entries(KNOWN_LOCATIONS).sort(
      (a, b) => b[0].length - a[0].length
    );

    for (const [loc, info] of sortedLocations) {
      const regex = new RegExp(`\\b${loc.replace(/\s+/g, "\\s+")}\\b`, "i");
      if (regex.test(lower)) {
        return {
          location: `${loc.charAt(0).toUpperCase() + loc.slice(1)}, ${info.region}`,
          timezone: info.timezone,
          units: info.units,
        };
      }
    }

    // Try pattern matching for "I'm in X" or "I live in X"
    const patterns = [
      /(?:i'm in|i am in|i live in|located in|from)\s+([a-z][a-z\s]{1,30}?)(?:\s*[.,!?]|$)/i,
    ];

    for (const pattern of patterns) {
      const match = msg.content.match(pattern);
      if (match?.[1]) {
        const extracted = match[1].trim();
        const knownInfo = KNOWN_LOCATIONS[extracted.toLowerCase()];
        if (knownInfo) {
          return {
            location: extracted,
            timezone: knownInfo.timezone,
            units: knownInfo.units,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Extract the type of view being requested
 */
function extractViewType(query: string): ViewType {
  const viewKeywords: Record<ViewType, string[]> = {
    shopping: ["shopping", "grocery", "groceries", "buy", "store"],
    calendar: ["calendar", "events", "appointments"],
    tasks: ["task", "tasks", "todo", "to-do", "to do"],
    schedule: ["schedule", "agenda"],
    appointments: ["appointment", "appointments", "meeting", "meetings"],
    whiteboard: ["whiteboard", "board", "notes"],
    general: [],
  };

  for (const [viewType, keywords] of Object.entries(viewKeywords)) {
    if (keywords.some((kw) => query.includes(kw))) {
      return viewType as ViewType;
    }
  }

  return "general";
}

/**
 * Extract search query, optionally adding location for local searches
 */
function extractSearchQuery(query: string, location?: string): string {
  // Remove common prefixes
  let searchQuery = query
    .replace(/^(?:search|look up|find|google)\s+(?:for\s+)?/i, "")
    .trim();

  // Add location for local searches
  const localKeywords = ["nearest", "closest", "nearby", "near me", "around here"];
  const isLocalSearch = localKeywords.some((kw) =>
    query.toLowerCase().includes(kw)
  );

  if (isLocalSearch && location) {
    // Remove local keywords and add location
    searchQuery = searchQuery
      .replace(/\b(?:nearest|closest|nearby|near me|around here)\b/gi, "")
      .trim();
    searchQuery = `${searchQuery} near ${location}`;
  }

  return searchQuery;
}

// =============================================================================
// Speculative Executor Implementation
// =============================================================================

/**
 * Start speculative execution for a query.
 * Returns a handle that allows cancellation and result retrieval.
 *
 * @param query - The user's query
 * @param context - Conversation context
 * @param clientLocation - Optional client location
 * @param config - Speculative execution configuration
 * @returns Handle for managing the speculative execution
 */
export function startSpeculativeExecution(
  query: string,
  context: ConversationMessage[] = [],
  clientLocation?: ClientLocation,
  config: Partial<SpeculativeConfig> = {}
): SpeculativeExecutionHandle {
  const fullConfig = { ...DEFAULT_SPECULATIVE_CONFIG, ...config };
  const startTime = performance.now();

  // Classify intent immediately (sync, <5ms)
  const intent = classifyIntent(query, context, clientLocation);

  // Track execution state
  let isRunning = true;
  let aborted = false;
  const abortController = new AbortController();

  // Create the execution promise
  const executionPromise = (async (): Promise<SpeculativeResult> => {
    // Don't execute if disabled or below threshold
    if (!fullConfig.enabled || intent.confidence < fullConfig.confidenceThreshold) {
      isRunning = false;
      return {
        attempted: false,
        intent,
        completed: true,
        executionTimeMs: performance.now() - startTime,
      };
    }

    console.log(
      `[SpeculativeExecutor] Starting speculative execution for intent: ${intent.intent} ` +
        `(confidence: ${intent.confidence.toFixed(2)})`
    );

    const results = new Map<ToolName, ToolResult>();

    try {
      // Execute tools based on intent
      const toolPromises: Promise<void>[] = [];

      for (const tool of intent.tools) {
        // Check for abort before starting each tool
        if (aborted || abortController.signal.aborted) {
          console.log(`[SpeculativeExecutor] Aborted before executing ${tool}`);
          break;
        }

        const toolPromise = executeToolSpeculatively(
          tool,
          intent,
          clientLocation,
          abortController.signal
        ).then((result) => {
          if (!aborted) {
            results.set(tool, result);
          }
        });

        toolPromises.push(toolPromise);
      }

      // Wait for all tools or abort
      await Promise.race([
        Promise.all(toolPromises),
        new Promise<void>((_, reject) => {
          abortController.signal.addEventListener("abort", () => {
            reject(new Error("Speculative execution aborted"));
          });
        }),
      ]).catch((err) => {
        if (err.message !== "Speculative execution aborted") {
          throw err;
        }
      });

      isRunning = false;

      return {
        attempted: true,
        intent,
        results,
        completed: !aborted,
        executionTimeMs: performance.now() - startTime,
      };
    } catch (error) {
      isRunning = false;
      console.error("[SpeculativeExecutor] Execution error:", error);
      return {
        attempted: true,
        intent,
        results,
        completed: false,
        error: error instanceof Error ? error.message : "Unknown error",
        executionTimeMs: performance.now() - startTime,
      };
    }
  })();

  return {
    promise: executionPromise,
    abort: () => {
      aborted = true;
      abortController.abort();
      console.log("[SpeculativeExecutor] Abort requested");
    },
    isRunning: () => isRunning,
    getIntent: () => intent,
  };
}

/**
 * Execute a single tool speculatively with abort support
 */
async function executeToolSpeculatively(
  tool: ToolName,
  intent: IntentClassification,
  clientLocation?: ClientLocation,
  abortSignal?: AbortSignal
): Promise<ToolResult> {
  // Check abort before execution
  if (abortSignal?.aborted) {
    return { success: false, error: "Execution aborted" };
  }

  const params = buildToolParams(tool, intent, clientLocation);

  console.log(
    `[SpeculativeExecutor] Executing ${tool} with params:`,
    JSON.stringify(params)
  );

  // Handle get_user_location specially if we have client location
  if (tool === "get_user_location" && clientLocation) {
    return {
      success: true,
      data: {
        location: `${clientLocation.city || ""}, ${clientLocation.region || ""}, ${clientLocation.country || ""}`.replace(
          /^, |, $/g,
          ""
        ),
        city: clientLocation.city || "",
        region: clientLocation.region || "",
        country: clientLocation.country || "",
        countryCode: clientLocation.countryCode || "",
        timezone:
          clientLocation.timezone ||
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        coordinates: {
          latitude: clientLocation.latitude,
          longitude: clientLocation.longitude,
        },
        source: "browser",
      },
    };
  }

  // Execute the tool
  const result = await executeTool(tool, params);

  // Check abort after execution
  if (abortSignal?.aborted) {
    return { success: false, error: "Execution aborted" };
  }

  return result;
}

/**
 * Build tool parameters from intent classification
 */
function buildToolParams(
  tool: ToolName,
  intent: IntentClassification,
  clientLocation?: ClientLocation
): Record<string, unknown> {
  const { extractedParams } = intent;

  switch (tool) {
    case "get_weather":
      return {
        location: extractedParams.location || clientLocation?.city || "",
        units: extractedParams.units || "celsius",
      } satisfies ToolParameters["get_weather"];

    case "get_current_time":
      return {
        timezone: extractedParams.timezone,
        location: extractedParams.location?.split(",")[0],
      } satisfies ToolParameters["get_current_time"];

    case "list_views":
      return {} satisfies ToolParameters["list_views"];

    case "get_view_data":
      // For speculative execution, we can't know the view_id yet
      // This will be resolved after list_views completes
      return { view_id: "" } satisfies ToolParameters["get_view_data"];

    case "web_search":
      return {
        query: extractedParams.searchQuery || "",
        num_results: 5,
      } satisfies ToolParameters["web_search"];

    case "fetch_url":
      return { url: "" } satisfies ToolParameters["fetch_url"];

    case "get_user_location":
      return {} satisfies ToolParameters["get_user_location"];

    default:
      return {};
  }
}

// =============================================================================
// Plan Comparison Logic
// =============================================================================

/**
 * Compare speculative intent with LLM planner result to determine compatibility.
 *
 * Compatible if:
 * - Same primary tool(s)
 * - Compatible parameters
 * - No additional critical tools needed
 *
 * @param speculativeIntent - The intent from classification
 * @param plannerTools - Tools from the LLM planner
 * @param plannerParams - Parameters from the LLM planner
 * @returns Comparison result indicating compatibility
 */
export function comparePlans(
  speculativeIntent: IntentClassification,
  plannerTools: ToolName[],
  plannerParams?: Record<ToolName, Record<string, unknown>>
): PlanComparison {
  const speculativeTools = new Set(speculativeIntent.tools);
  const plannerToolSet = new Set(plannerTools);

  const matchingTools: ToolName[] = [];
  const missingTools: ToolName[] = [];
  const extraTools: ToolName[] = [];

  // Find matching tools
  for (const tool of speculativeIntent.tools) {
    if (plannerToolSet.has(tool)) {
      matchingTools.push(tool);
    } else {
      extraTools.push(tool);
    }
  }

  // Find missing tools
  for (const tool of plannerTools) {
    if (!speculativeTools.has(tool)) {
      missingTools.push(tool);
    }
  }

  // Determine compatibility
  let compatible = true;
  let reason: string | undefined;

  // Must have at least one matching tool
  if (matchingTools.length === 0) {
    compatible = false;
    reason = "No matching tools between speculative and planner";
  }

  // Check for critical missing tools that would change the result
  const criticalTools: ToolName[] = [
    "get_user_location",
    "list_views",
    "get_view_data",
  ];
  const missingCritical = missingTools.filter((t) => criticalTools.includes(t));

  if (missingCritical.length > 0) {
    compatible = false;
    reason = `Missing critical tools: ${missingCritical.join(", ")}`;
  }

  // If planner has significantly different tool count, be cautious
  if (plannerTools.length > speculativeIntent.tools.length * 2) {
    compatible = false;
    reason = "Planner has significantly more tools than speculative";
  }

  // Parameter compatibility check (if params provided)
  if (compatible && plannerParams) {
    for (const tool of matchingTools) {
      const speculativeParam = buildToolParams(
        tool,
        speculativeIntent,
        undefined
      );
      const plannerParam = plannerParams[tool];

      if (
        plannerParam &&
        !areParamsCompatible(tool, speculativeParam, plannerParam)
      ) {
        compatible = false;
        reason = `Incompatible parameters for ${tool}`;
        break;
      }
    }
  }

  console.log(
    `[PlanComparison] Compatible: ${compatible}, Matching: [${matchingTools.join(", ")}], ` +
      `Missing: [${missingTools.join(", ")}], Extra: [${extraTools.join(", ")}]` +
      (reason ? `, Reason: ${reason}` : "")
  );

  return {
    compatible,
    reason,
    matchingTools,
    missingTools,
    extraTools,
  };
}

/**
 * Check if speculative params are compatible with planner params
 */
function areParamsCompatible(
  tool: ToolName,
  speculative: Record<string, unknown>,
  planner: Record<string, unknown>
): boolean {
  switch (tool) {
    case "get_weather": {
      // Location should be similar (case-insensitive, partial match OK)
      const specLoc = String(speculative.location || "").toLowerCase();
      const planLoc = String(planner.location || "").toLowerCase();

      if (!specLoc || !planLoc) return false;

      // Check if one contains the other (e.g., "Brisbane" vs "Brisbane, Queensland")
      return specLoc.includes(planLoc) || planLoc.includes(specLoc);
    }

    case "get_current_time": {
      // Timezone should match if both specified
      const specTz = speculative.timezone;
      const planTz = planner.timezone;

      if (specTz && planTz && specTz !== planTz) {
        return false;
      }
      return true;
    }

    case "web_search": {
      // Search queries should be similar
      const specQuery = String(speculative.query || "").toLowerCase();
      const planQuery = String(planner.query || "").toLowerCase();

      if (!specQuery || !planQuery) return false;

      // Check for significant word overlap
      const specWords = new Set(specQuery.split(/\s+/));
      const planWords = new Set(planQuery.split(/\s+/));
      let overlap = 0;
      for (const word of specWords) {
        if (planWords.has(word)) overlap++;
      }

      return overlap >= Math.min(specWords.size, planWords.size) * 0.5;
    }

    default:
      return true;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Merge speculative results with planner results.
 * Used when speculative and planner are compatible.
 *
 * @param speculativeResults - Results from speculative execution
 * @param plannerTools - Tools from planner (in execution order)
 * @returns Merged results map
 */
export function mergeResults(
  speculativeResults: Map<ToolName, ToolResult>,
  plannerTools: ToolName[]
): Map<ToolName, ToolResult> {
  const merged = new Map<ToolName, ToolResult>();

  // Add speculative results for tools that are in planner
  for (const tool of plannerTools) {
    const speculativeResult = speculativeResults.get(tool);
    if (speculativeResult?.success) {
      merged.set(tool, speculativeResult);
    }
  }

  return merged;
}

/**
 * Get estimated latency savings from speculative execution
 */
export function estimateLatencySavings(
  speculativeResult: SpeculativeResult,
  plannerDurationMs: number
): number {
  if (!speculativeResult.attempted || !speculativeResult.completed) {
    return 0;
  }

  // If speculative finished before planner, we saved the execution time
  if (speculativeResult.executionTimeMs < plannerDurationMs) {
    return speculativeResult.executionTimeMs;
  }

  return 0;
}

// =============================================================================
// Metrics and Debugging
// =============================================================================

export interface SpeculativeMetrics {
  totalQueries: number;
  speculativeAttempts: number;
  speculativeHits: number;
  speculativeMisses: number;
  averageConfidence: number;
  averageLatencySavedMs: number;
  intentDistribution: Record<IntentType, number>;
}

let metrics: SpeculativeMetrics = {
  totalQueries: 0,
  speculativeAttempts: 0,
  speculativeHits: 0,
  speculativeMisses: 0,
  averageConfidence: 0,
  averageLatencySavedMs: 0,
  intentDistribution: {
    weather: 0,
    time: 0,
    list_views: 0,
    view_data: 0,
    search: 0,
    location: 0,
    unknown: 0,
  },
};

/**
 * Record metrics for a speculative execution
 */
export function recordMetrics(
  intent: IntentClassification,
  wasHit: boolean,
  latencySavedMs: number
): void {
  metrics.totalQueries++;
  metrics.intentDistribution[intent.intent]++;

  if (intent.confidence >= DEFAULT_SPECULATIVE_CONFIG.confidenceThreshold) {
    metrics.speculativeAttempts++;
    if (wasHit) {
      metrics.speculativeHits++;
      metrics.averageLatencySavedMs =
        (metrics.averageLatencySavedMs * (metrics.speculativeHits - 1) +
          latencySavedMs) /
        metrics.speculativeHits;
    } else {
      metrics.speculativeMisses++;
    }
  }

  metrics.averageConfidence =
    (metrics.averageConfidence * (metrics.totalQueries - 1) +
      intent.confidence) /
    metrics.totalQueries;
}

/**
 * Get current speculative execution metrics
 */
export function getMetrics(): SpeculativeMetrics {
  return { ...metrics };
}

/**
 * Reset metrics (for testing)
 */
export function resetMetrics(): void {
  metrics = {
    totalQueries: 0,
    speculativeAttempts: 0,
    speculativeHits: 0,
    speculativeMisses: 0,
    averageConfidence: 0,
    averageLatencySavedMs: 0,
    intentDistribution: {
      weather: 0,
      time: 0,
      list_views: 0,
      view_data: 0,
      search: 0,
      location: 0,
      unknown: 0,
    },
  };
}
