export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radius = Math.min(
    Math.max(Number(req.query.radius) || 10000, 1000),
    25000
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

  const query = `
    [out:json][timeout:20];
    (
      nwr(around:${radius},${lat},${lng})
        ["amenity"~"^(hospital|clinic|doctors|dentist)$"];

      nwr(around:${radius},${lat},${lng})
        ["healthcare"~"^(hospital|clinic|doctor|dentist)$"];
    );
    out center tags;
  `;

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
      const url = new URL(endpoint);
      url.searchParams.set("data", query);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "CareConnect/1.0 (healthcare facility discovery)"
        },
        signal: controller.signal
      });

      if (!response.ok) {
        console.warn(
          `Overpass endpoint returned ${response.status}: ${endpoint}`
        );
        continue;
      }

      const data = await response.json();

      if (!Array.isArray(data.elements)) {
        console.warn("Overpass returned an invalid response.");
        continue;
      }

      res.setHeader(
        "Cache-Control",
        "s-maxage=60, stale-while-revalidate=120"
      );

      return res.status(200).json(data);
    } catch (error) {
      console.error(
        `Overpass endpoint failed: ${endpoint}`,
        error.message
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return res.status(503).json({
    error:
      "Hospital search is temporarily unavailable. Please try again shortly."
  });
}