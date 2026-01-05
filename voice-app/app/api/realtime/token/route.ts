import { NextRequest, NextResponse } from "next/server";
import { getAllToolsForRealtimeApi } from "@/lib/tools";

type ContentRating = "G" | "PG" | "M" | "MA" | "R";

const RATING_GUIDELINES: Record<ContentRating, string> = {
  G: `Content must be suitable for all ages, including young children.
Use simple, clear language appropriate for children.
Avoid any violence, scary themes, or mature concepts.
No references to alcohol, drugs, or adult relationships.
Keep topics educational, playful, and family-friendly.`,

  PG: `Content suitable for most audiences with parental guidance for younger children.
Mild themes are acceptable but avoid anything frightening or distressing.
No explicit violence, only mild cartoon-style conflict if needed.
Avoid detailed discussion of mature themes.`,

  M: `Content recommended for ages 15 and over.
Moderate themes and discussions are acceptable.
Can discuss complex topics including mild violence in historical or educational contexts.
Romantic themes can be discussed tastefully without explicit content.`,

  MA: `Content suitable for ages 15 and over.
Can discuss strong themes including violence in appropriate contexts.
More detailed discussion of mature topics is acceptable.
Can engage with darker or more complex subject matter.`,

  R: `Content for adults only.
Can engage with mature themes openly and directly.
Frank discussion of adult topics is acceptable.
Can discuss violence, substances, and relationships honestly.`,
};

function buildRealtimeInstructions(contentRating: ContentRating): string {
  const ratingGuidelines = RATING_GUIDELINES[contentRating] || RATING_GUIDELINES.M;

  return `You are a helpful voice assistant having a natural spoken conversation.

VOICE OUTPUT RULES:
- Speak naturally and conversationally, as if talking to a friend
- Keep responses concise: 1-3 sentences unless more detail is specifically requested
- Use natural speech patterns with appropriate pauses
- Spell out numbers naturally (say "sixty-five degrees" not "65 degrees")
- NEVER use markdown formatting like **bold**, *italic*, bullet points (-), or numbered lists
- NEVER use special characters or symbols - spell everything out for speech
- Respond ONLY in English unless the user explicitly asks for another language

=== MANDATORY TOOL USE - YOU MUST FOLLOW THESE RULES ===

ABSOLUTE REQUIREMENT: You MUST use tools for ANY query about factual, real-time, or current information.
DO NOT EVER respond with factual information without first calling the appropriate tool.
Your training data is OUTDATED - you do NOT know the current date, time, weather, or any current facts.

TRIGGER WORDS -> REQUIRED TOOLS:
- "what time" / "what's the time" / "current time" / "time now" -> MUST call get_current_time
- "what day" / "what date" / "today" / "what's today" / "current date" -> MUST call get_current_time
- "weather" / "temperature" / "forecast" / "how hot" / "how cold" / "raining" -> MUST call get_weather
- "shopping list" / "calendar" / "tasks" / "schedule" / "events" -> MUST call list_views then get_view_data
- URL or website content -> MUST call fetch_url
- "search" / "look up" / "find" / opening hours / prices / news / current events -> MUST call web_search

CRITICAL - TIME AND DATE QUERIES:
- You DO NOT know what day it is. You MUST call get_current_time.
- You DO NOT know the current date. You MUST call get_current_time.
- You DO NOT know the current time. You MUST call get_current_time.
- If the user mentions ANY location in this conversation, use that location's timezone.
- Pass the timezone or location parameter based on conversation context.
NEVER HALLUCINATE DATES OR TIMES. If you respond with a date without calling get_current_time, you are WRONG.

TOOL EXECUTION RULES:
- Call the tool FIRST, then respond with the data
- NEVER say "let me check" or "one moment" - just call the tool
- NEVER claim you searched or found information without actually calling a tool
- After the tool returns data, speak the results naturally
- If a tool fails, briefly apologize and say you couldn't find the information

IMPORTANT: For business hours, prices, current events, or any real-time info, you MUST call web_search. Your knowledge may be outdated.

CONTENT RATING: ${contentRating}
${ratingGuidelines}

You MUST follow the content rating above. Adjust your responses accordingly.`;
}

export async function POST(request: NextRequest) {
  try {
    const { contentRating = "M" } = (await request.json()) as {
      contentRating?: ContentRating;
    };

    const instructions = buildRealtimeInstructions(contentRating);

    // Get tools from centralized registry in Realtime API format
    const tools = getAllToolsForRealtimeApi();

    // Create ephemeral token via OpenAI REST API
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        modalities: ["audio", "text"],
        instructions,
        voice: "alloy",
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        tools,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error("OpenAI Realtime session error:", error);
      return NextResponse.json(
        { error: "Failed to create realtime session" },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Return the ephemeral token and session info
    return NextResponse.json({
      clientSecret: data.client_secret?.value || data.client_secret,
      sessionId: data.id,
      expiresAt: data.expires_at,
    });
  } catch (error) {
    console.error("Realtime token error:", error);
    return NextResponse.json(
      { error: "Failed to generate realtime token" },
      { status: 500 }
    );
  }
}
