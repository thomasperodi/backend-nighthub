// Free-tier geocoding (OpenStreetMap Nominatim, no API key) used to derive a venue's
// latitude/longitude from its street address at creation/update time. Best-effort: returns
// null on any failure (no match, network error, timeout) instead of throwing, so a bad/
// unrecognized address never blocks saving the venue - it just leaves lat/lng unset.
export async function geocodeAddress(
  address: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'NightHub-Backend/1.0 (venue address geocoding)',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const results = (await res.json()) as Array<{ lat: string; lon: string }>;
    const first = results[0];
    if (!first) return null;

    const latitude = Number(first.lat);
    const longitude = Number(first.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    return { latitude, longitude };
  } catch {
    return null;
  }
}
