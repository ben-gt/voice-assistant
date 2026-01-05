import { toVoiceFriendlyError } from "@/lib/errors";
import { Agent, fetch as undiciFetch } from "undici";

// Create an agent that forces IPv4 connections to avoid ETIMEDOUT errors
// on networks where IPv6 resolution fails or times out.
const ipv4Agent = new Agent({
  connect: {
    family: 4, // Force IPv4
  },
});

interface WeatherInput {
  location: string;
  units?: "celsius" | "fahrenheit";
}

interface GeocodingResult {
  latitude: number;
  longitude: number;
  name: string;
  country: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const FETCH_TIMEOUT_MS = 10000; // 10 second timeout
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is a retryable network error
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Retry on timeout, connection reset, DNS failures, etc.
    return (
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "EAI_AGAIN" ||
      error.name === "AbortError"
    );
  }
  return false;
}

/**
 * Fetch with timeout using undici (forces IPv4) and retry logic with exponential backoff
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
  retries: number = MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Use undici fetch with IPv4 agent to avoid IPv6 timeout issues
      const response = await undiciFetch(url, {
        signal: controller.signal,
        dispatcher: ipv4Agent,
      });
      clearTimeout(timeoutId);
      // Convert undici Response to standard Response for compatibility
      return response as unknown as Response;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error instanceof Error ? error : new Error(String(error));

      // Only retry on network-related errors
      if (!isRetryableError(error) || attempt === retries - 1) {
        throw lastError;
      }

      // Exponential backoff: 500ms, 1000ms, 2000ms, etc.
      const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `Fetch attempt ${attempt + 1}/${retries} failed for ${url}, retrying in ${delayMs}ms:`,
        lastError.message
      );
      await sleep(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error("Fetch failed after retries");
}

async function geocodeLocation(location: string): Promise<GeocodingResult | null> {
  const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  const geocodeRes = await fetchWithTimeout(geocodeUrl);
  const geocodeData = await geocodeRes.json();

  if (geocodeData.results && geocodeData.results.length > 0) {
    return geocodeData.results[0] as GeocodingResult;
  }
  return null;
}

export async function getWeather(input: WeatherInput): Promise<ToolResult> {
  try {
    // Validate location is provided
    if (!input.location) {
      return {
        success: false,
        error: "I need a location to check the weather. Which city would you like the weather for?",
      };
    }

    // Step 1: Geocode the location using Open-Meteo's geocoding API
    // Try multiple variations since the API is picky about format
    let geoResult = await geocodeLocation(input.location);

    // If not found, try just the first part (before comma)
    if (!geoResult && input.location.includes(",")) {
      const cityOnly = input.location.split(",")[0].trim();
      geoResult = await geocodeLocation(cityOnly);
    }

    // If still not found, try removing common suffixes/abbreviations
    if (!geoResult) {
      const cleaned = input.location
        .replace(/,?\s*(qld|nsw|vic|sa|wa|nt|tas|act|australia|usa|uk|us)\.?$/i, "")
        .trim();
      if (cleaned !== input.location) {
        geoResult = await geocodeLocation(cleaned);
      }
    }

    if (!geoResult) {
      const friendlyError = toVoiceFriendlyError(
        `Could not find location: ${input.location}`,
        "get_weather"
      );
      return {
        success: false,
        error: friendlyError.suggestion
          ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
          : friendlyError.userMessage,
      };
    }

    const { latitude, longitude, name, country } = geoResult;

    // Step 2: Fetch weather data
    const temperatureUnit =
      input.units === "fahrenheit" ? "fahrenheit" : "celsius";
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=${temperatureUnit}`;

    const weatherRes = await fetchWithTimeout(weatherUrl);
    const weatherData = await weatherRes.json();

    const current = weatherData.current;
    const weatherDescription = getWeatherDescription(current.weather_code);

    return {
      success: true,
      data: {
        location: `${name}, ${country}`,
        temperature: current.temperature_2m,
        feels_like: current.apparent_temperature,
        humidity: current.relative_humidity_2m,
        wind_speed: current.wind_speed_10m,
        conditions: weatherDescription,
        units: temperatureUnit,
      },
    };
  } catch (error) {
    console.error("Weather tool error:", error);
    const friendlyError = toVoiceFriendlyError("Failed to fetch weather data", "get_weather");
    return {
      success: false,
      error: friendlyError.suggestion
        ? `${friendlyError.userMessage} ${friendlyError.suggestion}`
        : friendlyError.userMessage,
    };
  }
}

// WMO Weather interpretation codes
function getWeatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
  };
  return descriptions[code] || "Unknown conditions";
}
