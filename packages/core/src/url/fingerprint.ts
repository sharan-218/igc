export async function fingerprintUrl(
  normalizedUrl: string
): Promise<string> {

  const encoder = new TextEncoder();
  const data = encoder.encode(normalizedUrl);

  const hashBuffer =
    await crypto.subtle.digest("SHA-256", data);

  return Buffer
    .from(hashBuffer)
    .toString("hex");
}