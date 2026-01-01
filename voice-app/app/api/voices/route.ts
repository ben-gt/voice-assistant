import { NextResponse } from "next/server";

export async function GET() {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY || "",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Eleven Labs voices error:", errorText);
      return NextResponse.json(
        { error: "Failed to fetch voices" },
        { status: 500 }
      );
    }

    const data = await response.json();

    // Return only the voices the user owns or has access to
    const voices = data.voices.map((voice: { voice_id: string; name: string; category: string }) => ({
      id: voice.voice_id,
      name: voice.name,
      category: voice.category,
    }));

    return NextResponse.json({ voices });
  } catch (error) {
    console.error("Voices error:", error);
    return NextResponse.json(
      { error: "Failed to fetch voices" },
      { status: 500 }
    );
  }
}
