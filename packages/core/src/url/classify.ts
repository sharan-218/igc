export type UrlType =
  | "detail"
  | "listing"
  | "article"
  | "unknown";

export function classifyUrl(url: string): UrlType {

  if (/\/product|item|detail/i.test(url))
    return "detail";

  if (/page=|category|list/i.test(url))
    return "listing";

  if (/blog|news|article/i.test(url))
    return "article";

  return "unknown";
}