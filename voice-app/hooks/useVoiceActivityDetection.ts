"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface UseVoiceActivityDetectionOptions {
  // Threshold for considering audio as "speech" (0-1, default 0.01)
  speechThreshold?: number;
  // How long silence must last before considering speech ended (ms)
  silenceTimeout?: number;
  // Minimum speech duration to be considered valid (ms)
  minSpeechDuration?: number;
  // Callback when speech starts
  onSpeechStart?: () => void;
  // Callback when speech ends (after silence timeout)
  onSpeechEnd?: () => void;
}

interface UseVoiceActivityDetectionReturn {
  isListening: boolean;
  isSpeaking: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: string | null;
}

export function useVoiceActivityDetection(
  options: UseVoiceActivityDetectionOptions = {}
): UseVoiceActivityDetectionReturn {
  const {
    speechThreshold = 0.01,
    silenceTimeout = 1500,
    minSpeechDuration = 300,
    onSpeechStart,
    onSpeechEnd,
  } = options;

  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const speechStartRef = useRef<number | null>(null);
  const wasSpeakingRef = useRef(false);

  const cleanup = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  const analyzeAudio = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // Calculate average volume level (normalized 0-1)
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255;
    const now = Date.now();

    if (average > speechThreshold) {
      // User is speaking
      silenceStartRef.current = null;

      if (!wasSpeakingRef.current) {
        // Speech just started
        speechStartRef.current = now;
        wasSpeakingRef.current = true;
        setIsSpeaking(true);
        onSpeechStart?.();
      }
    } else {
      // Silence detected
      if (wasSpeakingRef.current) {
        if (!silenceStartRef.current) {
          silenceStartRef.current = now;
        }

        const silenceDuration = now - silenceStartRef.current;
        const speechDuration = speechStartRef.current
          ? now - speechStartRef.current
          : 0;

        // If silence has lasted long enough and we had valid speech
        if (
          silenceDuration >= silenceTimeout &&
          speechDuration >= minSpeechDuration
        ) {
          wasSpeakingRef.current = false;
          setIsSpeaking(false);
          onSpeechEnd?.();
          silenceStartRef.current = null;
          speechStartRef.current = null;
        }
      }
    }

    // Continue the analysis loop
    animationFrameRef.current = requestAnimationFrame(analyzeAudio);
  }, [speechThreshold, silenceTimeout, minSpeechDuration, onSpeechStart, onSpeechEnd]);

  const startListening = useCallback(async () => {
    try {
      setError(null);
      cleanup();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      setIsListening(true);
      wasSpeakingRef.current = false;
      silenceStartRef.current = null;
      speechStartRef.current = null;

      // Start the analysis loop
      analyzeAudio();
    } catch (err) {
      setError("Microphone access denied. Please allow microphone access.");
      console.error("Error starting voice activity detection:", err);
    }
  }, [cleanup, analyzeAudio]);

  const stopListening = useCallback(() => {
    cleanup();
    setIsListening(false);
    setIsSpeaking(false);
    wasSpeakingRef.current = false;
  }, [cleanup]);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return {
    isListening,
    isSpeaking,
    startListening,
    stopListening,
    error,
  };
}
