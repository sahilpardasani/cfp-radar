/** Extract text from an uploaded PDF buffer using pdf-parse. */
export async function extractPdfText(buffer) {
  // pdf-parse ships an index that runs a self-test on import; import the lib file directly.
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const data = await pdfParse(buffer);
  return {
    text: data.text || "",
    numPages: data.numpages || null,
    info: data.info || {},
  };
}

/**
 * Heuristic extraction of URLs and DOIs from paper text. Used as a fallback and
 * to cross-check whatever the LLM extracts.
 */
export function extractLinksAndDois(text) {
  const urls = new Set();
  const dois = new Set();

  const urlRe = /https?:\/\/[^\s)<>\]}"']+/gi;
  for (const m of text.matchAll(urlRe)) {
    urls.add(m[0].replace(/[.,;:)\]]+$/, ""));
  }
  const doiRe = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
  for (const m of text.matchAll(doiRe)) {
    dois.add(m[0].replace(/[.,;:)\]]+$/, ""));
  }
  return { urls: [...urls], dois: [...dois] };
}
