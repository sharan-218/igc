import bloom from "bloom-filters";
const { BloomFilter } = bloom;

export const urlBloom = BloomFilter.create(
  1_000_000,
  0.01       
);

export function seenUrl(hash: string): boolean {
  if (urlBloom.has(hash)) {
    return true;
  }

  urlBloom.add(hash);
  return false;
}