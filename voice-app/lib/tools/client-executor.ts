/**
 * Client-side Tool Executor
 *
 * This module provides tool execution for the browser (Realtime mode).
 * Tools that need server-side resources use local API proxies.
 */

import type {
  ToolName,
  ToolParameters,
  WeatherParams,
  TimeParams,
  GetViewDataParams,
  FetchUrlParams,
  WebSearchParams,
} from "./registry";
import { isValidToolName } from "./registry";
import { toVoiceFriendlyError, getHttpStatusMessage } from "@/lib/errors";

// =============================================================================
// Helper: Create voice-friendly error JSON
// =============================================================================

/**
 * Create a JSON string error result with voice-friendly messaging
 */
function createFriendlyError(technicalError: string, toolName?: string): string {
  const friendlyError = toVoiceFriendlyError(technicalError, toolName);
  const message = friendlyError.suggestion
    ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
    : friendlyError.userMessage;
  return JSON.stringify({ error: message });
}

/**
 * Create a JSON string error result for HTTP status codes
 */
function createHttpError(status: number, context?: string): string {
  const friendlyError = getHttpStatusMessage(status, context);
  const message = friendlyError.suggestion
    ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
    : friendlyError.userMessage;
  return JSON.stringify({ error: message });
}

// =============================================================================
// Weather Descriptions (WMO codes)
// =============================================================================

const WEATHER_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
};

// =============================================================================
// Tool Execution Functions
// =============================================================================

async function executeWeather(params: WeatherParams): Promise<string> {
  const { location, units } = params;
  console.log(`[Weather Tool] Starting for location: ${location}, units: ${units}`);

  try {
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
    const geocodeRes = await fetch(geocodeUrl);

    if (!geocodeRes.ok) {
      return createFriendlyError(`Geocoding API error: ${geocodeRes.status}`, "get_weather");
    }

    const geocodeData = await geocodeRes.json();

    if (!geocodeData.results || geocodeData.results.length === 0) {
      return createFriendlyError(`Could not find location: ${location}`, "get_weather");
    }

    const { latitude, longitude, name, country } = geocodeData.results[0];
    const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=${temperatureUnit}`;

    const weatherRes = await fetch(weatherUrl);

    if (!weatherRes.ok) {
      return createFriendlyError(`Weather API error: ${weatherRes.status}`, "get_weather");
    }

    const weatherData = await weatherRes.json();
    const current = weatherData.current;

    if (!current) {
      return createFriendlyError("Failed to fetch weather data", "get_weather");
    }

    const result = {
      location: `${name}, ${country}`,
      temperature: current.temperature_2m,
      feels_like: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      wind_speed: current.wind_speed_10m,
      conditions: WEATHER_DESCRIPTIONS[current.weather_code] || "Unknown",
      units: temperatureUnit,
    };

    console.log(`[Weather Tool] Success:`, result);
    return JSON.stringify(result);
  } catch (error) {
    console.error("[Weather Tool] Exception:", error);
    return createFriendlyError("Failed to fetch weather data", "get_weather");
  }
}

async function executeTime(params: TimeParams): Promise<string> {
  try {
    // Default to user's local timezone if not specified
    const tz = params.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return createFriendlyError(`Invalid timezone: ${tz}`, "get_current_time");
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
    return createFriendlyError("Failed to get current time", "get_current_time");
  }
}

async function executeListViews(): Promise<string> {
  try {
    // Use local proxy to avoid CORS issues
    const response = await fetch("/api/farmboard/views");
    if (!response.ok) {
      return createHttpError(response.status, "list views");
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
    return createFriendlyError("Failed to fetch views", "list_views");
  }
}

async function executeGetViewData(params: GetViewDataParams): Promise<string> {
  try {
    // Use local proxy to avoid CORS issues
    const response = await fetch(`/api/farmboard/view/${params.view_id}`);
    if (!response.ok) {
      // Special handling for 404 - the view wasn't found
      if (response.status === 404) {
        return createFriendlyError("Failed to fetch view data: 404", "get_view_data");
      }
      return createHttpError(response.status, "view data");
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
    return createFriendlyError("Failed to fetch view data", "get_view_data");
  }
}

async function executeFetchUrl(params: FetchUrlParams): Promise<string> {
  const { url, depth, max_pages, same_domain } = params;
  console.log(`[Fetch URL Tool] Starting for URL: ${url}, depth: ${depth}`);

  try {
    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return createFriendlyError(`Invalid URL: ${url}`, "fetch_url");
    }

    // Only allow http and https protocols
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return createFriendlyError(`Unsupported protocol: ${parsedUrl.protocol}`, "fetch_url");
    }

    // Build proxy URL with optional parameters
    const queryParams = new URLSearchParams({ url });
    if (depth !== undefined) queryParams.set("depth", String(depth));
    if (max_pages !== undefined) queryParams.set("max_pages", String(max_pages));
    if (same_domain !== undefined) queryParams.set("same_domain", String(same_domain));

    const proxyUrl = `/api/fetch?${queryParams.toString()}`;
    const response = await fetch(proxyUrl);

    if (!response.ok) {
      return createHttpError(response.status, "fetch web page");
    }

    const data = await response.json();
    console.log(`[Fetch URL Tool] Success`);
    return JSON.stringify(data);
  } catch (error) {
    console.error("[Fetch URL Tool] Exception:", error);
    return createFriendlyError("Failed to fetch URL", "fetch_url");
  }
}

async function executeWebSearch(params: WebSearchParams): Promise<string> {
  const { query, num_results } = params;
  console.log(`[Web Search Tool] Searching for: ${query}`);

  try {
    const queryParams = new URLSearchParams({ q: query });
    if (num_results !== undefined) queryParams.set("num", String(num_results));

    const response = await fetch(`/api/search?${queryParams.toString()}`);

    if (!response.ok) {
      return createHttpError(response.status, "web search");
    }

    const data = await response.json();
    console.log(`[Web Search Tool] Success`);
    return JSON.stringify(data);
  } catch (error) {
    console.error("[Web Search Tool] Exception:", error);
    return createFriendlyError("Search failed", "web_search");
  }
}

/**
 * Get browser geolocation coordinates
 */
function getBrowserLocation(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !navigator?.geolocation) {
      reject(new Error("Geolocation not available"));
      return;
    }

    console.log("[Location Tool] Requesting browser geolocation permission...");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        console.log("[Location Tool] Browser geolocation permission granted");
        resolve(position);
      },
      (error) => {
        console.log("[Location Tool] Browser geolocation error:", error.code, error.message);
        // Error codes: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
        reject(error);
      },
      {
        enableHighAccuracy: false,
        timeout: 10000, // 10 seconds to allow time for permission prompt
        maximumAge: 300000, // Cache for 5 minutes
      }
    );
  });
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
 * Get timezone from coordinates using browser API
 */
function getTimezoneFromBrowser(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Fallback: Get location via IP address
 */
async function getLocationViaIP(): Promise<string> {
  const response = await fetch(
    "http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,lat,lon,timezone"
  );

  if (!response.ok) {
    throw new Error(`Location API error: ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "fail") {
    throw new Error(data.message || "Failed to determine location");
  }

  return JSON.stringify({
    location: `${data.city}, ${data.regionName}, ${data.country}`,
    city: data.city,
    region: data.regionName,
    country: data.country,
    countryCode: data.countryCode,
    timezone: data.timezone,
    coordinates: {
      latitude: data.lat,
      longitude: data.lon,
    },
    source: "ip",
  });
}

async function executeUserLocation(): Promise<string> {
  console.log("[Location Tool] Attempting browser geolocation first");

  try {
    // Try browser geolocation first
    const position = await getBrowserLocation();
    const { latitude, longitude } = position.coords;
    console.log(`[Location Tool] Browser location: ${latitude}, ${longitude}`);

    // Reverse geocode to get city/country
    const geoData = await reverseGeocode(latitude, longitude);

    if (geoData && geoData.city) {
      const result = {
        location: `${geoData.city}, ${geoData.region}, ${geoData.country}`,
        city: geoData.city,
        region: geoData.region,
        country: geoData.country,
        countryCode: geoData.countryCode,
        timezone: getTimezoneFromBrowser(),
        coordinates: { latitude, longitude },
        source: "browser",
      };
      console.log(`[Location Tool] Success (browser):`, result);
      return JSON.stringify(result);
    }

    // Reverse geocoding failed, but we have coords - return what we have
    const result = {
      location: `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
      city: "",
      region: "",
      country: "",
      countryCode: "",
      timezone: getTimezoneFromBrowser(),
      coordinates: { latitude, longitude },
      source: "browser",
    };
    console.log(`[Location Tool] Partial success (browser coords only):`, result);
    return JSON.stringify(result);

  } catch (browserError) {
    console.log("[Location Tool] Browser geolocation failed, falling back to IP:", browserError);

    try {
      const ipResult = await getLocationViaIP();
      console.log("[Location Tool] Success (IP fallback)");
      return ipResult;
    } catch (ipError) {
      console.error("[Location Tool] IP fallback also failed:", ipError);
      return createFriendlyError("Failed to get user location", "get_user_location");
    }
  }
}

// =============================================================================
// Main Executor
// =============================================================================

/**
 * Execute a tool by name with the given parameters (client-side)
 * Returns a JSON string result suitable for sending back to the LLM
 */
export async function executeToolClient(
  toolName: string,
  params: Record<string, unknown>
): Promise<string> {
  if (!isValidToolName(toolName)) {
    return createFriendlyError(`Unknown tool: ${toolName}`);
  }

  const name = toolName as ToolName;

  switch (name) {
    case "get_weather":
      return executeWeather(params as unknown as ToolParameters["get_weather"]);
    case "get_current_time":
      return executeTime(params as unknown as ToolParameters["get_current_time"]);
    case "list_views":
      return executeListViews();
    case "get_view_data":
      return executeGetViewData(params as unknown as ToolParameters["get_view_data"]);
    case "fetch_url":
      return executeFetchUrl(params as unknown as ToolParameters["fetch_url"]);
    case "web_search":
      return executeWebSearch(params as unknown as ToolParameters["web_search"]);
    case "get_user_location":
      return executeUserLocation();
    default: {
      // This should never happen if isValidToolName works correctly
      const _exhaustiveCheck: never = name;
      return createFriendlyError(`Unknown tool: ${_exhaustiveCheck}`);
    }
  }
}
