import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(request: NextRequest) {
  try {
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const { userMessage, assistantMessage } = await request.json();

    if (!userMessage) {
      return NextResponse.json(
        { error: "No message provided" },
        { status: 400 }
      );
    }

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 50,
      messages: [
        {
          role: "user",
          content: `Generate a very short title (2-4 words max) for a conversation that starts with:

User: "${userMessage}"
${assistantMessage ? `Assistant: "${assistantMessage}"` : ""}

Return ONLY the title, nothing else. No quotes, no punctuation at the end.`,
        },
      ],
      system: "You generate ultra-short conversation titles. Respond with only 2-4 words that capture the topic. No explanations, no quotes, no punctuation.",
    });

    const title = message.content[0].type === "text"
      ? message.content[0].text.trim()
      : "New conversation";

    return NextResponse.json({ title });
  } catch (error) {
    console.error("Title generation error:", error);
    return NextResponse.json(
      { error: "Failed to generate title" },
      { status: 500 }
    );
  }
}
