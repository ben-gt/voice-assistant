import { NextRequest, NextResponse } from "next/server";

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

TOOL USE - CRITICAL:
- You have access to weather, time, and Farmboard view tools
- ALWAYS call tools IMMEDIATELY - never ask clarifying questions before calling a tool
- NEVER say "let me check" or "one moment" without actually calling the tool in the same response
- For TIME: Call get_current_time with NO arguments - it automatically uses the user's local timezone. Do NOT ask which timezone they want.
- For WEATHER: Call get_weather with the location mentioned. If no location given, ask ONCE then call immediately.
- For views/dashboards: Call list_views first to get IDs, then get_view_data with the view_id (UUID)
- After tool returns results, speak the answer naturally - do not narrate what you're doing
- If a tool returns an error, briefly apologize and offer an alternative

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
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get current weather for a location",
            parameters: {
              type: "object",
              properties: {
                location: {
                  type: "string",
                  description: "City name (e.g., 'San Francisco', 'London')",
                },
                units: {
                  type: "string",
                  enum: ["celsius", "fahrenheit"],
                  description: "Temperature units",
                },
              },
              required: ["location"],
            },
          },
          {
            type: "function",
            name: "get_current_time",
            description: "Get current time. Defaults to user's local timezone if not specified.",
            parameters: {
              type: "object",
              properties: {
                timezone: {
                  type: "string",
                  description: "Optional IANA timezone (e.g., 'America/New_York'). If omitted, uses user's local timezone.",
                },
              },
              required: [],
            },
          },
          {
            type: "function",
            name: "list_views",
            description: "List all available Farmboard views/dashboards. Returns view names, IDs, and descriptions.",
            parameters: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            type: "function",
            name: "get_view_data",
            description: "Get data from a specific Farmboard view by its ID. Use list_views first to get available view IDs.",
            parameters: {
              type: "object",
              properties: {
                view_id: {
                  type: "string",
                  description: "The ID of the view to fetch data from",
                },
              },
              required: ["view_id"],
            },
          },
        ],
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
