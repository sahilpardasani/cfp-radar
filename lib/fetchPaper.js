/**
 * Paper-fetch agent.
 *
 * Lets the recommender read a paper that lives at a URL (not just an uploaded PDF).
 * Handles:
 *   - arXiv links (/abs/ or /pdf/ → the PDF)
 *   - direct PDF links
 *   - HTML landing pages (strip to text)
 * Returns { text, kind, finalUrl }.
 */
import { extractPdfText } from "./pdf.js";
import { fetchRemote, readResponseBuffer, readResponseText } from "./safeFetch.js";

function normalizeArxiv(url) {
  // https://arxiv.org/abs/2401.12345  ->  https://arxiv.org/pdf/2401.12345.pdf
  const m = url.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(v\d+)?)/i);
  if (m) return `https://arxiv.org/pdf/${m[1].replace(/\.pdf$/i, "")}.pdf`;
  return url;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchPaper(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  url = normalizeArxiv(url);

  const { response: res, finalUrl } = await fetchRemote(url, {
    headers: { "User-Agent": "CFP-Radar-PaperFetch/1.0", Accept: "application/pdf,text/html,*/*" },
    timeoutMs: 30000,
  });
  if (!res.ok) throw new Error(`Could not fetch the paper URL (HTTP ${res.status}).`);

  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  const isPdf = ctype.includes("application/pdf") || /\.pdf($|\?)/i.test(url);

  if (isPdf) {
    const buf = await readResponseBuffer(res, 12 * 1024 * 1024);
    if (buf.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The paper URL did not return a valid PDF.");
    const parsed = await extractPdfText(buf);
    if (parsed.numPages && parsed.numPages > 250) throw new Error("The remote PDF has too many pages.");
    return { text: parsed.text.slice(0, 100_000), kind: "pdf", finalUrl };
  }

  const html = await readResponseText(res, 2 * 1024 * 1024);
  const text = htmlToText(html);
  return { text: text.slice(0, 100_000), kind: "html", finalUrl };
}
