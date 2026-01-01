import { NextRequest, NextResponse } from "next/server";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { tools, executeTool } from "../tools";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type ContentRating = "G" | "PG" | "M" | "MA" | "R";

const RATING_GUIDELINES: Record<ContentRating, string> = {
  G: `CONTENT GUIDELINES (G - General):
- Content must be suitable for all ages, including young children
- Use simple, clear language appropriate for children
- Avoid any violence, scary themes, or mature concepts
- No references to alcohol, drugs, or adult relationships
- Keep topics educational, playful, and family-friendly
- If asked about inappropriate topics, gently redirect to age-appropriate alternatives`,

  PG: `CONTENT GUIDELINES (PG - Parental Guidance):
- Content suitable for most audiences with parental guidance for younger children
- Mild themes are acceptable but avoid anything frightening or distressing
- No explicit violence, only mild cartoon-style conflict if needed
- Avoid detailed discussion of mature themes
- References to romance should be innocent and age-appropriate
- If asked about mature topics, provide basic, non-detailed responses`,

  M: `CONTENT GUIDELINES (M - Mature):
- Content recommended for ages 15 and over
- Moderate themes and discussions are acceptable
- Can discuss complex topics including mild violence in historical or educational contexts
- Romantic themes can be discussed tastefully without explicit content
- Can reference but not glorify alcohol or mild drug references
- Provide balanced, thoughtful responses to sensitive topics`,

  MA: `CONTENT GUIDELINES (MA15+ - Mature Accompanied):
- Content suitable for ages 15 and over
- Can discuss strong themes including violence in appropriate contexts
- More detailed discussion of mature topics is acceptable
- Can engage with darker or more complex subject matter
- Still avoid gratuitously explicit content
- Provide nuanced responses to difficult questions`,

  R: `CONTENT GUIDELINES (R18+ - Restricted):
- Content for adults only
- Can engage with mature themes openly and directly
- Frank discussion of adult topics is acceptable
- Can discuss violence, substances, and relationships honestly
- Still maintain respect and avoid harmful content
- Provide straightforward, uncensored responses where appropriate`,
};

function buildSystemPrompt(contentRating: ContentRating): string {
  const ratingGuidelines = RATING_GUIDELINES[contentRating] || RATING_GUIDELINES.M;

  return `You are a helpful voice assistant having a natural spoken conversation.

CRITICAL OUTPUT RULES:
- Your response will be sent directly to a text-to-speech service and played as audio
- NEVER use <think> tags or any internal reasoning - just respond directly
- NEVER use text annotations like *clears throat*, *laughs*, *sighs*, or any asterisk-enclosed actions
- NEVER use markdown formatting (no **, no #, no bullet points, no numbered lists)
- NEVER use special characters that don't pronounce naturally (no emojis, no symbols like & or @)
- Spell out numbers and abbreviations when they should be spoken (e.g., "sixty-five degrees" not "65°", "two thousand twenty-five" not "2025")
- Use natural speech patterns with appropriate pauses (commas, periods)
- Keep responses concise: 1-3 sentences unless more detail is specifically requested
- Speak directly and conversationally, as if talking to a friend
- Respond ONLY in English unless the user explicitly asks for another language

TOOL USE:
- You have access to tools for getting weather and time information
- When asked about weather, use the get_weather tool to fetch current conditions
- When asked about time, use the get_current_time tool
- After using a tool, incorporate the results naturally into your spoken response
- If a tool fails, apologize briefly and suggest an alternative

Example tool response formats:
- "It's currently sixty-five degrees and partly cloudy in San Francisco, with a feels-like temperature of sixty-two degrees."
- "The time in New York is three forty-five PM on Tuesday, December thirty-first."

=== ${contentRating} RATING - CONTENT RESTRICTIONS ===
${ratingGuidelines}

You MUST follow the content rating above. Adjust your responses accordingly.

Examples of what NOT to say:
- "*clears throat* Well, let me think..."
- "Here are **three** key points:"
- "The temperature is 65°F"

Examples of good responses:
- "That's a great question. The answer is actually simpler than you might think."
- "I'd be happy to help with that. Let me explain."`;
}

export async function POST(request: NextRequest) {
  try {
    const cerebras = new Cerebras({
      apiKey: process.env.CEREBRAS_API_KEY,
    });

    const { messages, contentRating = "M" } = await request.json() as {
      messages: ChatMessage[];
      contentRating?: ContentRating;
    };

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: "No messages provided." },
        { status: 400 }
      );
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage.content || lastMessage.content.trim() === "") {
      return NextResponse.json(
        {
          error:
            "No speech detected. Please try speaking louder or closer to the microphone.",
        },
        { status: 400 }
      );
    }

    console.log(`[Chat API] Using content rating: ${contentRating}`);
    const systemPrompt = buildSystemPrompt(contentRating);

    // Build messages array with system prompt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cerebrasMessages: any[] = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    // Convert tools to Cerebras format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cerebrasTools: any[] = tools.map((t) => ({
      type: "function",
      function: t.function,
    }));

    // Track which tools were used
    const toolsUsed: string[] = [];

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
      response.choices[0]?.finish_reason === "tool_calls" &&
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

      // Execute each tool and add results
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const toolInput = JSON.parse(toolCall.function.arguments);

        console.log(`Executing tool: ${toolName}`, toolInput);
        toolsUsed.push(toolName);

        const result = await executeTool(toolName, toolInput);
        console.log(`Tool result:`, result);

        // Add tool result message
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

    return NextResponse.json({
      response: responseText,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
    });
  } catch (error) {
    console.error("Chat error:", error);
    return NextResponse.json(
      { error: "Failed to get response" },
      { status: 500 }
    );
  }
}
