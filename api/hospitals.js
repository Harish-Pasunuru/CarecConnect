const CACHE_TTL = 10 * 60 * 1000;
const COOLDOWN_MS = 30 * 1000;

const cache = new Map();
const cooldowns = new Map();

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

function getCacheKey(lat, lng) {
  return `${lat.toFixed(3)}:${lng.toFixed(3)}`;
}

function getCached(key) {
  const entry = cache.get(key);

  if (!entry) return null;

  if (Date.now() - entry.time > CACHE_TTL) {
    return null;
  }

  return entry.data;
}

function saveCache(key, data) {
  if (cache.size >= 100) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(key, {
    time: Date.now(),
    data
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  // CareConnect searches within a maximum radius of 10 km.
  const radius = Math.min(
    Math.max(Number(req.query.radius) || 10000, 1000),
    10000
  );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return res.status(400).json({
      error: "Valid latitude and longitude are required."
    });
  }

  const key = `${getCacheKey(lat, lng)}:${radius}`;
  const cached = getCached(key);

  if (cached) {
    res.setHeader("X-CareConnect-Cache", "HIT");
    res.setHeader(
      "Cache-Control",
      "s-maxage=600, stale-while-revalidate=300"
    );

    return res.status(200).json(cached);
  }

  const query = `
    [out:json][timeout:8];
    (
      nwr(around:${radius},${lat},${lng})
        ["amenity"~"^(hospital|clinic|doctors|dentist)$"];

      nwr(around:${radius},${lat},${lng})
        ["healthcare"~"^(hospital|clinic|doctor|dentist)$"];
    );
    out center tags;
  `;

  let lastError = "No hospital data available.";

  for (const endpoint of ENDPOINTS) {
    // Respect cooldowns after rate limiting or server errors.
    if ((cooldowns.get(endpoint) || 0) > Date.now()) {
      lastError = "The hospital data service is cooling down.";
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded;charset=UTF-8",
          "Accept": "application/json",
          "User-Agent": "CareConnect/1.0"
        },
        body: new URLSearchParams({
          data: query
        }),
        signal: controller.signal
      });

      if (response.status === 429 || response.status === 406) {
        cooldowns.set(endpoint, Date.now() + COOLDOWN_MS);

        lastError = `Overpass returned HTTP ${response.status}.`;
        console.warn(lastError, endpoint);

        continue;
      }

      if ([502, 503, 504].includes(response.status)) {
        cooldowns.set(endpoint, Date.now() + COOLDOWN_MS);

        lastError = `Overpass returned HTTP ${response.status}.`;
        console.warn(lastError, endpoint);

        continue;
      }

      if (!response.ok) {
        lastError = `Overpass returned HTTP ${response.status}.`;
        console.warn(lastError, endpoint);

        continue;
      }

      const data = await response.json();

      if (!Array.isArray(data.elements) || data.remark) {
        lastError = "The hospital service returned incomplete data.";
        console.warn(lastError, endpoint);

        continue;
      }

      saveCache(key, data);

      res.setHeader("X-CareConnect-Cache", "MISS");
      res.setHeader(
        "Cache-Control",
        "s-maxage=600, stale-while-revalidate=300"
      );

      return res.status(200).json(data);
    } catch (error) {
      lastError = error.name === "AbortError"
        ? "The hospital search request timed out."
        : "Unable to connect to the hospital data service.";

      console.error(
        "Overpass request failed:",
        endpoint,
        error.message
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  console.error("Hospital search unavailable:", lastError);

  return res.status(503).json({
    error:
      "Nearby hospital data is temporarily unavailable. Please try again shortly."
  });
}