"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Voice {
  id: string;
  name: string;
  category: string;
}

type ContentRating = "G" | "PG" | "M" | "MA" | "R";

interface RatingInfo {
  label: string;
  description: string;
  color: string;
}

const RATINGS: Record<ContentRating, RatingInfo> = {
  G: {
    label: "G",
    description: "General. Suitable for all ages.",
    color: "bg-green-500",
  },
  PG: {
    label: "PG",
    description: "Parental Guidance. May contain content young children find confusing.",
    color: "bg-yellow-500",
  },
  M: {
    label: "M",
    description: "Mature. Recommended for ages 15 and over.",
    color: "bg-blue-500",
  },
  MA: {
    label: "MA15+",
    description: "Mature Accompanied. Not suitable for under 15.",
    color: "bg-orange-500",
  },
  R: {
    label: "R18+",
    description: "Restricted. Adults only.",
    color: "bg-red-500",
  },
};

const VOICE_STORAGE_KEY = "voice-assistant-selected-voice";
const CONTENT_RATING_KEY = "voice-assistant-content-rating";
const VAD_SPEECH_THRESHOLD_KEY = "voice-assistant-vad-speech-threshold";
const VAD_SILENCE_THRESHOLD_KEY = "voice-assistant-vad-silence-threshold";
const VAD_MIN_SPEECH_KEY = "voice-assistant-vad-min-speech";
const VAD_SILENCE_WAIT_KEY = "voice-assistant-vad-silence-wait";
const REALTIME_MODE_KEY = "voice-assistant-realtime-mode";

export default function Settings() {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>("");
  const [contentRating, setContentRating] = useState<ContentRating>("M");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingVoice, setTestingVoice] = useState<string | null>(null);

  // VAD Settings
  const [speechThreshold, setSpeechThreshold] = useState(0.8);
  const [silenceThreshold, setSilenceThreshold] = useState(0.5);
  const [minSpeechMs, setMinSpeechMs] = useState(800);
  const [silenceWaitMs, setSilenceWaitMs] = useState(1200);

  // Realtime Mode
  const [realtimeMode, setRealtimeMode] = useState(false);

  useEffect(() => {
    // Load saved voice preference
    const savedVoice = localStorage.getItem(VOICE_STORAGE_KEY);
    if (savedVoice) {
      setSelectedVoiceId(savedVoice);
    }

    // Load saved content rating
    const savedRating = localStorage.getItem(CONTENT_RATING_KEY);
    if (savedRating && savedRating in RATINGS) {
      setContentRating(savedRating as ContentRating);
    }

    // Load VAD settings
    const savedSpeechThreshold = localStorage.getItem(VAD_SPEECH_THRESHOLD_KEY);
    if (savedSpeechThreshold) setSpeechThreshold(parseFloat(savedSpeechThreshold));

    const savedSilenceThreshold = localStorage.getItem(VAD_SILENCE_THRESHOLD_KEY);
    if (savedSilenceThreshold) setSilenceThreshold(parseFloat(savedSilenceThreshold));

    const savedMinSpeech = localStorage.getItem(VAD_MIN_SPEECH_KEY);
    if (savedMinSpeech) setMinSpeechMs(parseInt(savedMinSpeech));

    const savedSilenceWait = localStorage.getItem(VAD_SILENCE_WAIT_KEY);
    if (savedSilenceWait) setSilenceWaitMs(parseInt(savedSilenceWait));

    // Load realtime mode preference
    const savedRealtimeMode = localStorage.getItem(REALTIME_MODE_KEY);
    if (savedRealtimeMode !== null) {
      setRealtimeMode(savedRealtimeMode === "true");
    }

    // Fetch available voices
    fetchVoices();
  }, []);

  const fetchVoices = async () => {
    try {
      const res = await fetch("/api/voices");
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch voices");
      }

      setVoices(data.voices);

      // If no voice selected yet, select the first one
      if (!selectedVoiceId && data.voices.length > 0) {
        const savedVoice = localStorage.getItem(VOICE_STORAGE_KEY);
        if (!savedVoice) {
          setSelectedVoiceId(data.voices[0].id);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load voices");
    } finally {
      setLoading(false);
    }
  };

  const handleVoiceSelect = (voiceId: string) => {
    setSelectedVoiceId(voiceId);
    localStorage.setItem(VOICE_STORAGE_KEY, voiceId);
  };

  const handleRatingSelect = (rating: ContentRating) => {
    setContentRating(rating);
    localStorage.setItem(CONTENT_RATING_KEY, rating);
  };

  const handleSpeechThresholdChange = (value: number) => {
    setSpeechThreshold(value);
    localStorage.setItem(VAD_SPEECH_THRESHOLD_KEY, value.toString());
  };

  const handleSilenceThresholdChange = (value: number) => {
    setSilenceThreshold(value);
    localStorage.setItem(VAD_SILENCE_THRESHOLD_KEY, value.toString());
  };

  const handleMinSpeechChange = (value: number) => {
    setMinSpeechMs(value);
    localStorage.setItem(VAD_MIN_SPEECH_KEY, value.toString());
  };

  const handleSilenceWaitChange = (value: number) => {
    setSilenceWaitMs(value);
    localStorage.setItem(VAD_SILENCE_WAIT_KEY, value.toString());
  };

  const resetVadSettings = () => {
    handleSpeechThresholdChange(0.8);
    handleSilenceThresholdChange(0.5);
    handleMinSpeechChange(800);
    handleSilenceWaitChange(1200);
  };

  const handleRealtimeModeChange = (enabled: boolean) => {
    setRealtimeMode(enabled);
    localStorage.setItem(REALTIME_MODE_KEY, String(enabled));
  };

  const testVoice = async (voiceId: string) => {
    setTestingVoice(voiceId);
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Hello! This is how I sound.",
          voiceId,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to test voice");
      }

      const audioBuffer = await res.arrayBuffer();
      const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.onended = () => URL.revokeObjectURL(audioUrl);
      await audio.play();
    } catch (err) {
      console.error("Test voice error:", err);
    } finally {
      setTestingVoice(null);
    }
  };

  // Group voices by category
  const myVoices = voices.filter((v) => v.category === "cloned" || v.category === "generated");
  const presetVoices = voices.filter((v) => v.category === "premade");

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--border)] transition-all duration-200"
            aria-label="Back to chat"
          >
            <ChevronLeftIcon className="w-5 h-5 text-[var(--text-secondary)]" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">
              Settings
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              Customize your assistant
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-4 sm:px-6 py-6 overflow-y-auto">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Error Display */}
          {error && (
            <div
              className="p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl animate-fade-in"
              role="alert"
            >
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-5 h-5 mt-0.5 text-red-500">
                  <AlertCircleIcon />
                </div>
                <div>
                  <p className="text-sm font-medium text-red-800 dark:text-red-200">
                    Failed to load voices
                  </p>
                  <p className="mt-1 text-sm text-red-600 dark:text-red-300">
                    {error}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Voice Selection Card */}
          <div className="bg-[var(--surface)] rounded-2xl shadow-lg border border-[var(--border)] overflow-hidden">
            {/* Card Header */}
            <div className="px-5 py-4 border-b border-[var(--border)]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center">
                  <SpeakerIcon className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Voice Selection
                  </h2>
                  <p className="text-sm text-[var(--text-muted)]">
                    Choose the voice for your assistant
                  </p>
                </div>
              </div>
            </div>

            {/* Card Content */}
            <div className="p-5">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="w-10 h-10 rounded-full border-2 border-[var(--border)] border-t-indigo-500 animate-spin" />
                  <p className="mt-4 text-sm text-[var(--text-muted)]">
                    Loading voices...
                  </p>
                </div>
              ) : voices.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-[var(--surface-hover)] flex items-center justify-center mb-4">
                    <SpeakerOffIcon className="w-8 h-8 text-[var(--text-muted)]" />
                  </div>
                  <p className="text-[var(--text-secondary)] font-medium">
                    No voices available
                  </p>
                  <p className="text-sm text-[var(--text-muted)] mt-1">
                    Please check your Eleven Labs configuration
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* My Voices Section */}
                  {myVoices.length > 0 && (
                    <div className="animate-fade-in">
                      <div className="flex items-center gap-2 mb-3">
                        <UserIcon className="w-4 h-4 text-[var(--text-muted)]" />
                        <h3 className="text-sm font-medium text-[var(--text-secondary)]">
                          My Voices
                        </h3>
                        <span className="px-2 py-0.5 text-xs font-medium bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-full">
                          {myVoices.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {myVoices.map((voice, index) => (
                          <VoiceOption
                            key={voice.id}
                            voice={voice}
                            selected={selectedVoiceId === voice.id}
                            testing={testingVoice === voice.id}
                            onSelect={() => handleVoiceSelect(voice.id)}
                            onTest={() => testVoice(voice.id)}
                            index={index}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Preset Voices Section */}
                  {presetVoices.length > 0 && (
                    <div className="animate-fade-in" style={{ animationDelay: "0.1s" }}>
                      <div className="flex items-center gap-2 mb-3">
                        <SparklesIcon className="w-4 h-4 text-[var(--text-muted)]" />
                        <h3 className="text-sm font-medium text-[var(--text-secondary)]">
                          Preset Voices
                        </h3>
                        <span className="px-2 py-0.5 text-xs font-medium bg-[var(--surface-hover)] text-[var(--text-muted)] rounded-full">
                          {presetVoices.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {presetVoices.map((voice, index) => (
                          <VoiceOption
                            key={voice.id}
                            voice={voice}
                            selected={selectedVoiceId === voice.id}
                            testing={testingVoice === voice.id}
                            onSelect={() => handleVoiceSelect(voice.id)}
                            onTest={() => testVoice(voice.id)}
                            index={index}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Conversation Mode Card */}
          <div className="bg-[var(--surface)] rounded-2xl shadow-lg border border-[var(--border)] overflow-hidden">
            {/* Card Header */}
            <div className="px-5 py-4 border-b border-[var(--border)]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
                  <BoltIcon className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Conversation Mode
                  </h2>
                  <p className="text-sm text-[var(--text-muted)]">
                    Choose how voice conversations are processed
                  </p>
                </div>
              </div>
            </div>

            {/* Card Content */}
            <div className="p-5 space-y-4">
              {/* Classic Mode Option */}
              <button
                onClick={() => handleRealtimeModeChange(false)}
                className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 transition-all duration-200 ${
                  !realtimeMode
                    ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/20 shadow-sm"
                    : "border-[var(--border)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                <div className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  !realtimeMode ? "border-indigo-500" : "border-[var(--border-hover)]"
                }`}>
                  {!realtimeMode && <div className="w-2 h-2 rounded-full bg-indigo-500" />}
                </div>
                <div className="flex-1 text-left">
                  <span className={`font-medium ${!realtimeMode ? "text-indigo-700 dark:text-indigo-300" : "text-[var(--text-primary)]"}`}>
                    Classic Mode
                  </span>
                  <p className="text-sm text-[var(--text-muted)]">
                    Whisper transcription, Cerebras AI, ElevenLabs voice
                  </p>
                </div>
              </button>

              {/* Realtime Mode Option */}
              <button
                onClick={() => handleRealtimeModeChange(true)}
                className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 transition-all duration-200 ${
                  realtimeMode
                    ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/20 shadow-sm"
                    : "border-[var(--border)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                <div className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  realtimeMode ? "border-indigo-500" : "border-[var(--border-hover)]"
                }`}>
                  {realtimeMode && <div className="w-2 h-2 rounded-full bg-indigo-500" />}
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium ${realtimeMode ? "text-indigo-700 dark:text-indigo-300" : "text-[var(--text-primary)]"}`}>
                      Realtime Mode
                    </span>
                    <span className="px-2 py-0.5 text-xs font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full">
                      Beta
                    </span>
                  </div>
                  <p className="text-sm text-[var(--text-muted)]">
                    OpenAI Realtime API with native speech-to-speech
                  </p>
                </div>
              </button>

              {/* Info about Realtime Mode */}
              {realtimeMode && (
                <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30 rounded-lg">
                  <InfoIcon className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Realtime mode uses OpenAI&apos;s built-in voice and semantic VAD.
                    ElevenLabs voice selection and VAD settings are not used in this mode.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Content Rating Card */}
          <div className="bg-[var(--surface)] rounded-2xl shadow-lg border border-[var(--border)] overflow-hidden">
            {/* Card Header */}
            <div className="px-5 py-4 border-b border-[var(--border)]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
                  <ShieldIcon className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Content Rating
                  </h2>
                  <p className="text-sm text-[var(--text-muted)]">
                    Set age-appropriate content level
                  </p>
                </div>
              </div>
            </div>

            {/* Card Content */}
            <div className="p-5">
              <div className="space-y-2">
                {(Object.keys(RATINGS) as ContentRating[]).map((rating, index) => (
                  <button
                    key={rating}
                    onClick={() => handleRatingSelect(rating)}
                    className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 transition-all duration-200 animate-slide-up ${
                      contentRating === rating
                        ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/20 shadow-sm"
                        : "border-[var(--border)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
                    }`}
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    {/* Rating Badge */}
                    <div className={`flex-shrink-0 w-12 h-8 rounded-md ${RATINGS[rating].color} flex items-center justify-center`}>
                      <span className="text-white text-sm font-bold">
                        {RATINGS[rating].label}
                      </span>
                    </div>

                    {/* Description */}
                    <div className="flex-1 text-left">
                      <span className={`text-sm ${
                        contentRating === rating
                          ? "text-indigo-700 dark:text-indigo-300 font-medium"
                          : "text-[var(--text-secondary)]"
                      }`}>
                        {RATINGS[rating].description}
                      </span>
                    </div>

                    {/* Check mark */}
                    {contentRating === rating && (
                      <div className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center">
                        <CheckIcon className="w-3 h-3 text-white" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* VAD Settings Card */}
          <div className="bg-[var(--surface)] rounded-2xl shadow-lg border border-[var(--border)] overflow-hidden">
            {/* Card Header */}
            <div className="px-5 py-4 border-b border-[var(--border)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center">
                    <MicrophoneIcon className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-[var(--text-primary)]">
                      Voice Detection
                    </h2>
                    <p className="text-sm text-[var(--text-muted)]">
                      Tune speech detection sensitivity
                    </p>
                  </div>
                </div>
                <button
                  onClick={resetVadSettings}
                  className="px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-hover)] hover:bg-[var(--border)] rounded-lg transition-colors"
                >
                  Reset
                </button>
              </div>
            </div>

            {/* Card Content */}
            <div className="p-5 space-y-6">
              {/* Speech Threshold */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-[var(--text-primary)]">
                    Speech Threshold
                  </label>
                  <span className="text-sm text-[var(--text-muted)]">{speechThreshold.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.3"
                  max="0.95"
                  step="0.05"
                  value={speechThreshold}
                  onChange={(e) => handleSpeechThresholdChange(parseFloat(e.target.value))}
                  className="w-full h-2 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Higher = less sensitive (ignores quiet sounds). Lower = more sensitive.
                </p>
              </div>

              {/* Silence Threshold */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-[var(--text-primary)]">
                    Silence Threshold
                  </label>
                  <span className="text-sm text-[var(--text-muted)]">{silenceThreshold.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="0.8"
                  step="0.05"
                  value={silenceThreshold}
                  onChange={(e) => handleSilenceThresholdChange(parseFloat(e.target.value))}
                  className="w-full h-2 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  When sound drops below this, silence is detected.
                </p>
              </div>

              {/* Minimum Speech Duration */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-[var(--text-primary)]">
                    Minimum Speech Duration
                  </label>
                  <span className="text-sm text-[var(--text-muted)]">{minSpeechMs}ms</span>
                </div>
                <input
                  type="range"
                  min="200"
                  max="2000"
                  step="100"
                  value={minSpeechMs}
                  onChange={(e) => handleMinSpeechChange(parseInt(e.target.value))}
                  className="w-full h-2 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Ignore sounds shorter than this. Higher = ignores short noises.
                </p>
              </div>

              {/* Silence Wait Time */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-[var(--text-primary)]">
                    Silence Wait Time
                  </label>
                  <span className="text-sm text-[var(--text-muted)]">{silenceWaitMs}ms</span>
                </div>
                <input
                  type="range"
                  min="500"
                  max="3000"
                  step="100"
                  value={silenceWaitMs}
                  onChange={(e) => handleSilenceWaitChange(parseInt(e.target.value))}
                  className="w-full h-2 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Wait this long after speech stops before processing. Higher = more pause-tolerant.
                </p>
              </div>

              {/* Refresh Notice */}
              <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30 rounded-lg">
                <RefreshIcon className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Return to the main page for changes to take effect.
                </p>
              </div>
            </div>
          </div>

          {/* Info Card */}
          <div className="bg-[var(--surface)] rounded-2xl border border-[var(--border)] p-5">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                <InfoIcon className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  About Settings
                </h3>
                <p className="mt-1 text-sm text-[var(--text-secondary)] leading-relaxed">
                  Your selected voice will be used for all text-to-speech responses.
                  The content rating uses the Australian Classification system to filter
                  response appropriateness. VAD settings control how the microphone detects
                  your voice. All preferences are saved locally in your browser.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function VoiceOption({
  voice,
  selected,
  testing,
  onSelect,
  onTest,
  index,
}: {
  voice: Voice;
  selected: boolean;
  testing: boolean;
  onSelect: () => void;
  onTest: () => void;
  index: number;
}) {
  return (
    <div
      className={`group flex items-center justify-between p-4 rounded-xl border-2 transition-all duration-200 cursor-pointer animate-slide-up ${
        selected
          ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/20 shadow-sm"
          : "border-[var(--border)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
      }`}
      style={{ animationDelay: `${index * 0.05}s` }}
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex items-center gap-3">
        {/* Custom Radio Button */}
        <div
          className={`relative w-5 h-5 rounded-full border-2 transition-all duration-200 flex items-center justify-center ${
            selected
              ? "border-indigo-500 bg-indigo-500"
              : "border-[var(--border-hover)] group-hover:border-[var(--text-muted)]"
          }`}
        >
          {selected && (
            <div className="w-2 h-2 rounded-full bg-white" />
          )}
        </div>

        {/* Voice Info */}
        <div>
          <span className={`font-medium transition-colors duration-200 ${
            selected ? "text-indigo-700 dark:text-indigo-300" : "text-[var(--text-primary)]"
          }`}>
            {voice.name}
          </span>
          {voice.category && (
            <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${
              voice.category === "cloned" || voice.category === "generated"
                ? "bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400"
                : "bg-[var(--surface-hover)] text-[var(--text-muted)]"
            }`}>
              {voice.category}
            </span>
          )}
        </div>
      </div>

      {/* Test Button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onTest();
        }}
        disabled={testing}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-200 ${
          testing
            ? "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 cursor-not-allowed"
            : "bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:bg-indigo-100 dark:hover:bg-indigo-900/30 hover:text-indigo-600 dark:hover:text-indigo-400"
        }`}
      >
        {testing ? (
          <>
            <LoadingSpinner className="w-3.5 h-3.5" />
            <span>Playing...</span>
          </>
        ) : (
          <>
            <PlayIcon className="w-3.5 h-3.5" />
            <span>Test</span>
          </>
        )}
      </button>
    </div>
  );
}

// Icon Components
function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function AlertCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  );
}

function SpeakerIcon({ className }: { className?: string }) {
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

function UserIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function LoadingSpinner({ className }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
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

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}
