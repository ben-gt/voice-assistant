"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { useMicVAD, utils } from "@ricky0123/vad-react";

export type VADState = "idle" | "listening" | "speaking" | "processing";

// localStorage keys (must match settings page)
const VAD_SPEECH_THRESHOLD_KEY = "voice-assistant-vad-speech-threshold";
const VAD_SILENCE_THRESHOLD_KEY = "voice-assistant-vad-silence-threshold";
const VAD_MIN_SPEECH_KEY = "voice-assistant-vad-min-speech";
const VAD_SILENCE_WAIT_KEY = "voice-assistant-vad-silence-wait";

function getVADSettings() {
  if (typeof window === "undefined") {
    return { speechThreshold: 0.8, silenceThreshold: 0.5, minSpeechMs: 800, silenceWaitMs: 1200 };
  }

  const speechThreshold = parseFloat(localStorage.getItem(VAD_SPEECH_THRESHOLD_KEY) || "0.8");
  const silenceThreshold = parseFloat(localStorage.getItem(VAD_SILENCE_THRESHOLD_KEY) || "0.5");
  const minSpeechMs = parseInt(localStorage.getItem(VAD_MIN_SPEECH_KEY) || "800");
  const silenceWaitMs = parseInt(localStorage.getItem(VAD_SILENCE_WAIT_KEY) || "1200");

  return { speechThreshold, silenceThreshold, minSpeechMs, silenceWaitMs };
}

interface UseSileroVADOptions {
  // Callback when speech ends with audio data
  onSpeechEnd?: (audioBlob: Blob) => void | Promise<void>;
  // Callback when speech starts
  onSpeechStart?: () => void;
  // Whether to start listening immediately
  startOnLoad?: boolean;
  // Note: VAD sensitivity settings are read from localStorage
  // and can be configured in the Settings page
}

interface UseSileroVADReturn {
  // Current state of the VAD system
  state: VADState;
  // Whether VAD is actively listening
  isListening: boolean;
  // Whether user is currently speaking
  isSpeaking: boolean;
  // Whether the VAD model is loading
  isLoading: boolean;
  // Error message if any
  error: string | null;
  // Start listening for voice
  startListening: () => void;
  // Stop listening
  stopListening: () => void;
  // Toggle listening state
  toggle: () => void;
}

export function useSileroVAD(
  options: UseSileroVADOptions = {}
): UseSileroVADReturn {
  const {
    onSpeechEnd,
    onSpeechStart,
    startOnLoad = false,
  } = options;

  // Read settings from localStorage (or use defaults)
  const settings = getVADSettings();

  const [state, setState] = useState<VADState>("idle");
  const processingRef = useRef(false);

  // Use refs to store the latest callbacks to avoid stale closures
  // The useMicVAD hook captures callbacks at initialization, so we need refs
  // to ensure we always call the latest version of the callbacks
  const onSpeechEndRef = useRef(onSpeechEnd);
  const onSpeechStartRef = useRef(onSpeechStart);

  // Keep refs updated with latest callbacks
  useEffect(() => {
    onSpeechEndRef.current = onSpeechEnd;
  }, [onSpeechEnd]);

  useEffect(() => {
    onSpeechStartRef.current = onSpeechStart;
  }, [onSpeechStart]);

  const vad = useMicVAD({
    startOnLoad,
    // Use CDN for ONNX runtime and model files
    baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/",
    onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",
    // Speech detection thresholds from settings (higher = less sensitive)
    positiveSpeechThreshold: settings.speechThreshold,
    negativeSpeechThreshold: settings.silenceThreshold,
    // Timing configuration from settings (in milliseconds)
    minSpeechMs: settings.minSpeechMs,
    redemptionMs: settings.silenceWaitMs,
    preSpeechPadMs: 300,
    // Callbacks - use refs to always call the latest version
    onSpeechStart: () => {
      setState("speaking");
      onSpeechStartRef.current?.();
    },
    onSpeechEnd: async (audio: Float32Array) => {
      if (processingRef.current) return;
      processingRef.current = true;

      setState("processing");

      try {
        // Convert Float32Array to WAV blob
        const wavBuffer = utils.encodeWAV(audio);
        const audioBlob = new Blob([wavBuffer], { type: "audio/wav" });

        // Use ref to call the latest callback, avoiding stale closures
        await onSpeechEndRef.current?.(audioBlob);
      } finally {
        processingRef.current = false;
        // Return to listening state after processing
        if (vad.listening) {
          setState("listening");
        } else {
          setState("idle");
        }
      }
    },
    onVADMisfire: () => {
      // Speech was too short - stay in listening mode
      if (vad.listening) {
        setState("listening");
      }
    },
  });

  // Sync state with VAD listening status
  useEffect(() => {
    if (vad.loading) {
      setState("idle");
    } else if (vad.listening && !vad.userSpeaking && state !== "processing") {
      setState("listening");
    }
  }, [vad.loading, vad.listening, vad.userSpeaking, state]);

  const startListening = useCallback(() => {
    vad.start();
    setState("listening");
  }, [vad]);

  const stopListening = useCallback(() => {
    vad.pause();
    setState("idle");
  }, [vad]);

  const toggle = useCallback(() => {
    if (vad.listening) {
      stopListening();
    } else {
      startListening();
    }
  }, [vad.listening, startListening, stopListening]);

  return {
    state,
    isListening: vad.listening,
    isSpeaking: vad.userSpeaking,
    isLoading: vad.loading,
    error: vad.errored || null,
    startListening,
    stopListening,
    toggle,
  };
}
