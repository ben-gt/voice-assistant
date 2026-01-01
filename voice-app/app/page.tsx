"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSileroVAD, VADState } from "@/hooks/useSileroVAD";
import { useInterruptionDetector } from "@/hooks/useInterruptionDetector";
import { useConversations } from "@/hooks/useConversations";
import { useRealtimeSession, RealtimeStatus } from "@/hooks/useRealtimeSession";
import { ConversationBubbles } from "@/components/ConversationBubbles";
import type { Message } from "@/types/conversation";

type Status = "idle" | "listening" | "speaking" | "processing" | "playing";

const VOICE_STORAGE_KEY = "voice-assistant-selected-voice";
const AUDIO_RESPONSE_KEY = "voice-assistant-audio-response";
const AUTO_INTERRUPT_KEY = "voice-assistant-auto-interrupt";
const CONTENT_RATING_KEY = "voice-assistant-content-rating";
const REALTIME_MODE_KEY = "voice-assistant-realtime-mode";

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [audioResponseEnabled, setAudioResponseEnabled] = useState(true);
  const [autoInterruptEnabled, setAutoInterruptEnabled] = useState(true);
  const [textInput, setTextInput] = useState("");
  const [isTextMode, setIsTextMode] = useState(false);
  const [realtimeMode, setRealtimeMode] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);

  const {
    conversations,
    activeConversation,
    activeConversationId,
    createConversation,
    switchConversation,
    deleteConversation,
    addMessage,
    generateTitle,
  } = useConversations();

  const messages = activeConversation?.messages || [];

  // Keep a ref to the latest messages to avoid stale closures in callbacks
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Track which messages we've seen from realtime to avoid duplicates
  const seenRealtimeMessagesRef = useRef<Set<string>>(new Set());

  // Realtime session hook
  const {
    status: realtimeStatus,
    isConnected: isRealtimeConnected,
    error: realtimeError,
    connect: connectRealtime,
    disconnect: disconnectRealtime,
    interrupt: interruptRealtime,
  } = useRealtimeSession({
    onMessage: (message) => {
      // Avoid duplicate messages
      if (seenRealtimeMessagesRef.current.has(message.id)) {
        return;
      }
      seenRealtimeMessagesRef.current.add(message.id);

      // Ensure we have an active conversation
      let conversationId = activeConversationId;
      if (!conversationId) {
        const newConvo = createConversation();
        conversationId = newConvo.id;
      }
      addMessage(conversationId, message);

      // Generate title after first exchange
      if (messages.length === 0 && message.role === "assistant") {
        const lastUserMsg = messages.find((m) => m.role === "user");
        if (lastUserMsg) {
          generateTitle(conversationId, lastUserMsg.content, message.content);
        }
      }
    },
    onError: (err) => setError(err),
    contentRating: typeof window !== "undefined" ? localStorage.getItem(CONTENT_RATING_KEY) || "M" : "M",
  });

  // Load preferences from localStorage on mount
  useEffect(() => {
    const audioPref = localStorage.getItem(AUDIO_RESPONSE_KEY);
    if (audioPref !== null) {
      setAudioResponseEnabled(audioPref === "true");
    }

    const interruptPref = localStorage.getItem(AUTO_INTERRUPT_KEY);
    if (interruptPref !== null) {
      setAutoInterruptEnabled(interruptPref === "true");
    }

    const realtimePref = localStorage.getItem(REALTIME_MODE_KEY);
    if (realtimePref !== null) {
      setRealtimeMode(realtimePref === "true");
    }
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Process the audio blob through transcription, chat, and TTS
  const processAudio = useCallback(async (audioBlob: Blob) => {
    // Ensure we have an active conversation
    let conversationId = activeConversationId;
    if (!conversationId) {
      const newConvo = createConversation();
      conversationId = newConvo.id;
    }

    try {
      // Step 1: Transcribe audio
      const formData = new FormData();
      formData.append("audio", audioBlob, "recording.wav");

      const transcribeRes = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      const transcribeData = await transcribeRes.json();
      if (!transcribeRes.ok) {
        throw new Error(transcribeData.error || "Failed to transcribe audio");
      }

      const { text } = transcribeData;

      // If transcription is empty, just return to idle (don't show error)
      if (!text || text.trim() === "") {
        console.log("Empty transcription, returning to idle");
        setStatus("idle");
        return;
      }

      // Add user message to history
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      addMessage(conversationId, userMessage);

      // Get current messages for API call (use ref to avoid stale closure)
      const currentMessages = [...messagesRef.current, userMessage];

      // Step 2: Get AI response with full conversation context
      const contentRating = localStorage.getItem(CONTENT_RATING_KEY) || "M";
      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: currentMessages.map(m => ({ role: m.role, content: m.content })),
          contentRating,
        }),
      });

      const chatData = await chatRes.json();
      if (!chatRes.ok) {
        throw new Error(chatData.error || "Failed to get response");
      }

      const { response: aiResponse, toolsUsed } = chatData;

      // Add assistant message to history
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: aiResponse,
        timestamp: Date.now(),
        toolsUsed: toolsUsed,
      };
      addMessage(conversationId, assistantMessage);

      // Generate title after first exchange
      if (currentMessages.length === 1) {
        generateTitle(conversationId, text, aiResponse);
      }

      // Step 3: Convert to speech (if enabled)
      if (audioResponseEnabled) {
        setStatus("playing");
        const selectedVoiceId = localStorage.getItem(VOICE_STORAGE_KEY);
        const speakRes = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: aiResponse, voiceId: selectedVoiceId }),
        });

        if (!speakRes.ok) {
          const errorData = await speakRes.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to generate speech");
        }

        const audioBuffer = await speakRes.arrayBuffer();
        const audioBlob2 = new Blob([audioBuffer], { type: "audio/mpeg" });
        const audioUrl = URL.createObjectURL(audioBlob2);

        if (audioRef.current) {
          audioRef.current.src = audioUrl;
          audioRef.current.onended = () => {
            setStatus("idle");
            URL.revokeObjectURL(audioUrl);
          };
          await audioRef.current.play();
        }
      } else {
        setStatus("idle");
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "An error occurred");
      setStatus("idle");
    }
  }, [activeConversationId, createConversation, addMessage, generateTitle, audioResponseEnabled]);

  // Process text message (for typed input)
  const processTextMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;

    // Ensure we have an active conversation
    let conversationId = activeConversationId;
    if (!conversationId) {
      const newConvo = createConversation();
      conversationId = newConvo.id;
    }

    setStatus("processing");
    setTextInput("");

    try {
      // Add user message to history
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      addMessage(conversationId, userMessage);

      // Get current messages for API call (use ref to avoid stale closure)
      const currentMessages = [...messagesRef.current, userMessage];

      // Get AI response with full conversation context
      const contentRating = localStorage.getItem(CONTENT_RATING_KEY) || "M";
      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: currentMessages.map(m => ({ role: m.role, content: m.content })),
          contentRating,
        }),
      });

      const chatData = await chatRes.json();
      if (!chatRes.ok) {
        throw new Error(chatData.error || "Failed to get response");
      }

      const { response: aiResponse, toolsUsed } = chatData;

      // Add assistant message to history
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: aiResponse,
        timestamp: Date.now(),
        toolsUsed: toolsUsed,
      };
      addMessage(conversationId, assistantMessage);

      // Generate title after first exchange
      if (currentMessages.length === 1) {
        generateTitle(conversationId, text, aiResponse);
      }

      // Convert to speech (if enabled)
      if (audioResponseEnabled) {
        setStatus("playing");
        const selectedVoiceId = localStorage.getItem(VOICE_STORAGE_KEY);
        const speakRes = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: aiResponse, voiceId: selectedVoiceId }),
        });

        if (!speakRes.ok) {
          const errorData = await speakRes.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to generate speech");
        }

        const audioBuffer = await speakRes.arrayBuffer();
        const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });
        const audioUrl = URL.createObjectURL(audioBlob);

        if (audioRef.current) {
          audioRef.current.src = audioUrl;
          audioRef.current.onended = () => {
            setStatus("idle");
            URL.revokeObjectURL(audioUrl);
          };
          await audioRef.current.play();
        }
      } else {
        setStatus("idle");
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "An error occurred");
      setStatus("idle");
    }
  }, [activeConversationId, createConversation, addMessage, generateTitle, audioResponseEnabled]);

  // Use Silero VAD for automatic voice detection
  const {
    state: vadState,
    isListening,
    isSpeaking: isUserSpeaking,
    isLoading: isVADLoading,
    error: vadError,
    startListening,
    stopListening,
  } = useSileroVAD({
    startOnLoad: false,
    onSpeechStart: () => {
      setError(null);
    },
    onSpeechEnd: async (audioBlob) => {
      setStatus("processing");
      await processAudio(audioBlob);
    },
  });

  // Interrupt current speech playback
  const interruptSpeech = useCallback(() => {
    if (audioRef.current && status === "playing") {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setStatus("idle");
    }
  }, [status]);

  // Handle automatic interruption when user starts speaking during assistant playback
  const handleAutoInterrupt = useCallback(async () => {
    if (audioRef.current && status === "playing") {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setError(null);
      startListening();
      setStatus("listening");
    }
  }, [status, startListening]);

  // Use interruption detector during speech playback
  useInterruptionDetector({
    isActive: status === "playing" && autoInterruptEnabled,
    speechDuration: 200,
    onInterrupt: handleAutoInterrupt,
  });

  const toggleAudioResponse = () => {
    const newValue = !audioResponseEnabled;
    setAudioResponseEnabled(newValue);
    localStorage.setItem(AUDIO_RESPONSE_KEY, String(newValue));
  };

  const toggleAutoInterrupt = () => {
    const newValue = !autoInterruptEnabled;
    setAutoInterruptEnabled(newValue);
    localStorage.setItem(AUTO_INTERRUPT_KEY, String(newValue));
  };

  const handleButtonClick = async () => {
    if (realtimeMode) {
      // Realtime mode logic
      if (isRealtimeConnected) {
        if (realtimeStatus === "speaking") {
          interruptRealtime();
        } else {
          disconnectRealtime();
        }
      } else {
        // Ensure conversation exists
        if (!activeConversationId) {
          createConversation();
        }
        setError(null);
        await connectRealtime();
      }
    } else {
      // Classic mode logic
      if (isListening || vadState === "speaking") {
        // Stop listening
        stopListening();
        setStatus("idle");
      } else if (status === "idle") {
        // Start listening
        setError(null);
        setIsTextMode(false);
        startListening();
        setStatus("listening");
      } else if (status === "playing") {
        // Interrupt playback and start listening
        interruptSpeech();
        setError(null);
        startListening();
        setStatus("listening");
      }
    }
  };

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (textInput.trim() && status === "idle") {
      processTextMessage(textInput);
    }
  };

  const handleKeyboardToggle = () => {
    if (isListening) {
      stopListening();
      setStatus("idle");
    }
    setIsTextMode(!isTextMode);
    if (!isTextMode) {
      // Focus the text input when switching to text mode
      setTimeout(() => textInputRef.current?.focus(), 100);
    }
  };

  const getStatusConfig = () => {
    // Handle Realtime mode
    if (realtimeMode) {
      switch (realtimeStatus) {
        case "connecting":
          return { text: "Connecting", color: "bg-amber-500", pulse: true };
        case "connected":
        case "listening":
          return { text: "Listening", color: "bg-blue-500", pulse: true };
        case "speaking":
          return { text: "Speaking", color: "bg-emerald-500", pulse: true };
        case "processing":
          return { text: "Processing", color: "bg-amber-500", pulse: true };
        case "error":
          return { text: "Error", color: "bg-red-500", pulse: false };
        default:
          return { text: "Ready", color: "bg-gray-400", pulse: false };
      }
    }

    // Classic mode
    if (isVADLoading) {
      return { text: "Loading", color: "bg-gray-500", pulse: false };
    }
    if (isListening) {
      return isUserSpeaking
        ? { text: "Hearing you", color: "bg-red-500", pulse: true }
        : { text: "Listening", color: "bg-blue-500", pulse: true };
    }
    switch (status) {
      case "processing":
        return { text: "Processing", color: "bg-amber-500", pulse: true };
      case "playing":
        return { text: "Speaking", color: "bg-emerald-500", pulse: true };
      default:
        return { text: "Ready", color: "bg-gray-400", pulse: false };
    }
  };

  const statusConfig = getStatusConfig();

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center shadow-lg">
            <WaveformIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">
              Voice Assistant
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              {realtimeMode ? "Realtime Mode" : "Classic Mode"}
              {activeConversation ? ` · ${activeConversation.title}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Audio Response Toggle */}
          <button
            onClick={toggleAudioResponse}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
              audioResponseEnabled
                ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            }`}
            title={audioResponseEnabled ? "Voice responses on" : "Voice responses off"}
          >
            {audioResponseEnabled ? (
              <SpeakerOnIcon className="w-4 h-4" />
            ) : (
              <SpeakerOffIcon className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">{audioResponseEnabled ? "Voice On" : "Voice Off"}</span>
          </button>

          <Link
            href="/settings"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-all duration-200"
          >
            <SettingsIcon className="w-4 h-4" />
            <span className="hidden sm:inline">Settings</span>
          </Link>
        </div>
      </header>

      {/* Main Content - Scrollable Messages Area */}
      <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        <div className="max-w-2xl mx-auto">
          {/* Error Display */}
          {(error || vadError || realtimeError) && (
            <div
              className="mb-4 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl animate-fade-in"
              role="alert"
            >
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-5 h-5 mt-0.5 text-red-500">
                  <AlertIcon />
                </div>
                <div>
                  <p className="text-sm font-medium text-red-800 dark:text-red-200">
                    Something went wrong
                  </p>
                  <p className="mt-1 text-sm text-red-600 dark:text-red-300">
                    {error || vadError || realtimeError}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-center py-12">
              <div className="w-16 h-16 rounded-2xl bg-[var(--surface)] shadow-lg flex items-center justify-center mb-4">
                <ChatBubbleIcon className="w-8 h-8 text-[var(--text-muted)]" />
              </div>
              <p className="text-[var(--text-secondary)] font-medium">
                {activeConversation ? "No messages yet" : "No conversation selected"}
              </p>
              <p className="text-sm text-[var(--text-muted)] mt-1 max-w-xs">
                {activeConversation
                  ? "Tap the microphone or type a message to start"
                  : "Tap the microphone to start, or select a conversation"}
              </p>
            </div>
          ) : (
            <div className="space-y-4 pb-4">
              {messages.map((message, index) => (
                <div
                  key={message.id}
                  className={`flex ${message.role === "user" ? "justify-end" : "justify-start"} animate-slide-up`}
                  style={{ animationDelay: `${index * 0.05}s` }}
                >
                  <div
                    className={`max-w-[85%] sm:max-w-[75%] px-4 py-3 ${
                      message.role === "user"
                        ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-2xl rounded-br-md shadow-lg"
                        : "bg-[var(--surface)] text-[var(--text-primary)] rounded-2xl rounded-bl-md shadow-md border border-[var(--border)]"
                    }`}
                  >
                    <p className="text-sm leading-relaxed">{stripThinkingTags(message.content)}</p>
                    <div className={`flex items-center gap-2 mt-2 ${
                      message.role === "user"
                        ? "text-indigo-200"
                        : "text-[var(--text-muted)]"
                    }`}>
                      <span className="text-xs">
                        {formatTime(message.timestamp)}
                      </span>
                      {message.role === "assistant" && message.toolsUsed && message.toolsUsed.length > 0 && (
                        <ToolBadges tools={message.toolsUsed} />
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </main>

      {/* Sticky Input Bar */}
      <div className="flex-shrink-0 sticky bottom-0 z-40 bg-[var(--background)]/95 backdrop-blur-lg border-t border-[var(--border)]">
        {/* Status Indicator */}
        <div className="flex items-center justify-center gap-2 py-2 border-b border-[var(--border)]/50">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--surface)] border border-[var(--border)]">
            <span className={`w-2 h-2 rounded-full ${statusConfig.color} ${statusConfig.pulse ? 'animate-pulse' : ''}`} />
            <span className="text-xs font-medium text-[var(--text-secondary)]">
              {statusConfig.text}
            </span>
            {/* Auto-interrupt toggle inline */}
            <button
              onClick={toggleAutoInterrupt}
              className={`ml-2 px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                autoInterruptEnabled
                  ? "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-500"
              }`}
              title={autoInterruptEnabled ? "Auto-interrupt enabled" : "Auto-interrupt disabled"}
            >
              {autoInterruptEnabled ? "Auto" : "Manual"}
            </button>
          </div>
        </div>

        {/* Input Controls */}
        <div className="px-4 sm:px-6 py-3">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center gap-3">
              {/* Keyboard Toggle Button */}
              <button
                onClick={handleKeyboardToggle}
                className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 ${
                  isTextMode
                    ? "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400"
                    : "bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                } border border-[var(--border)]`}
                aria-label={isTextMode ? "Switch to voice" : "Switch to keyboard"}
              >
                {isTextMode ? (
                  <MicrophoneIcon className="w-5 h-5" />
                ) : (
                  <KeyboardIcon className="w-5 h-5" />
                )}
              </button>

              {/* Text Input or Voice Button */}
              {isTextMode ? (
                <form onSubmit={handleTextSubmit} className="flex-1 flex items-center gap-2">
                  <input
                    ref={textInputRef}
                    type="text"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    placeholder="Type your message..."
                    disabled={status !== "idle"}
                    className="flex-1 h-12 px-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 disabled:opacity-50 transition-all"
                  />
                  <button
                    type="submit"
                    disabled={!textInput.trim() || status !== "idle"}
                    className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed hover:from-indigo-600 hover:to-violet-700 transition-all shadow-lg hover:shadow-xl active:scale-95"
                    aria-label="Send message"
                  >
                    <SendIcon className="w-5 h-5" />
                  </button>
                </form>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  {/* Voice Button */}
                  <button
                    onClick={handleButtonClick}
                    disabled={realtimeMode ? realtimeStatus === "connecting" : (status === "processing" || isVADLoading)}
                    className={`relative w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center transition-all duration-300 shadow-lg hover:shadow-xl focus:outline-none focus-visible:ring-4 focus-visible:ring-[var(--border-focus)] ${
                      realtimeMode
                        ? // Realtime mode styles
                          realtimeStatus === "connecting"
                          ? "bg-gradient-to-br from-amber-400 to-orange-500 cursor-not-allowed"
                          : realtimeStatus === "listening" || realtimeStatus === "connected"
                          ? "bg-gradient-to-br from-blue-500 to-cyan-500 cursor-pointer hover:scale-105 active:scale-95"
                          : realtimeStatus === "speaking"
                          ? "bg-gradient-to-br from-emerald-400 to-teal-500 cursor-pointer hover:scale-105 active:scale-95"
                          : realtimeStatus === "error"
                          ? "bg-gradient-to-br from-red-500 to-orange-500 cursor-pointer hover:scale-105 active:scale-95"
                          : "bg-gradient-to-br from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 cursor-pointer hover:scale-105 active:scale-95"
                        : // Classic mode styles
                          isVADLoading
                        ? "bg-gradient-to-br from-gray-400 to-gray-500 cursor-not-allowed"
                        : status === "idle" && !isListening
                        ? "bg-gradient-to-br from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 cursor-pointer hover:scale-105 active:scale-95"
                        : isListening && !isUserSpeaking
                        ? "bg-gradient-to-br from-blue-500 to-cyan-500 cursor-pointer hover:scale-105 active:scale-95"
                        : isUserSpeaking
                        ? "bg-gradient-to-br from-red-500 to-orange-500 cursor-pointer hover:scale-105 active:scale-95 animate-pulse"
                        : status === "processing"
                        ? "bg-gradient-to-br from-amber-400 to-orange-500 cursor-not-allowed"
                        : status === "playing"
                        ? "bg-gradient-to-br from-emerald-400 to-teal-500 cursor-pointer hover:scale-105 active:scale-95"
                        : "bg-gradient-to-br from-indigo-500 to-violet-600"
                    }`}
                    aria-label={statusConfig.text}
                  >
                    {/* Pulse rings for active states */}
                    {(realtimeMode
                      ? (realtimeStatus === "listening" || realtimeStatus === "speaking")
                      : (isListening || status === "playing")
                    ) && (
                      <>
                        <span className={`absolute inset-0 rounded-full ${
                          realtimeMode
                            ? realtimeStatus === "speaking" ? 'bg-emerald-500/20' : 'bg-blue-500/20'
                            : isUserSpeaking ? 'bg-red-500/20' : isListening ? 'bg-blue-500/20' : 'bg-emerald-500/20'
                        } animate-ping`} />
                        <span className={`absolute inset-0 rounded-full ${
                          realtimeMode
                            ? realtimeStatus === "speaking" ? 'bg-emerald-500/10' : 'bg-blue-500/10'
                            : isUserSpeaking ? 'bg-red-500/10' : isListening ? 'bg-blue-500/10' : 'bg-emerald-500/10'
                        } animate-pulse`} />
                      </>
                    )}

                    {/* Button Icon */}
                    <span className="relative z-10">
                      {realtimeMode ? (
                        // Realtime mode icons
                        realtimeStatus === "connecting" ? (
                          <LoadingIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : realtimeStatus === "listening" || realtimeStatus === "connected" ? (
                          <ListeningIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : realtimeStatus === "speaking" ? (
                          <SoundWaveIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : isRealtimeConnected ? (
                          <StopIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : (
                          <MicrophoneIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        )
                      ) : (
                        // Classic mode icons
                        isVADLoading ? (
                          <LoadingIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : isListening && !isUserSpeaking ? (
                          <ListeningIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : isUserSpeaking ? (
                          <StopIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : status === "processing" ? (
                          <LoadingIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : status === "playing" ? (
                          <SoundWaveIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        ) : (
                          <MicrophoneIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                        )
                      )}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* Hint text */}
            <p className="text-center text-xs text-[var(--text-muted)] mt-2">
              {isTextMode
                ? "Press Enter to send"
                : realtimeMode
                ? isRealtimeConnected
                  ? realtimeStatus === "speaking"
                    ? "Speak to interrupt"
                    : "Speak now - Tap to disconnect"
                  : "Tap to connect"
                : isListening
                ? isUserSpeaking ? "Recording - will stop when you pause" : "Speak now"
                : status === "playing"
                ? autoInterruptEnabled ? "Speak to interrupt" : "Tap to interrupt"
                : "Tap to start speaking"}
            </p>
          </div>
        </div>
      </div>

      {/* Conversation Bubbles */}
      <ConversationBubbles
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelect={switchConversation}
        onNewConversation={createConversation}
        onDelete={deleteConversation}
      />

      {/* Hidden audio element */}
      <audio ref={audioRef} className="hidden" />
    </div>
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function stripThinkingTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

function WaveformIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M2 12h2" />
      <path d="M6 8v8" />
      <path d="M10 5v14" />
      <path d="M14 8v8" />
      <path d="M18 10v4" />
      <path d="M22 12h-2" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function MicrophoneIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function KeyboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.01" />
      <path d="M10 8h.01" />
      <path d="M14 8h.01" />
      <path d="M18 8h.01" />
      <path d="M8 12h.01" />
      <path d="M12 12h.01" />
      <path d="M16 12h.01" />
      <path d="M7 16h10" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

function ListeningIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <circle cx="12" cy="21" r="1.5" className="animate-pulse" fill="currentColor" stroke="none" />
    </svg>
  );
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function LoadingIcon({ className }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function SoundWaveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect className="sound-wave-bar" x="4" y="10" width="2" height="4" rx="1" />
      <rect className="sound-wave-bar" x="8" y="6" width="2" height="12" rx="1" />
      <rect className="sound-wave-bar" x="12" y="8" width="2" height="8" rx="1" />
      <rect className="sound-wave-bar" x="16" y="4" width="2" height="16" rx="1" />
      <rect className="sound-wave-bar" x="20" y="9" width="2" height="6" rx="1" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function ChatBubbleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

function SpeakerOnIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function SpeakerOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="22" x2="16" y1="9" y2="15" />
      <line x1="16" x2="22" y1="9" y2="15" />
    </svg>
  );
}

// Tool badge component for showing which tools were used
function ToolBadges({ tools }: { tools: string[] }) {
  // Deduplicate tools (in case same tool was called multiple times)
  const uniqueTools = [...new Set(tools)];

  return (
    <div className="flex items-center gap-1">
      {uniqueTools.map((tool) => (
        <ToolBadge key={tool} tool={tool} />
      ))}
    </div>
  );
}

function ToolBadge({ tool }: { tool: string }) {
  const getToolConfig = (toolName: string) => {
    switch (toolName) {
      case "get_weather":
        return {
          icon: WeatherIcon,
          label: "Weather",
          color: "text-sky-500 dark:text-sky-400",
          bgColor: "bg-sky-500/10",
        };
      case "get_current_time":
        return {
          icon: ClockIcon,
          label: "Time",
          color: "text-violet-500 dark:text-violet-400",
          bgColor: "bg-violet-500/10",
        };
      default:
        return {
          icon: ToolIcon,
          label: toolName,
          color: "text-indigo-500 dark:text-indigo-400",
          bgColor: "bg-indigo-500/10",
        };
    }
  };

  const config = getToolConfig(tool);
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${config.bgColor} ${config.color}`}
      title={`Used ${config.label} tool`}
    >
      <Icon className="w-3 h-3" />
      <span className="sr-only">{config.label}</span>
    </span>
  );
}

function WeatherIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="M20 12h2" />
      <path d="m19.07 4.93-1.41 1.41" />
      <path d="M15.947 12.65a4 4 0 0 0-5.925-4.128" />
      <path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ToolIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}
