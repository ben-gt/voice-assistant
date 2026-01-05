/**
 * Speculative Orchestrator
 *
 * This module provides the integration layer between the speculative executor
 * and the existing tool orchestrator. It implements the full speculative
 * execution flow:
 *
 * 1. Receive query
 * 2. Start intent classification (sync, <5ms)
 * 3. If high confidence: start speculative execution AND LLM planner in parallel
 * 4. Wait for planner result
 * 5. Compare plans and either use speculative result or execute planner's plan
 *
 * Usage:
 * ```typescript
 * const result = await orchestrateWithSpeculation(
 *   "What's the weather in Brisbane?",
 *   conversationContext,
 *   { clientLocation }
 * );
 * ```
 */

import {
  orchestrateQuery,
  type ConversationMessage,
  type OrchestrationResult,
  type OrchestratorOptions,
  type ClientLocation,
  type ExecutionPlan,
  type PlanStep,
} from "./tool-orchestrator";

import {
  classifyIntent,
  startSpeculativeExecution,
  comparePlans,
  mergeResults,
  recordMetrics,
  estimateLatencySavings,
  type IntentClassification,
  type SpeculativeResult,
  type SpeculativeConfig,
  type SpeculativeExecutionHandle,
  DEFAULT_SPECULATIVE_CONFIG,
} from "./speculative-executor";

import type { ToolName, ToolResult } from "@/lib/tools";

// =============================================================================
// Types
// =============================================================================

export interface SpeculativeOrchestratorOptions extends OrchestratorOptions {
  /** Configuration for speculative execution */
  speculativeConfig?: Partial<SpeculativeConfig>;
  /** Callback when speculative execution completes */
  onSpeculativeComplete?: (result: SpeculativeResult) => void;
  /** Callback when plan comparison is done */
  onPlanComparison?: (
    speculative: IntentClassification,
    planner: ExecutionPlan,
    compatible: boolean
  ) => void;
}

export interface SpeculativeOrchestrationResult extends OrchestrationResult {
  /** Whether speculative execution was used */
  usedSpeculative: boolean;
  /** Latency saved by speculative execution (ms) */
  latencySavedMs: number;
  /** The intent classification */
  intent?: IntentClassification;
  /** Timing breakdown */
  timing: {
    classificationMs: number;
    speculativeMs?: number;
    plannerMs: number;
    executionMs: number;
    totalMs: number;
  };
}

// =============================================================================
// Main Orchestration Function
// =============================================================================

/**
 * Orchestrate a query with speculative execution for common patterns.
 *
 * Flow:
 * 1. Classify intent (sync, <5ms)
 * 2. If confidence >= threshold:
 *    - Start speculative execution (async)
 *    - Start LLM planner (async)
 * 3. Wait for planner
 * 4. Compare speculative intent with planner
 * 5. If compatible: use speculative results
 *    If not compatible: use planner's execution
 *
 * @param query - User's query
 * @param context - Conversation history
 * @param options - Orchestration options
 * @returns Orchestration result with speculative execution metadata
 */
export async function orchestrateWithSpeculation(
  query: string,
  context: ConversationMessage[],
  options: SpeculativeOrchestratorOptions = {}
): Promise<SpeculativeOrchestrationResult> {
  const startTime = performance.now();
  const config = { ...DEFAULT_SPECULATIVE_CONFIG, ...options.speculativeConfig };

  // ==========================================================================
  // Step 1: Intent Classification (sync, <5ms)
  // ==========================================================================
  const classificationStart = performance.now();
  const intent = classifyIntent(query, context, options.clientLocation);
  const classificationMs = performance.now() - classificationStart;

  console.log(
    `[SpeculativeOrchestrator] Intent: ${intent.intent}, Confidence: ${intent.confidence.toFixed(2)}, ` +
      `Classification: ${classificationMs.toFixed(1)}ms`
  );

  // ==========================================================================
  // Step 2: Decide whether to speculate
  // ==========================================================================
  const shouldSpeculate =
    config.enabled && intent.confidence >= config.confidenceThreshold;

  let speculativeHandle: SpeculativeExecutionHandle | null = null;
  let speculativeResult: SpeculativeResult | null = null;

  if (shouldSpeculate) {
    // ==========================================================================
    // Step 3: Start speculative execution in parallel with planner
    // ==========================================================================
    console.log(
      `[SpeculativeOrchestrator] Starting speculative execution for ${intent.intent}`
    );

    speculativeHandle = startSpeculativeExecution(
      query,
      context,
      options.clientLocation,
      config
    );
  }

  // ==========================================================================
  // Step 4: Run LLM planner (always runs in parallel with speculation)
  // ==========================================================================
  const plannerStart = performance.now();
  const plannerResult = await orchestrateQuery(query, context, {
    onToolEvent: options.onToolEvent,
    clientLocation: options.clientLocation,
  });
  const plannerMs = performance.now() - plannerStart;

  console.log(
    `[SpeculativeOrchestrator] Planner completed in ${plannerMs.toFixed(1)}ms`
  );

  // ==========================================================================
  // Step 5: Compare and decide
  // ==========================================================================
  let usedSpeculative = false;
  let latencySavedMs = 0;
  let finalResult: OrchestrationResult = plannerResult;

  if (speculativeHandle) {
    // Get speculative result (should be done or nearly done by now)
    speculativeResult = await Promise.race([
      speculativeHandle.promise,
      // Timeout to prevent waiting too long
      new Promise<SpeculativeResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              attempted: true,
              intent,
              completed: false,
              executionTimeMs: config.maxSpeculativeWaitMs,
              error: "Timeout waiting for speculative result",
            }),
          config.maxSpeculativeWaitMs
        )
      ),
    ]);

    if (options.onSpeculativeComplete) {
      options.onSpeculativeComplete(speculativeResult);
    }

    console.log(
      `[SpeculativeOrchestrator] Speculative execution: ` +
        `attempted=${speculativeResult.attempted}, completed=${speculativeResult.completed}, ` +
        `time=${speculativeResult.executionTimeMs.toFixed(1)}ms`
    );

    // Compare plans if speculative execution completed
    if (
      speculativeResult.attempted &&
      speculativeResult.completed &&
      speculativeResult.results
    ) {
      const plannerTools = plannerResult.plan?.steps.map((s) => s.tool) || [];
      const comparison = comparePlans(intent, plannerTools);

      if (options.onPlanComparison && plannerResult.plan) {
        options.onPlanComparison(intent, plannerResult.plan, comparison.compatible);
      }

      if (comparison.compatible) {
        // Use speculative results
        console.log(
          `[SpeculativeOrchestrator] Using speculative results (compatible plan)`
        );

        usedSpeculative = true;
        latencySavedMs = estimateLatencySavings(speculativeResult, plannerMs);

        // Build result from speculative execution
        finalResult = buildResultFromSpeculative(
          speculativeResult,
          plannerResult,
          intent
        );
      } else {
        // Discard speculative results
        console.log(
          `[SpeculativeOrchestrator] Discarding speculative results: ${comparison.reason}`
        );
        speculativeHandle.abort();
      }
    } else if (speculativeHandle.isRunning()) {
      // Abort if still running
      speculativeHandle.abort();
    }
  }

  // Record metrics
  recordMetrics(intent, usedSpeculative, latencySavedMs);

  const totalMs = performance.now() - startTime;

  console.log(
    `[SpeculativeOrchestrator] Completed in ${totalMs.toFixed(1)}ms ` +
      `(speculative: ${usedSpeculative}, saved: ${latencySavedMs.toFixed(1)}ms)`
  );

  return {
    ...finalResult,
    usedSpeculative,
    latencySavedMs,
    intent,
    timing: {
      classificationMs,
      speculativeMs: speculativeResult?.executionTimeMs,
      plannerMs,
      executionMs: usedSpeculative
        ? speculativeResult?.executionTimeMs || 0
        : plannerMs,
      totalMs,
    },
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Build an OrchestrationResult from speculative execution results
 */
function buildResultFromSpeculative(
  speculativeResult: SpeculativeResult,
  plannerResult: OrchestrationResult,
  intent: IntentClassification
): OrchestrationResult {
  if (!speculativeResult.results || speculativeResult.results.size === 0) {
    return plannerResult;
  }

  // Convert Map to array of results
  const results: Array<{ toolName: string; result: ToolResult }> = [];
  const combinedData: Record<string, unknown> = {};

  for (const [tool, result] of speculativeResult.results) {
    results.push({ toolName: tool, result });

    if (result.success && result.data) {
      // Add to combined data based on tool type
      switch (tool) {
        case "get_weather":
          combinedData.type = "weather";
          combinedData.data = result.data;
          combinedData.toolName = tool;
          break;
        case "get_current_time":
          combinedData.type = "time";
          combinedData.data = result.data;
          combinedData.toolName = tool;
          break;
        case "list_views":
          combinedData.type = "views_list";
          combinedData.data = result.data;
          combinedData.toolName = tool;
          break;
        case "web_search":
          combinedData.type = "search";
          combinedData.data = result.data;
          combinedData.toolName = tool;
          break;
        case "get_user_location":
          combinedData.type = "location";
          combinedData.data = result.data;
          combinedData.toolName = tool;
          break;
        default:
          combinedData.data = result.data;
          combinedData.toolName = tool;
      }
    }
  }

  // Check if all results were successful
  const allSuccessful = Array.from(speculativeResult.results.values()).every(
    (r) => r.success
  );

  return {
    success: allSuccessful,
    results,
    combinedData,
    plan: plannerResult.plan, // Keep the planner's plan for reference
    error: allSuccessful
      ? undefined
      : "Some speculative executions failed",
  };
}

// =============================================================================
// Convenience Exports
// =============================================================================

export {
  classifyIntent,
  getMetrics,
  resetMetrics,
  DEFAULT_SPECULATIVE_CONFIG,
} from "./speculative-executor";

export type {
  IntentClassification,
  IntentType,
  SpeculativeConfig,
  SpeculativeResult,
  ExtractedParams,
  ViewType,
} from "./speculative-executor";
