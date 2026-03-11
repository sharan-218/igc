import {
  normalizeUrl,
  fingerprintUrl,
  seenUrl
} from "@core/url";

async function test() {
  const url =
    "https://Example.com/product?id=1&utm_source=ads";

  const normalized = normalizeUrl(url);
  if (!normalized) return;

  const hash = await fingerprintUrl(normalized);

  if (seenUrl(hash)) {
    console.log("Duplicate");
    return;
  }

  console.log("New URL:", normalized);
}

test();