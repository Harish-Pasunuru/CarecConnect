
const CACHE_TTL = 10 * 60 * 1000;
const REQUEST_TIMEOUT = 10000;
const SEARCH_RADIUS = 10000;

const cache = new Map();
const cooldowns = new Map();

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

function cacheKey(lat, lng) {
  return `${lat.toFixed(3)}:${lng.toFixed(3)}:${SEARCH_RADIUS}`;
}

function getCached(key) {
  const entry = cache.get(key);

  if (!entry) return null;

  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(key);
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

function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
}

// Convert Geoapify GeoJSON features into the format
// already used by the CareConnect frontend.
function normalizeGeoapify(data, userLat, userLng) {
  if (!Array.isArray(data.features)) {
    throw new Error("Geoapify returned an invalid response.");
  }

  const elements = [];

  for (const feature of data.features) {
    const properties = feature.properties || {};
    const coordinates = feature.geometry?.coordinates;

    const lat = Number(properties.lat ?? coordinates?.[1]);
    const lon = Number(properties.lon ?? coordinates?.[0]);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !properties.name
    ) {
      continue;
    }

    // Enforce the requested radius on the server too.
    if (distanceKm(userLat, userLng, lat, lon) > 10) {
      continue;
    }

    const categories = Array.isArray(properties.categories)
      ? properties.categories
      : [];

    const raw = properties.datasource?.raw || {};

    const healthcareCategory = categories.find(category =>
      category.startsWith("healthcare.")
    ) || "";

    const healthcareType = healthcareCategory.includes("hospital")
      ? "hospital"
      : healthcareCategory.includes("dentist")
        ? "dentist"
        : healthcareCategory.includes("clinic")
          ? "clinic"
          : "healthcare";

    const tags = {
      ...raw,
      name: properties.name,
      healthcare: raw.healthcare || healthcareType,
      amenity: raw.amenity || (
        healthcareType === "hospital" ? "hospital" :
        healthcareType === "dentist" ? "dentist" :
        healthcareType === "clinic" ? "clinic" : "doctors"
      )
    };

    const specialty =
      raw["healthcare:speciality"] ||
      raw["healthcare:specialty"] ||
      raw.speciality ||
      raw.specialty;

    if (specialty) {
      tags["healthcare:speciality"] = specialty;
    }

    if (properties.housenumber) {
      tags["addr:housenumber"] = properties.housenumber;
    }

    if (properties.street) {
      tags["addr:street"] = properties.street;
    }

    if (properties.suburb || properties.district) {
      tags["addr:suburb"] =
        properties.suburb || properties.district;
    }

    if (properties.city || properties.county) {
      tags["addr:city"] =
        properties.city || properties.county;
    }

    if (properties.postcode) {
      tags["addr:postcode"] = properties.postcode;
    }

    // Preserve a usable address if structured fields are missing.
    if (
      !tags["addr:street"] &&
      !tags["addr:suburb"] &&
      properties.formatted
    ) {
      tags["addr:street"] = properties.formatted;
    }

    elements.push({
      type: "geoapify",
      id: String(
        properties.place_id ||
        `${lat.toFixed(6)}_${lon.toFixed(6)}_${properties.name}`
      ),
      lat,
      lon,
      tags
    });
  }

  return { elements };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function searchGeoapify(lat, lng, apiKey) {
  const url = new URL("https://api.geoapify.com/v2/places");

  url.searchParams.set("categories", "healthcare");
  url.searchParams.set(
    "filter",
    `circle:${lng},${lat},${SEARCH_RADIUS}`
  );
  url.searchParams.set("bias", `proximity:${lng},${lat}`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("lang", "en");

  const response = await fetchWithTimeout(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "x-api-key": apiKey
    }
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Geoapify returned HTTP ${response.status}: ${details.slice(0, 250)}`
    );
  }

  const data = await response.json();

  return normalizeGeoapify(data, lat, lng);
}

async function searchOverpass(lat, lng) {
  const query = `
    [out:json][timeout:15];
    (
      nwr(around:${SEARCH_RADIUS},${lat},${lng})
        ["amenity"~"^(hospital|clinic|doctors|dentist)$"];

      nwr(around:${SEARCH_RADIUS},${lat},${lng})
        ["healthcare"~"^(hospital|clinic|doctor|dentist)$"];
    );
    out center tags;
  `;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const nextAllowed = cooldowns.get(endpoint) || 0;

    if (nextAllowed > Date.now()) {
      continue;
    }

    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded;charset=UTF-8",
          "Accept": "application/json",
          "User-Agent": "CareConnect/1.0"
        },
        body: new URLSearchParams({ data: query })
      });

      if (response.status === 429 || response.status === 406) {
        cooldowns.set(endpoint, Date.now() + 60000);
        console.warn("Overpass rate limited:", response.status);
        continue;
      }

      if (!response.ok) {
        console.warn("Overpass returned:", response.status);
        continue;
      }

      const data = await response.json();

      if (!Array.isArray(data.elements) || data.remark) {
        continue;
      }

      return data;
    } catch (error) {
      console.warn("Overpass fallback failed:", endpoint, error.message);
    }
  }

  throw new Error("All hospital data providers are unavailable.");
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
  const apiKey = process.env.GEOAPIFY_API_KEY;

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

  if (!apiKey) {
    console.error("GEOAPIFY_API_KEY is not configured.");
    return res.status(500).json({
      error: "Hospital search is not configured."
    });
  }

  const key = cacheKey(lat, lng);
  const cached = getCached(key);

  if (cached) {
    res.setHeader("X-CareConnect-Cache", "HIT");
    return res.status(200).json(cached);
  }

  // Primary provider: Geoapify.
  try {
    const data = await searchGeoapify(lat, lng, apiKey);

    saveCache(key, data);

    res.setHeader("X-CareConnect-Provider", "Geoapify");
    res.setHeader(
      "Cache-Control",
      "s-maxage=600, stale-while-revalidate=300"
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error("Geoapify primary search failed:", error.message);
  }

  // Fallback provider: OpenStreetMap Overpass.
  try {
    const data = await searchOverpass(lat, lng);

    saveCache(key, data);

    res.setHeader("X-CareConnect-Provider", "Overpass");
    res.setHeader(
      "Cache-Control",
      "s-maxage=600, stale-while-revalidate=300"
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error("All hospital providers failed:", error.message);
  }

  // Serve an expired cached result if a previous search succeeded.
  const stale = cache.get(key);

  if (stale) {
    res.setHeader("X-CareConnect-Cache", "STALE");
    return res.status(200).json(stale.data);
  }

  return res.status(503).json({
    error:
      "Nearby hospital data is temporarily unavailable. Please try again shortly."
  });
}
