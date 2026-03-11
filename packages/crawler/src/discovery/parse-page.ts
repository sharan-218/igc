import * as cheerio from "cheerio";

export interface ParsedPage {
  title: string;
  description: string;
  h1: string;
  bodyText: string;
}

/**
 * Parse an HTML string with Cheerio and extract structured metadata.
 * This is the only place we touch the HTML DOM — keeps all Cheerio usage
 * centralised and easy to extend (add OG tags, schema.org, etc.).
 */
export function parsePage(html: string): ParsedPage {
  const $ = cheerio.load(html);

  $("script, style, noscript, iframe, svg").remove();

  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const h1 = $("h1").first().text().trim();

  const contentEl = $("main").length
    ? $("main")
    : $("article").length
      ? $("article")
      : $("body");

  const bodyText = contentEl
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5_000);

  return { title, description, h1, bodyText };
}
