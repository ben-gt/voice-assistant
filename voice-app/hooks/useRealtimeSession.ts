"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import type { Message } from "@/types/conversation";

export type RealtimeStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "processing"
  | "error";

interface UseRealtimeSessionOptions {
  onMessage?: (message: Message) => void;
  onError?: (error: string) => void;
  onStatusChange?: (status: RealtimeStatus) => void;
  contentRating?: string;
}

interface UseRealtimeSessionReturn {
  status: RealtimeStatus;
  isConnected: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  interrupt: () => void;
}

// Weather tool - uses Open-Meteo (free, no API key)
const weatherTool = tool({
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: z.object({
    location: z.string().describe("City name (e.g., 'San Francisco', 'London')"),
    units: z.enum(["celsius", "fahrenheit"]).nullable().optional().describe("Temperature units"),
  }),
  execute: async ({ location, units }) => {
    try {
      // Geocode the location
      const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
      const geocodeRes = await fetch(geocodeUrl);
      const geocodeData = await geocodeRes.json();

      if (!geocodeData.results || geocodeData.results.length === 0) {
        return `Could not find location: ${location}`;
      }

      const { latitude, longitude, name, country } = geocodeData.results[0];

      // Fetch weather
      const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=${temperatureUnit}`;
      const weatherRes = await fetch(weatherUrl);
      const weatherData = await weatherRes.json();

      const current = weatherData.current;
      const descriptions: Record<number, string> = {
        0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Foggy", 48: "Rime fog", 51: "Light drizzle", 53: "Moderate drizzle",
        55: "Dense drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
        71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 80: "Rain showers",
        95: "Thunderstorm", 96: "Thunderstorm with hail",
      };
      const conditions = descriptions[current.weather_code] || "Unknown";

      return JSON.stringify({
        location: `${name}, ${country}`,
        temperature: current.temperature_2m,
        feels_like: current.apparent_temperature,
        humidity: current.relative_humidity_2m,
        wind_speed: current.wind_speed_10m,
        conditions,
        units: temperatureUnit,
      });
    } catch (error) {
      console.error("Weather tool error:", error);
      return "Failed to fetch weather data";
    }
  },
});

// Time tool - uses Intl API (works in browser)
const timeTool = tool({
  name: "get_current_time",
  description: "Get current time for a timezone",
  parameters: z.object({
    timezone: z.string().nullable().optional().describe("IANA timezone (e.g., 'America/New_York')"),
  }),
  execute: async ({ timezone }) => {
    try {
      const tz = timezone || "UTC";

      // Validate timezone
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        return `Invalid timezone: ${tz}. Please use IANA timezone format.`;
      }

      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      return JSON.stringify({
        timezone: tz,
        formatted: formatter.format(now),
        iso: now.toISOString(),
      });
    } catch (error) {
      console.error("Time tool error:", error);
      return "Failed to get current time";
    }
  },
});

export function useRealtimeSession(
  options: UseRealtimeSessionOptions = {}
): UseRealtimeSessionReturn {
  const { onMessage, onError, onStatusChange, contentRating = "M" } = options;

  const [status, setStatus] = useState<RealtimeStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const processedItemsRef = useRef<Set<string>>(new Set());

  const updateStatus = useCallback(
    (newStatus: RealtimeStatus) => {
      setStatus(newStatus);
      onStatusChange?.(newStatus);
    },
    [onStatusChange]
  );

  const connect = useCallback(async () => {
    if (sessionRef.current) {
      console.warn("Session already exists");
      return;
    }

    try {
      updateStatus("connecting");
      setError(null);

      // Get ephemeral token from server
      const tokenResponse = await fetch("/api/realtime/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentRating }),
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json();
        throw new Error(errorData.error || "Failed to get realtime token");
      }

      const { clientSecret } = await tokenResponse.json();

      // Create the Realtime Agent with tools
      const agent = new RealtimeAgent({
        name: "VoiceAssistant",
        instructions: "You are a helpful voice assistant.",
        tools: [weatherTool, timeTool],
      });

      // Create the session
      const session = new RealtimeSession(agent, {
        model: "gpt-4o-realtime-preview",
      });
      sessionRef.current = session;

      // Set up event handlers
      session.on("audio_interrupted", () => {
        updateStatus("listening");
      });

      session.on("history_updated", (history) => {
        // Process new items in history
        for (const item of history) {
          // Skip if we've already processed this item
          if (item.itemId && processedItemsRef.current.has(item.itemId)) {
            continue;
          }

          // Mark as processed
          if (item.itemId) {
            processedItemsRef.current.add(item.itemId);
          }

          // Extract messages from history items
          if (item.type === "message" && item.role && item.content) {
            const content = Array.isArray(item.content)
              ? item.content
                  .map((c: { text?: string; transcript?: string }) => c.text || c.transcript || "")
                  .join("")
              : typeof item.content === "string"
              ? item.content
              : "";

            if (content && (item.role === "user" || item.role === "assistant")) {
              const message: Message = {
                id: item.itemId || crypto.randomUUID(),
                role: item.role as "user" | "assistant",
                content,
                timestamp: Date.now(),
              };
              onMessage?.(message);
            }
          }
        }
      });

      session.on("error", (err) => {
        console.error("Realtime session error:", err);
        const errorMessage =
          err instanceof Error ? err.message : "Connection error";
        setError(errorMessage);
        onError?.(errorMessage);
        updateStatus("error");
      });

      // Connect using ephemeral token
      await session.connect({ apiKey: clientSecret });

      updateStatus("connected");

      // After connection, switch to listening state
      setTimeout(() => {
        if (sessionRef.current) {
          updateStatus("listening");
        }
      }, 500);
    } catch (err) {
      console.error("Failed to connect:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Connection failed";
      setError(errorMessage);
      onError?.(errorMessage);
      updateStatus("error");
    }
  }, [contentRating, onMessage, onError, updateStatus]);

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    processedItemsRef.current.clear();
    updateStatus("disconnected");
    setError(null);
  }, [updateStatus]);

  const interrupt = useCallback(() => {
    if (sessionRef.current && status === "speaking") {
      sessionRef.current.interrupt();
    }
  }, [status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        sessionRef.current.close();
        sessionRef.current = null;
      }
    };
  }, []);

  return {
    status,
    isConnected: status !== "disconnected" && status !== "error",
    error,
    connect,
    disconnect,
    interrupt,
  };
}
