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
- Avoid text formatting, bullet points, or markdown
- Respond ONLY in English unless the user explicitly asks for another language

TOOL USE:
- You have access to weather and time tools
- When asked about weather, use the get_weather tool to fetch current conditions
- When asked about time, use the get_current_time tool
- After using a tool, incorporate the results naturally into your spoken response
- If a tool fails, apologize briefly and suggest an alternative

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
            description: "Get current time for a timezone",
            parameters: {
              type: "object",
              properties: {
                timezone: {
                  type: "string",
                  description: "IANA timezone (e.g., 'America/New_York')",
                },
              },
              required: [],
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
