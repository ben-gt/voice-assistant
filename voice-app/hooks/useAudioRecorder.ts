"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface UseAudioRecorderOptions {
  // Enable voice activity detection for automatic stop
  enableVAD?: boolean;
  // Base threshold for considering audio as "speech" (0-1, default 0.015)
  // Will be adjusted based on calibrated noise floor
  speechThreshold?: number;
  // How long silence must last before stopping recording (ms)
  silenceTimeout?: number;
  // Minimum speech duration to be considered valid (ms)
  minSpeechDuration?: number;
  // Callback when speech is detected
  onSpeechStart?: () => void;
  // Callback when recording auto-stops due to silence
  onSilenceDetected?: () => void;
  // Enable adaptive noise calibration (default true)
  adaptiveNoiseCalibration?: boolean;
  // Duration of calibration period in ms (default 300)
  calibrationDuration?: number;
}

interface UseAudioRecorderReturn {
  isRecording: boolean;
  isSpeaking: boolean;
  isCalibrating: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  error: string | null;
  noiseFloor: number;
}

export function useAudioRecorder(
  options: UseAudioRecorderOptions = {}
): UseAudioRecorderReturn {
  const {
    enableVAD = false,
    speechThreshold = 0.015,
    silenceTimeout = 1500,
    minSpeechDuration = 300,
    onSpeechStart,
    onSilenceDetected,
    adaptiveNoiseCalibration = true,
    calibrationDuration = 300,
  } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noiseFloor, setNoiseFloor] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // VAD-related refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const speechStartRef = useRef<number | null>(null);
  const wasSpeakingRef = useRef(false);
  const hasSpokenRef = useRef(false);
  const stopResolverRef = useRef<((blob: Blob | null) => void) | null>(null);

  // Adaptive noise calibration refs
  const calibrationStartRef = useRef<number | null>(null);
  const calibrationSamplesRef = useRef<number[]>([]);
  const calibratedThresholdRef = useRef<number>(speechThreshold);

  const cleanupVAD = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  const analyzeAudio = useCallback(() => {
    const analyser = analyserRef.current;
    const mediaRecorder = mediaRecorderRef.current;

    if (!analyser || !mediaRecorder || mediaRecorder.state !== "recording") {
      return;
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // Calculate average volume level (normalized 0-1)
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255;
    const now = Date.now();

    // Calibration phase: collect noise samples
    if (adaptiveNoiseCalibration && calibrationStartRef.current !== null) {
      const elapsed = now - calibrationStartRef.current;

      if (elapsed < calibrationDuration) {
        // Still calibrating - collect sample
        calibrationSamplesRef.current.push(average);
        animationFrameRef.current = requestAnimationFrame(analyzeAudio);
        return;
      } else {
        // Calibration complete - calculate noise floor
        const samples = calibrationSamplesRef.current;
        if (samples.length > 0) {
          // Use 90th percentile to handle occasional spikes
          const sorted = [...samples].sort((a, b) => a - b);
          const p90Index = Math.floor(sorted.length * 0.9);
          const noiseP90 = sorted[p90Index];

          // Set threshold to noise floor + margin, minimum of base threshold
          const calculatedThreshold = Math.max(noiseP90 * 2.5 + 0.005, speechThreshold);
          calibratedThresholdRef.current = calculatedThreshold;
          setNoiseFloor(noiseP90);
        }
        calibrationStartRef.current = null;
        setIsCalibrating(false);
      }
    }

    // Use calibrated threshold
    const activeThreshold = calibratedThresholdRef.current;

    if (average > activeThreshold) {
      // User is speaking
      silenceStartRef.current = null;

      if (!wasSpeakingRef.current) {
        // Speech just started
        speechStartRef.current = now;
        wasSpeakingRef.current = true;
        hasSpokenRef.current = true;
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
        const speechDurationVal = speechStartRef.current
          ? now - speechStartRef.current
          : 0;

        // If silence has lasted long enough and we had valid speech
        if (
          silenceDuration >= silenceTimeout &&
          speechDurationVal >= minSpeechDuration &&
          hasSpokenRef.current
        ) {
          // Auto-stop recording
          setIsSpeaking(false);
          onSilenceDetected?.();

          // Stop the media recorder
          if (mediaRecorder.state === "recording") {
            mediaRecorder.stop();
          }
          return; // Exit the loop
        }
      }
    }

    // Continue the analysis loop
    animationFrameRef.current = requestAnimationFrame(analyzeAudio);
  }, [speechThreshold, silenceTimeout, minSpeechDuration, onSpeechStart, onSilenceDetected, adaptiveNoiseCalibration, calibrationDuration]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      cleanupVAD();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm",
      });

      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });

        // Stop all tracks
        stream.getTracks().forEach((track) => track.stop());
        cleanupVAD();

        setIsRecording(false);
        setIsSpeaking(false);

        // Resolve the pending promise if there is one
        if (stopResolverRef.current) {
          stopResolverRef.current(blob);
          stopResolverRef.current = null;
        }
      };

      // Set up VAD if enabled
      if (enableVAD) {
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        analyserRef.current = analyser;

        wasSpeakingRef.current = false;
        hasSpokenRef.current = false;
        silenceStartRef.current = null;
        speechStartRef.current = null;

        // Initialize calibration if enabled
        if (adaptiveNoiseCalibration) {
          calibrationStartRef.current = Date.now();
          calibrationSamplesRef.current = [];
          calibratedThresholdRef.current = speechThreshold;
          setIsCalibrating(true);
        }
      }

      mediaRecorder.start();
      setIsRecording(true);

      // Start VAD analysis if enabled
      if (enableVAD) {
        animationFrameRef.current = requestAnimationFrame(analyzeAudio);
      }
    } catch (err) {
      setError("Microphone access denied. Please allow microphone access.");
      console.error("Error starting recording:", err);
    }
  }, [enableVAD, cleanupVAD, analyzeAudio, adaptiveNoiseCalibration, speechThreshold]);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const mediaRecorder = mediaRecorderRef.current;

      if (!mediaRecorder || mediaRecorder.state === "inactive") {
        cleanupVAD();
        setIsRecording(false);
        setIsSpeaking(false);
        resolve(null);
        return;
      }

      // Store the resolver for when onstop fires
      stopResolverRef.current = resolve;
      mediaRecorder.stop();
    });
  }, [cleanupVAD]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupVAD();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [cleanupVAD]);

  return {
    isRecording,
    isSpeaking,
    isCalibrating,
    startRecording,
    stopRecording,
    error,
    noiseFloor,
  };
}
