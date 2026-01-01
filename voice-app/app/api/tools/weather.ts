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

export async function getWeather(input: WeatherInput): Promise<ToolResult> {
  try {
    // Step 1: Geocode the location using Open-Meteo's geocoding API
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input.location)}&count=1`;
    const geocodeRes = await fetch(geocodeUrl);
    const geocodeData = await geocodeRes.json();

    if (!geocodeData.results || geocodeData.results.length === 0) {
      return {
        success: false,
        error: `Could not find location: ${input.location}`,
      };
    }

    const { latitude, longitude, name, country } =
      geocodeData.results[0] as GeocodingResult;

    // Step 2: Fetch weather data
    const temperatureUnit =
      input.units === "fahrenheit" ? "fahrenheit" : "celsius";
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=${temperatureUnit}`;

    const weatherRes = await fetch(weatherUrl);
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
    return { success: false, error: "Failed to fetch weather data" };
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
