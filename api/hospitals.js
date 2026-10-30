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
    [out:json][timeout:30];
    (
      node(around:${radius},${lat},${lng})
        ["amenity"~"^(hospital|clinic|doctors|dentist)$"];

      way(around:${radius},${lat},${lng})
        ["amenity"~"^(hospital|clinic|doctors|dentist)$"];

      relation(around:${radius},${lat},${lng})
        ["amenity"~"^(hospital|clinic|doctors|dentist)$"];

      node(around:${radius},${lat},${lng})
        ["healthcare"~"^(hospital|clinic|doctor|dentist)$"];

      way(around:${radius},${lat},${lng})
        ["healthcare"~"^(hospital|clinic|doctor|dentist)$"];

      relation(around:${radius},${lat},${lng})
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
    const timeout = setTimeout(
      () => controller.abort(),
      35000
    );

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded;charset=UTF-8",
          "Accept": "application/json"
        },
        body: new URLSearchParams({
          data: query
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        console.warn(
          "Overpass endpoint returned:",
          response.status
        );
        continue;
      }

      const data = await response.json();

      if (
        !Array.isArray(data.elements) ||
        data.remark
      ) {
        continue;
      }

      // Preserve the Overpass response format so the
      // existing frontend can process data.elements.
      res.setHeader(
        "Cache-Control",
        "s-maxage=30, stale-while-revalidate=60"
      );

      return res.status(200).json(data);

    } catch (error) {
      console.error(
        "Overpass endpoint failed:",
        endpoint,
        error.message
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return res.status(503).json({
    error:
      "The hospital search service is temporarily unavailable. Please try again shortly."
  });
}