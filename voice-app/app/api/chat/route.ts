import { NextRequest } from "next/server";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { tools, executeTool } from "../tools";
import {
  buildFormattingContext,
  getFormattingSystemPrompt,
  type ConversationMessage,
} from "@/lib/tool-orchestrator";
import {
  orchestrateWithSpeculation,
  type SpeculativeOrchestrationResult,
} from "@/lib/speculative-orchestrator";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClientLocation {
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  timezone?: string;
}

// Stream event types for tool execution feedback
type StreamEvent =
  | { type: "tool_start"; tool: string; toolIndex?: number; totalTools?: number }
  | { type: "tool_end"; tool: string }
  | { type: "plan_info"; totalTools: number; tools: string[] }
  | { type: "speculative_status"; usedSpeculative: boolean; latencySavedMs: number }
  | { type: "token"; token: string }
  | { type: "response"; response: string; toolsUsed?: string[] }
  | { type: "error"; error: string };

/**
 * Encode a Server-Sent Event message
 */
function encodeSSE(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

type ContentRating = "G" | "PG" | "M" | "MA" | "R";

const RATING_GUIDELINES: Record<ContentRating, string> = {
  G: `CONTENT GUIDELINES (G - General):
- Content must be suitable for all ages, including young children
- Use simple, clear language appropriate for children
- Avoid any violence, scary themes, or mature concepts
- No references to alcohol, drugs, or adult relationships
- Keep topics educational, playful, and family-friendly`,

  PG: `CONTENT GUIDELINES (PG - Parental Guidance):
- Content suitable for most audiences with parental guidance for younger children
- Mild themes are acceptable but avoid anything frightening or distressing
- No explicit violence, only mild cartoon-style conflict if needed
- Avoid detailed discussion of mature themes`,

  M: `CONTENT GUIDELINES (M - Mature):
- Content recommended for ages 15 and over
- Moderate themes and discussions are acceptable
- Can discuss complex topics including mild violence in historical or educational contexts
- Provide balanced, thoughtful responses to sensitive topics`,

  MA: `CONTENT GUIDELINES (MA15+ - Mature Accompanied):
- Content suitable for ages 15 and over
- Can discuss strong themes including violence in appropriate contexts
- More detailed discussion of mature topics is acceptable`,

  R: `CONTENT GUIDELINES (R18+ - Restricted):
- Content for adults only
- Can engage with mature themes openly and directly
- Provide straightforward, uncensored responses where appropriate`,
};

/**
 * Build the system prompt for conversational queries
 * (This is only used when no tool is forced - i.e., general conversation)
 */
function buildConversationalSystemPrompt(contentRating: ContentRating): string {
  const ratingGuidelines = RATING_GUIDELINES[contentRating] || RATING_GUIDELINES.M;

  return `You are a helpful voice assistant having a natural spoken conversation.

CRITICAL OUTPUT RULES:
- Your response will be sent directly to a text-to-speech service and played as audio
- NEVER use <think> tags or any internal reasoning - just respond directly
- NEVER use text annotations like *clears throat*, *laughs*, *sighs*, or any asterisk-enclosed actions
- NEVER use markdown formatting (no **, no #, no bullet points, no numbered lists)
- NEVER use special characters that don't pronounce naturally (no emojis, no symbols like & or @)
- Spell out numbers and abbreviations when they should be spoken (e.g., "sixty-five degrees" not "65")
- Use natural speech patterns with appropriate pauses (commas, periods)
- Keep responses concise: 1-3 sentences unless more detail is specifically requested
- Speak directly and conversationally, as if talking to a friend
- Respond ONLY in English unless the user explicitly asks for another language

=== TOOL USE INSTRUCTIONS ===

You have access to tools. For factual queries about:
- Weather, temperature, forecast -> use get_weather
- Current time, date, day -> use get_current_time
- Lists, shopping, calendar, tasks, schedule -> use list_views, then get_view_data
- Web content or URLs -> use fetch_url
- Current information, business hours, prices -> use web_search

Call the appropriate tool, then respond naturally with the data.

=== ${contentRating} RATING - CONTENT RESTRICTIONS ===
${ratingGuidelines}

Examples of what NOT to say:
- "*clears throat* Well, let me think..."
- "Here are **three** key points:"
- "The temperature is 65 degrees"

Examples of good responses:
- "That's a great question."
- "I'd be happy to help with that."`;
}

export async function POST(request: NextRequest) {
  // Check if client wants streaming (for tool status updates)
  const acceptsStream = request.headers.get("accept")?.includes("text/event-stream");

  // Parse request body
  let messages: ChatMessage[];
  let contentRating: ContentRating = "M";
  let clientLocation: ClientLocation | undefined;

  try {
    const body = await request.json();
    messages = body.messages;
    contentRating = body.contentRating || "M";
    clientLocation = body.clientLocation;
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!messages || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "No messages provided." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage.content || lastMessage.content.trim() === "") {
    return new Response(
      JSON.stringify({
        error: "No speech detected. Please try speaking louder or closer to the microphone.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // If streaming is requested, use SSE for real-time tool status
  if (acceptsStream) {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    // Process in the background and stream events
    (async () => {
      try {
        const result = await processChat(messages, contentRating, clientLocation, async (event) => {
          await writer.write(encoder.encode(encodeSSE(event)));
        });

        // Send final response
        await writer.write(encoder.encode(encodeSSE({
          type: "response",
          response: result.response,
          toolsUsed: result.toolsUsed,
        })));
      } catch (error) {
        console.error("Chat error:", error);
        await writer.write(encoder.encode(encodeSSE({
          type: "error",
          error: error instanceof Error ? error.message : "Failed to get response",
        })));
      } finally {
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // Non-streaming fallback (for backward compatibility)
  try {
    const result = await processChat(messages, contentRating, clientLocation);
    return new Response(
      JSON.stringify({
        response: result.response,
        toolsUsed: result.toolsUsed,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Chat error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to get response" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Process a chat request using the orchestrator-based approach:
 *
 * 1. Orchestrator analyzes the query and determines required tools
 * 2. Orchestrator executes tools directly (no LLM decision-making)
 * 3. Orchestrator handles tool chains automatically
 * 4. LLM is used ONLY for formatting the final response
 *
 * This eliminates the unreliable LLM tool selection problem.
 */
async function processChat(
  messages: ChatMessage[],
  contentRating: ContentRating,
  clientLocation?: ClientLocation,
  onToolEvent?: (event: StreamEvent) => Promise<void>
): Promise<{ response: string; toolsUsed?: string[] }> {
  const cerebras = new Cerebras({
    apiKey: process.env.CEREBRAS_API_KEY,
  });

  const lastMessage = messages[messages.length - 1];
  const userQuery = lastMessage.content;

  console.log(`[Chat API] Processing query: "${userQuery.substring(0, 100)}..."`);

  // ==========================================================================
  // STEP 1: Orchestrate tool execution
  // ==========================================================================

  const orchestrationResult = await orchestrateWithSpeculation(
    userQuery,
    messages as ConversationMessage[],
    {
      onToolEvent: onToolEvent
        ? async (event) => {
            if (event.type === "plan") {
              // Send plan info so UI can show total tools
              await onToolEvent({
                type: "plan_info",
                totalTools: event.totalTools || 0,
                tools: event.allTools || [],
              } as StreamEvent);
            } else {
              await onToolEvent({
                type: event.type === "start" ? "tool_start" : "tool_end",
                tool: event.tool,
                toolIndex: event.toolIndex,
                totalTools: event.totalTools,
              });
            }
          }
        : undefined,
      clientLocation,
      speculativeConfig: {
        enabled: true,
        confidenceThreshold: 0.9,
        maxSpeculativeWaitMs: 500,
      },
    }
  );

  // Emit speculative status for debugging/metrics
  if (onToolEvent && orchestrationResult.usedSpeculative !== undefined) {
    await onToolEvent({
      type: "speculative_status",
      usedSpeculative: orchestrationResult.usedSpeculative,
      latencySavedMs: orchestrationResult.latencySavedMs,
    });
  }

  console.log(`[Chat API] Orchestration result:`, {
    success: orchestrationResult.success,
    toolsExecuted: orchestrationResult.results.map(r => r.toolName),
    usedSpeculative: orchestrationResult.usedSpeculative,
    latencySavedMs: orchestrationResult.latencySavedMs,
  });

  // Collect tools used
  const toolsUsed = orchestrationResult.results.map(r => r.toolName);

  // ==========================================================================
  // STEP 2: Handle orchestration results
  // ==========================================================================

  // Case 1: Orchestration returned an error (missing params, tool failure, etc.)
  if (!orchestrationResult.success && orchestrationResult.error) {
    // If it's a user-friendly error (like asking for location), return it directly
    if (orchestrationResult.error.includes("?")) {
      return {
        response: orchestrationResult.error,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      };
    }

    // Otherwise, have the LLM format the error nicely (with streaming)
    const errorStream = await cerebras.chat.completions.create({
      model: "llama-3.1-8b", // Smaller, faster model for formatting
      messages: [
        {
          role: "system",
          content: getFormattingSystemPrompt(),
        },
        {
          role: "user",
          content: `The user asked: "${userQuery}"\n\nError: ${orchestrationResult.error}\n\nApologize briefly and explain the issue naturally for voice output.`,
        },
      ],
      max_tokens: 256,
      stream: true,
    });

    let errorText = "";
    for await (const chunk of errorStream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const token = (chunk as any).choices[0]?.delta?.content || "";
      if (token) {
        errorText += token;
        if (onToolEvent) {
          await onToolEvent({ type: "token", token });
        }
      }
    }
    errorText = errorText || orchestrationResult.error;
    errorText = errorText.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

    return {
      response: errorText,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
    };
  }

  // Case 2: Tools were executed successfully - format the results (with streaming)
  if (toolsUsed.length > 0) {
    const formattingContext = buildFormattingContext(orchestrationResult);

    console.log(`[Chat API] Formatting tool results for natural speech (streaming)`);

    const formattingStream = await cerebras.chat.completions.create({
      model: "llama-3.1-8b", // Smaller, faster model for formatting
      messages: [
        {
          role: "system",
          content: getFormattingSystemPrompt(),
        },
        {
          role: "user",
          content: `The user asked: "${userQuery}"\n\n${formattingContext}`,
        },
      ],
      max_tokens: 512,
      stream: true,
    });

    let responseText = "";
    for await (const chunk of formattingStream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const token = (chunk as any).choices[0]?.delta?.content || "";
      if (token) {
        responseText += token;
        if (onToolEvent) {
          await onToolEvent({ type: "token", token });
        }
      }
    }
    responseText = responseText.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

    return {
      response: responseText,
      toolsUsed,
    };
  }

  // ==========================================================================
  // STEP 3: Conversational fallback (no tools needed)
  // ==========================================================================

  console.log(`[Chat API] Using conversational mode (no tools required)`);

  // Build messages array with system prompt
  const systemPrompt = buildConversationalSystemPrompt(contentRating);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cerebrasMessages: any[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  // Convert tools to Cerebras format (still provide them for edge cases)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cerebrasTools: any[] = tools.map((t) => ({
    type: "function",
    function: t.function,
  }));

  // Track which tools were used in fallback
  const fallbackToolsUsed: string[] = [];

  // Initial API call with tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let response: any = await cerebras.chat.completions.create({
    model: "qwen-3-32b",
    messages: cerebrasMessages,
    tools: cerebrasTools,
    tool_choice: "auto",
    max_tokens: 1024,
  });

  // Handle tool use loop (max 5 iterations for safety)
  let iterations = 0;
  const maxIterations = 5;

  while (
    (response.choices[0]?.finish_reason === "tool_calls" ||
     response.choices[0]?.message?.tool_calls?.length > 0) &&
    iterations < maxIterations
  ) {
    iterations++;

    const assistantMessage = response.choices[0].message;
    const toolCalls = assistantMessage.tool_calls || [];

    // Add assistant message with tool calls
    cerebrasMessages.push({
      role: "assistant",
      content: assistantMessage.content || "",
      tool_calls: toolCalls,
    });

    // Execute tools in parallel for better performance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolExecutions = toolCalls.map(async (toolCall: any, index: number) => {
      const toolName = toolCall.function.name;
      const toolInput = JSON.parse(toolCall.function.arguments);

      console.log(`[Fallback] Executing tool: ${toolName}`, toolInput);

      // Emit tool start event
      if (onToolEvent) {
        await onToolEvent({
          type: "tool_start",
          tool: toolName,
          toolIndex: index + 1,
          totalTools: toolCalls.length,
        });
      }

      const result = await executeTool(toolName, toolInput);
      console.log(`[Fallback] Tool result:`, result);

      // Emit tool end event
      if (onToolEvent) {
        await onToolEvent({ type: "tool_end", tool: toolName });
      }

      return { toolCall, toolName, result };
    });

    // Execute all tools in parallel
    const executionResults = await Promise.all(toolExecutions);

    // Add results to messages in order (preserves message ordering for LLM context)
    for (const { toolCall, toolName, result } of executionResults) {
      fallbackToolsUsed.push(toolName);
      cerebrasMessages.push({
        role: "tool",
        content: result.success
          ? JSON.stringify(result.data)
          : `Error: ${result.error}`,
        tool_call_id: toolCall.id,
      });
    }

    // Get next response
    response = await cerebras.chat.completions.create({
      model: "qwen-3-32b",
      messages: cerebrasMessages,
      tools: cerebrasTools,
      tool_choice: "auto",
      max_tokens: 1024,
    });
  }

  // Extract final text response
  let responseText = response.choices[0]?.message?.content || "";

  // Strip <think>...</think> tags from Qwen models
  responseText = responseText.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

  return {
    response: responseText,
    toolsUsed: fallbackToolsUsed.length > 0 ? fallbackToolsUsed : undefined,
  };
}
