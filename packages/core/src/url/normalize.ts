export function normalizeUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    const blockedParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "fbclid",
      "gclid",
      "ref",
      "source",
      "session"
    ];

    blockedParams.forEach(param =>
      url.searchParams.delete(param)
    );

    const sorted = new URLSearchParams(
      [...url.searchParams.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
    );

    url.search = sorted.toString();

    let normalized = url.toString();
    if (normalized.endsWith("/"))
      normalized = normalized.slice(0, -1);

    return normalized;
  } catch {
    return null;
  }
}