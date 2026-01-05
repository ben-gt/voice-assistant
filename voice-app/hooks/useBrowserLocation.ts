"use client";

import { useState, useEffect, useCallback } from "react";

export interface BrowserLocation {
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  timezone?: string;
}

interface UseBrowserLocationReturn {
  location: BrowserLocation | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Reverse geocode coordinates to get location details using OpenStreetMap Nominatim
 */
async function reverseGeocode(lat: number, lon: number): Promise<{
  city: string;
  region: string;
  country: string;
  countryCode: string;
} | null> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
      { headers: { "User-Agent": "VoiceAssistantApp/1.0" } }
    );
    if (!response.ok) return null;

    const data = await response.json();
    const addr = data.address || {};

    return {
      city: addr.city || addr.town || addr.village || addr.municipality || "",
      region: addr.state || addr.county || "",
      country: addr.country || "",
      countryCode: (addr.country_code || "").toUpperCase(),
    };
  } catch {
    return null;
  }
}

/**
 * Hook to get browser geolocation and reverse geocode it
 * Automatically requests permission on mount
 */
export function useBrowserLocation(): UseBrowserLocationReturn {
  const [location, setLocation] = useState<BrowserLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLocation = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.geolocation) {
      setError("Geolocation not available");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 300000, // Cache for 5 minutes
        });
      });

      const { latitude, longitude } = position.coords;
      console.log(`[useBrowserLocation] Got coordinates: ${latitude}, ${longitude}`);

      // Reverse geocode to get city/region
      const geoData = await reverseGeocode(latitude, longitude);

      const locationData: BrowserLocation = {
        latitude,
        longitude,
        city: geoData?.city || "",
        region: geoData?.region || "",
        country: geoData?.country || "",
        countryCode: geoData?.countryCode || "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };

      console.log(`[useBrowserLocation] Location resolved:`, locationData);
      setLocation(locationData);
      setError(null);
    } catch (err) {
      console.log(`[useBrowserLocation] Error:`, err);
      if (err instanceof GeolocationPositionError) {
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setError("Location permission denied");
            break;
          case err.POSITION_UNAVAILABLE:
            setError("Location unavailable");
            break;
          case err.TIMEOUT:
            setError("Location request timed out");
            break;
          default:
            setError("Failed to get location");
        }
      } else {
        setError("Failed to get location");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch location on mount
  useEffect(() => {
    fetchLocation();
  }, [fetchLocation]);

  return {
    location,
    loading,
    error,
    refresh: fetchLocation,
  };
}
