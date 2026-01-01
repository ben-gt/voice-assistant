"use client";

import { useRef, useCallback, useEffect } from "react";

interface UseInterruptionDetectorOptions {
  // Threshold for detecting speech (will be auto-calibrated if not set)
  speechThreshold?: number;
  // How long speech must be detected before triggering interruption (ms)
  speechDuration?: number;
  // Callback when interruption is detected
  onInterrupt?: () => void;
  // Whether the detector is active
  isActive: boolean;
}

/**
 * Hook to detect when the user starts speaking (for interruption during assistant playback)
 * Uses passive audio monitoring without recording
 */
export function useInterruptionDetector(options: UseInterruptionDetectorOptions) {
  const {
    speechThreshold = 0.02,
    speechDuration = 200,
    onInterrupt,
    isActive,
  } = options;

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const speechStartRef = useRef<number | null>(null);
  const hasTriggeredRef = useRef(false);
  const noiseFloorRef = useRef<number>(0.01);
  const calibrationSamplesRef = useRef<number[]>([]);

  const cleanup = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    analyserRef.current = null;
    speechStartRef.current = null;
    hasTriggeredRef.current = false;
    calibrationSamplesRef.current = [];
  }, []);

  const analyzeAudio = useCallback(() => {
    const analyser = analyserRef.current;

    if (!analyser || hasTriggeredRef.current) {
      return;
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // Calculate average volume level (normalized 0-1)
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255;
    const now = Date.now();

    // Calibration phase: collect samples for the first 300ms
    if (calibrationSamplesRef.current.length < 15) {
      calibrationSamplesRef.current.push(average);
      if (calibrationSamplesRef.current.length === 15) {
        // Calculate noise floor as the average + a margin
        const avgNoise = calibrationSamplesRef.current.reduce((a, b) => a + b, 0) / 15;
        noiseFloorRef.current = Math.max(avgNoise * 2, 0.01); // At least 2x the ambient level
      }
      animationFrameRef.current = requestAnimationFrame(analyzeAudio);
      return;
    }

    // Dynamic threshold based on calibrated noise floor
    const dynamicThreshold = Math.max(noiseFloorRef.current + 0.01, speechThreshold);

    if (average > dynamicThreshold) {
      // User is speaking
      if (!speechStartRef.current) {
        speechStartRef.current = now;
      } else if (now - speechStartRef.current >= speechDuration) {
        // Speech detected for long enough - trigger interruption
        hasTriggeredRef.current = true;
        onInterrupt?.();
        return; // Stop the loop after triggering
      }
    } else {
      // Reset if silence detected
      speechStartRef.current = null;
    }

    animationFrameRef.current = requestAnimationFrame(analyzeAudio);
  }, [speechThreshold, speechDuration, onInterrupt]);

  const startListening = useCallback(async () => {
    cleanup();
    hasTriggeredRef.current = false;
    calibrationSamplesRef.current = [];

    try {
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
      analyser.smoothingTimeConstant = 0.5; // More responsive than recording
      source.connect(analyser);
      analyserRef.current = analyser;

      // Start analysis loop
      animationFrameRef.current = requestAnimationFrame(analyzeAudio);
    } catch (err) {
      console.error("Error starting interruption detector:", err);
    }
  }, [cleanup, analyzeAudio]);

  // Start/stop based on isActive
  useEffect(() => {
    if (isActive) {
      startListening();
    } else {
      cleanup();
    }

    return cleanup;
  }, [isActive, startListening, cleanup]);

  return {
    cleanup,
  };
}
