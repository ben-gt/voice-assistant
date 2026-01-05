import { toVoiceFriendlyError } from "@/lib/errors";

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface LocationData {
  city: string;
  region: string;
  country: string;
  countryCode: string;
  timezone: string;
  lat: number;
  lon: number;
}

/**
 * Get user's approximate location based on IP address
 * Uses ip-api.com (free, no API key required, 45 requests/minute limit)
 */
export async function getUserLocation(): Promise<ToolResult> {
  try {
    const response = await fetch(
      "http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,lat,lon,timezone",
      { next: { revalidate: 300 } } // Cache for 5 minutes
    );

    if (!response.ok) {
      const friendlyError = toVoiceFriendlyError(
        `Location API returned ${response.status}`,
        "get_user_location"
      );
      return {
        success: false,
        error: friendlyError.userMessage,
      };
    }

    const data = await response.json();

    if (data.status === "fail") {
      const friendlyError = toVoiceFriendlyError(
        data.message || "Failed to determine location",
        "get_user_location"
      );
      return {
        success: false,
        error: friendlyError.userMessage,
      };
    }

    const locationData: LocationData = {
      city: data.city,
      region: data.regionName,
      country: data.country,
      countryCode: data.countryCode,
      timezone: data.timezone,
      lat: data.lat,
      lon: data.lon,
    };

    console.log(`[Location Tool] Detected location: ${locationData.city}, ${locationData.region}, ${locationData.country}`);

    return {
      success: true,
      data: {
        location: `${locationData.city}, ${locationData.region}, ${locationData.country}`,
        city: locationData.city,
        region: locationData.region,
        country: locationData.country,
        countryCode: locationData.countryCode,
        timezone: locationData.timezone,
        coordinates: {
          latitude: locationData.lat,
          longitude: locationData.lon,
        },
        source: "ip", // Server-side can only use IP geolocation
      },
    };
  } catch (error) {
    console.error("Location tool error:", error);
    const friendlyError = toVoiceFriendlyError(
      "Failed to get user location",
      "get_user_location"
    );
    return {
      success: false,
      error: friendlyError.suggestion
        ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
        : friendlyError.userMessage,
    };
  }
}
