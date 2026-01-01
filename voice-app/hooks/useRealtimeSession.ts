"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { Message } from "@/types/conversation";

export type RealtimeStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "processing"
  | "tool_executing"
  | "error"
  | "timeout"; // New: explicit timeout state

interface UseRealtimeSessionOptions {
  onMessage?: (message: Message) => void;
  onError?: (error: string) => void;
  onStatusChange?: (status: RealtimeStatus) => void;
  onTimeout?: () => void; // New: callback when request times out
  contentRating?: string;
}

interface UseRealtimeSessionReturn {
  status: RealtimeStatus;
  currentTool: string | null;
  isConnected: boolean;
  error: string | null;
  failureCount: number; // New: track consecutive failures
  connect: () => Promise<void>;
  disconnect: () => void;
  interrupt: () => void;
  sendTextMessage: (text: string) => void;
  retry: () => void; // New: retry last message
}

// Timeout configuration (in ms)
const TIMEOUTS = {
  RESPONSE: 20000,      // 20s - max time waiting for any response
  TOOL_EXECUTION: 15000, // 15s - max time for a tool to execute
  CONNECTION: 10000,     // 10s - max time to establish connection
};

// Tool execution functions
async function executeWeatherTool(location: string, units?: string): Promise<string> {
  console.log(`[Weather Tool] Starting for location: ${location}, units: ${units}`);
  try {
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
    console.log(`[Weather Tool] Geocoding URL: ${geocodeUrl}`);

    const geocodeRes = await fetch(geocodeUrl);
    console.log(`[Weather Tool] Geocode response status: ${geocodeRes.status}`);

    if (!geocodeRes.ok) {
      const errorText = await geocodeRes.text();
      console.error(`[Weather Tool] Geocode API error: ${geocodeRes.status} - ${errorText}`);
      return JSON.stringify({ error: `Geocoding API error: ${geocodeRes.status}` });
    }

    const geocodeData = await geocodeRes.json();
    console.log(`[Weather Tool] Geocode data:`, geocodeData);

    if (!geocodeData.results || geocodeData.results.length === 0) {
      console.warn(`[Weather Tool] No results for location: ${location}`);
      return JSON.stringify({ error: `Could not find location: ${location}` });
    }

    const { latitude, longitude, name, country } = geocodeData.results[0];
    console.log(`[Weather Tool] Found: ${name}, ${country} at ${latitude}, ${longitude}`);

    const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=${temperatureUnit}`;
    console.log(`[Weather Tool] Weather URL: ${weatherUrl}`);

    const weatherRes = await fetch(weatherUrl);
    console.log(`[Weather Tool] Weather response status: ${weatherRes.status}`);

    if (!weatherRes.ok) {
      const errorText = await weatherRes.text();
      console.error(`[Weather Tool] Weather API error: ${weatherRes.status} - ${errorText}`);
      return JSON.stringify({ error: `Weather API error: ${weatherRes.status}` });
    }

    const weatherData = await weatherRes.json();
    console.log(`[Weather Tool] Weather data:`, weatherData);

    const current = weatherData.current;
    if (!current) {
      console.error(`[Weather Tool] No current weather data in response`);
      return JSON.stringify({ error: "No current weather data available" });
    }

    const descriptions: Record<number, string> = {
      0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
      45: "Foggy", 48: "Rime fog", 51: "Light drizzle", 53: "Moderate drizzle",
      55: "Dense drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
      71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 80: "Rain showers",
      95: "Thunderstorm", 96: "Thunderstorm with hail",
    };

    const result = {
      location: `${name}, ${country}`,
      temperature: current.temperature_2m,
      feels_like: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      wind_speed: current.wind_speed_10m,
      conditions: descriptions[current.weather_code] || "Unknown",
      units: temperatureUnit,
    };
    console.log(`[Weather Tool] Success:`, result);
    return JSON.stringify(result);
  } catch (error) {
    console.error("[Weather Tool] Exception:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return JSON.stringify({ error: `Failed to fetch weather: ${errorMessage}` });
  }
}

async function executeTimeTool(timezone?: string): Promise<string> {
  try {
    // Default to user's local timezone if not specified
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return JSON.stringify({ error: `Invalid timezone: ${tz}` });
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
    return JSON.stringify({ error: "Failed to get current time" });
  }
}

async function executeListViewsTool(): Promise<string> {
  try {
    // Use local proxy to avoid CORS issues
    const response = await fetch("/api/farmboard/views");
    if (!response.ok) {
      return JSON.stringify({ error: `Failed to fetch views: ${response.status}` });
    }
    const data = await response.json();

    // Extract just the essential info for voice output
    if (Array.isArray(data)) {
      const views = data.map((view: { id: string; name: string; description?: string }) => ({
        id: view.id,
        name: view.name,
        description: view.description || null,
      }));
      return JSON.stringify({ views, count: views.length });
    }

    return JSON.stringify(data);
  } catch (error) {
    console.error("List views tool error:", error);
    return JSON.stringify({ error: "Failed to fetch views" });
  }
}

async function executeGetViewDataTool(viewId: string): Promise<string> {
  try {
    // Use local proxy to avoid CORS issues
    const response = await fetch(`/api/farmboard/view/${viewId}`);
    if (!response.ok) {
      return JSON.stringify({ error: `Failed to fetch view data: ${response.status}` });
    }
    const data = await response.json();

    // Summarize the data for voice output
    if (data && typeof data === "object") {
      const summary: Record<string, unknown> = {};

      // Include view metadata if present
      if (data.name) summary.name = data.name;
      if (data.description) summary.description = data.description;

      // Return all items from the view
      if (Array.isArray(data.data)) {
        summary.rowCount = data.data.length;
        summary.columns = data.data[0] ? Object.keys(data.data[0]) : [];
        summary.items = data.data;
      } else if (Array.isArray(data)) {
        summary.rowCount = data.length;
        summary.columns = data[0] ? Object.keys(data[0]) : [];
        summary.items = data;
      } else {
        summary.data = data;
      }

      return JSON.stringify(summary);
    }

    return JSON.stringify(data);
  } catch (error) {
    console.error("Get view data tool error:", error);
    return JSON.stringify({ error: "Failed to fetch view data" });
  }
}

export function useRealtimeSession(
  options: UseRealtimeSessionOptions = {}
): UseRealtimeSessionReturn {
  const { onMessage, onError, onStatusChange, onTimeout, contentRating = "M" } = options;

  const [status, setStatus] = useState<RealtimeStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [failureCount, setFailureCount] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processedItemsRef = useRef<Set<string>>(new Set());
  const currentResponseToolsRef = useRef<string[]>([]);

  // Queue for pending tool results - wait for response.done before sending
  const pendingToolResultsRef = useRef<Array<{ call_id: string; result: string }>>([]);
  const responseInProgressRef = useRef<boolean>(false);

  // Track current response for transcript accumulation
  const currentResponseItemIdRef = useRef<string | null>(null);
  const currentTranscriptRef = useRef<string>("");

  // Timeout handling
  const responseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const toolTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastMessageRef = useRef<string | null>(null);

  // Use refs to store the latest callbacks to avoid stale closures
  const onMessageRef = useRef(onMessage);
  const onErrorRef = useRef(onError);
  const onStatusChangeRef = useRef(onStatusChange);
  const onTimeoutRef = useRef(onTimeout);

  // Keep refs updated with latest callbacks
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  // Clear all timeouts
  const clearTimeouts = useCallback(() => {
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current);
      responseTimeoutRef.current = null;
    }
    if (toolTimeoutRef.current) {
      clearTimeout(toolTimeoutRef.current);
      toolTimeoutRef.current = null;
    }
  }, []);

  // Handle timeout - called when we've been waiting too long
  const handleTimeout = useCallback((reason: string) => {
    console.error(`[Realtime] Timeout: ${reason}`);
    clearTimeouts();
    setFailureCount(prev => prev + 1);
    setError(`Request timed out: ${reason}`);
    setStatus("timeout");
    setCurrentTool(null);
    responseInProgressRef.current = false;
    pendingToolResultsRef.current = [];
    onTimeoutRef.current?.();
    onErrorRef.current?.(`Request timed out: ${reason}`);
  }, [clearTimeouts]);

  // Start response timeout - expecting a response within TIMEOUTS.RESPONSE
  const startResponseTimeout = useCallback(() => {
    clearTimeouts();
    responseTimeoutRef.current = setTimeout(() => {
      handleTimeout("No response received");
    }, TIMEOUTS.RESPONSE);
  }, [clearTimeouts, handleTimeout]);

  // Start tool timeout - tool should complete within TIMEOUTS.TOOL_EXECUTION
  const startToolTimeout = useCallback(() => {
    if (toolTimeoutRef.current) clearTimeout(toolTimeoutRef.current);
    toolTimeoutRef.current = setTimeout(() => {
      handleTimeout("Tool execution took too long");
    }, TIMEOUTS.TOOL_EXECUTION);
  }, [handleTimeout]);

  const updateStatus = useCallback(
    (newStatus: RealtimeStatus) => {
      setStatus(newStatus);
      onStatusChangeRef.current?.(newStatus);

      // Clear timeouts when we reach a stable state
      if (newStatus === "listening" || newStatus === "speaking") {
        clearTimeouts();
        // Reset failure count on successful response
        if (newStatus === "speaking") {
          setFailureCount(0);
        }
      }
    },
    [clearTimeouts]
  );

  // Helper to send pending tool results and trigger response
  const sendPendingToolResults = useCallback(() => {
    if (pendingToolResultsRef.current.length === 0) return;
    if (dcRef.current?.readyState !== "open") {
      console.error("[Realtime] Cannot send tool results - data channel not open");
      return;
    }

    console.log(`[Realtime] Sending ${pendingToolResultsRef.current.length} pending tool result(s)`);

    for (const { call_id, result } of pendingToolResultsRef.current) {
      console.log(`[Realtime] Sending tool result for call_id: ${call_id}`);
      dcRef.current.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id,
          output: result,
        },
      }));
    }

    // Clear pending results
    pendingToolResultsRef.current = [];

    // Trigger response generation for the tool results
    dcRef.current.send(JSON.stringify({
      type: "response.create",
    }));
    console.log("[Realtime] Response creation triggered for tool results");
  }, []);

  // Handle incoming data channel messages
  const handleDataChannelMessage = useCallback(
    async (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log("[Realtime] Event:", data.type, data);

        switch (data.type) {
          case "session.created":
          case "session.updated":
            updateStatus("listening");
            break;

          case "input_audio_buffer.speech_started":
            updateStatus("listening");
            break;

          case "input_audio_buffer.speech_stopped":
          case "input_audio_buffer.committed":
            updateStatus("processing");
            break;

          case "response.created":
            responseInProgressRef.current = true;
            updateStatus("processing");
            break;

          case "response.output_item.added":
            updateStatus("processing");
            break;

          case "response.audio.delta":
            updateStatus("speaking");
            break;

          case "response.audio_transcript.delta":
            updateStatus("speaking");
            // Accumulate transcript
            if (data.delta) {
              currentTranscriptRef.current += data.delta;
            }
            break;

          case "response.output_item.done": {
            // When an output item is complete, emit the message with full transcript
            const item = data.item;
            if (item && item.type === "message" && item.role === "assistant") {
              const itemId = item.id || `assistant-${Date.now()}`;
              if (!processedItemsRef.current.has(itemId)) {
                processedItemsRef.current.add(itemId);

                // Get transcript from the accumulated ref or from item content
                let content = currentTranscriptRef.current;
                if (!content && Array.isArray(item.content)) {
                  content = item.content
                    .map((c: { text?: string; transcript?: string }) => c.transcript || c.text || "")
                    .join("");
                }

                if (content) {
                  const message: Message = {
                    id: itemId,
                    role: "assistant",
                    content,
                    timestamp: Date.now(),
                    toolsUsed: currentResponseToolsRef.current.length > 0
                      ? [...currentResponseToolsRef.current]
                      : undefined,
                  };
                  onMessageRef.current?.(message);
                  currentResponseToolsRef.current = [];
                }
                currentTranscriptRef.current = "";
              }
            }
            break;
          }

          case "conversation.item.input_audio_transcription.completed": {
            // User's speech has been transcribed
            const { item_id, transcript } = data;
            if (transcript && item_id && !processedItemsRef.current.has(item_id)) {
              processedItemsRef.current.add(item_id);
              const message: Message = {
                id: item_id,
                role: "user",
                content: transcript,
                timestamp: Date.now(),
              };
              onMessageRef.current?.(message);
            }
            break;
          }

          case "response.done":
            responseInProgressRef.current = false;
            console.log("[Realtime] Response done, checking for pending tool results");
            // If there are pending tool results, send them now
            if (pendingToolResultsRef.current.length > 0) {
              sendPendingToolResults();
            } else {
              updateStatus("listening");
            }
            break;

          case "conversation.item.created": {
            const item = data.item;
            if (item && item.id && !processedItemsRef.current.has(item.id)) {
              processedItemsRef.current.add(item.id);

              if (item.type === "message" && item.role) {
                let content = "";
                if (Array.isArray(item.content)) {
                  content = item.content
                    .map((c: { text?: string; transcript?: string }) => c.text || c.transcript || "")
                    .join("");
                }

                if (content && (item.role === "user" || item.role === "assistant")) {
                  const message: Message = {
                    id: item.id,
                    role: item.role,
                    content,
                    timestamp: Date.now(),
                    // Attach tools used for assistant messages
                    toolsUsed: item.role === "assistant" && currentResponseToolsRef.current.length > 0
                      ? [...currentResponseToolsRef.current]
                      : undefined,
                  };
                  onMessageRef.current?.(message);

                  // Reset tools tracking after assistant message
                  if (item.role === "assistant") {
                    currentResponseToolsRef.current = [];
                  }
                }
              }
            }
            break;
          }

          case "response.function_call_arguments.done": {
            // Handle tool calls
            const { call_id, name, arguments: argsJson } = data;
            console.log(`[Realtime] Tool call: ${name}`, { call_id, arguments: argsJson });

            // Track which tool is executing for UI feedback
            setCurrentTool(name);
            updateStatus("tool_executing");
            currentResponseToolsRef.current.push(name);

            // Start tool timeout - if tool takes too long, we'll know
            startToolTimeout();

            let result: string;

            try {
              const args = JSON.parse(argsJson);
              console.log(`[Realtime] Parsed args:`, args);

              if (name === "get_weather") {
                result = await executeWeatherTool(args.location, args.units);
              } else if (name === "get_current_time") {
                result = await executeTimeTool(args.timezone);
              } else if (name === "list_views") {
                result = await executeListViewsTool();
              } else if (name === "get_view_data") {
                console.log(`[Realtime] Calling get_view_data with view_id:`, args.view_id);
                result = await executeGetViewDataTool(args.view_id);
              } else {
                result = JSON.stringify({ error: `Unknown tool: ${name}` });
              }
              console.log(`[Realtime] Tool result:`, result);
            } catch (e) {
              console.error(`[Realtime] Tool execution error:`, e);
              result = JSON.stringify({ error: "Failed to execute tool" });
            }

            // Tool completed - clear timeout and tool state
            clearTimeouts();
            setCurrentTool(null);

            // Queue the tool result - it will be sent when response.done is received
            // This ensures we don't interrupt the model while it's still speaking
            console.log(`[Realtime] Queueing tool result for call_id: ${call_id}`);
            console.log(`[Realtime] Tool result content:`, result);
            pendingToolResultsRef.current.push({ call_id, result });

            // If no response is in progress, send immediately
            // (this handles the case where the model calls the tool without speaking first)
            if (!responseInProgressRef.current) {
              console.log("[Realtime] No response in progress, sending tool result immediately");
              sendPendingToolResults();
            } else {
              console.log("[Realtime] Response in progress, tool result queued for after response.done");
              updateStatus("processing");
            }
            break;
          }

          case "error": {
            // OpenAI Realtime API error format can vary
            const errorMessage =
              data.error?.message ||
              data.message ||
              (typeof data.error === "string" ? data.error : null) ||
              "Realtime API error";
            const errorCode = data.error?.code || data.code || "unknown";
            console.error("[Realtime] Error:", { message: errorMessage, code: errorCode, raw: data });
            setError(errorMessage);
            onErrorRef.current?.(errorMessage);
            break;
          }
        }
      } catch (e) {
        console.error("[Realtime] Failed to parse message:", e);
      }
    },
    [updateStatus, sendPendingToolResults, startToolTimeout, clearTimeouts]
  );

  const connect = useCallback(async () => {
    if (pcRef.current) {
      console.warn("Connection already exists");
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

      // Get user media (microphone)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Create peer connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // Add audio track
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Handle incoming audio
      pc.ontrack = (event) => {
        const audio = new Audio();
        audio.srcObject = event.streams[0];
        audio.autoplay = true;
      };

      // Create data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        console.log("[Realtime] Data channel opened");
        updateStatus("connected");

        // Send session.update to configure tools
        // This ensures tools are available even if the token creation didn't fully apply them
        dc.send(JSON.stringify({
          type: "session.update",
          session: {
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
                      description: "City name (e.g., 'San Francisco', 'London', 'Sydney')",
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
                description: "List all available views including Shopping List, Calendar, Tasks, and other dashboards. Call this when user asks about any list, schedule, tasks, or dashboard. Returns view names and IDs.",
                parameters: {
                  type: "object",
                  properties: {},
                  required: [],
                },
              },
              {
                type: "function",
                name: "get_view_data",
                description: "Get the actual data/items from a view. Call this after list_views to get contents of Shopping List, Calendar events, Tasks, etc.",
                parameters: {
                  type: "object",
                  properties: {
                    view_id: {
                      type: "string",
                      description: "The UUID of the view (get this from list_views)",
                    },
                  },
                  required: ["view_id"],
                },
              },
            ],
            tool_choice: "required",
          },
        }));
        console.log("[Realtime] Sent session.update with tools");

        setTimeout(() => updateStatus("listening"), 500);
      };

      dc.onclose = () => {
        console.log("[Realtime] Data channel closed");
        updateStatus("disconnected");
      };

      dc.onerror = (e) => {
        console.error("[Realtime] Data channel error:", e);
      };

      dc.onmessage = handleDataChannelMessage;

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") {
          resolve();
        } else {
          const checkState = () => {
            if (pc.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", checkState);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", checkState);
          // Timeout after 5 seconds
          setTimeout(resolve, 5000);
        }
      });

      // Send offer to OpenAI
      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";

      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: pc.localDescription?.sdp,
      });

      if (!sdpResponse.ok) {
        const errorText = await sdpResponse.text();
        throw new Error(`SDP exchange failed: ${sdpResponse.status} - ${errorText}`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      console.log("[Realtime] WebRTC connection established");
    } catch (err) {
      console.error("Failed to connect:", err);
      const errorMessage = err instanceof Error ? err.message : "Connection failed";
      setError(errorMessage);
      onErrorRef.current?.(errorMessage);
      updateStatus("error");

      // Cleanup on error
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      dcRef.current = null;
    }
  }, [contentRating, handleDataChannelMessage, onError, updateStatus]);

  const disconnect = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    processedItemsRef.current.clear();
    updateStatus("disconnected");
    setError(null);
  }, [updateStatus]);

  const interrupt = useCallback(() => {
    if (dcRef.current?.readyState === "open" && status === "speaking") {
      dcRef.current.send(JSON.stringify({
        type: "response.cancel",
      }));
    }
  }, [status]);

  const sendTextMessage = useCallback((text: string) => {
    if (dcRef.current?.readyState === "open" && text.trim()) {
      console.log("[Realtime] Sending text message:", text);

      // Store for retry
      lastMessageRef.current = text.trim();

      // Clear any previous error state
      setError(null);

      // Create a conversation item with the user's text
      dcRef.current.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: text.trim(),
            },
          ],
        },
      }));
      // Trigger a response
      dcRef.current.send(JSON.stringify({
        type: "response.create",
      }));
      updateStatus("processing");

      // Start timeout - if we don't get a response, we'll know
      startResponseTimeout();
    }
  }, [updateStatus, startResponseTimeout]);

  // Retry the last message
  const retry = useCallback(() => {
    if (lastMessageRef.current && dcRef.current?.readyState === "open") {
      console.log("[Realtime] Retrying last message:", lastMessageRef.current);
      setError(null);
      setStatus("processing");
      sendTextMessage(lastMessageRef.current);
    } else if (lastMessageRef.current) {
      // Connection might be dead, surface this to user
      setError("Cannot retry - connection lost. Please reconnect.");
    }
  }, [sendTextMessage]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeouts();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (pcRef.current) {
        pcRef.current.close();
      }
    };
  }, [clearTimeouts]);

  return {
    status,
    currentTool,
    isConnected: status !== "disconnected" && status !== "error" && status !== "timeout",
    error,
    failureCount,
    connect,
    disconnect,
    interrupt,
    sendTextMessage,
    retry,
  };
}
