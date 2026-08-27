import { MAX_UPLOAD_BYTES } from "./apiSecurity.js";
import { fetchPaper } from "./fetchPaper.js";
import { extractPdfText } from "./pdf.js";

const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf", ""]);

export async function textFromPaperInput({ file, url, text = "", maxChars = 80_000 }) {
  let result = String(text || "");
  if (file && typeof file.arrayBuffer === "function" && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error("The PDF is too large. Upload a file smaller than 12 MB.");
    const type = String(file.type || "").toLowerCase();
    if (!PDF_MIME_TYPES.has(type) && !String(file.name || "").toLowerCase().endsWith(".pdf")) {
      throw new Error("Only PDF uploads are supported.");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The uploaded file is not a valid PDF.");
    const parsed = await extractPdfText(buffer);
    if (parsed.numPages && parsed.numPages > 250) throw new Error("The PDF has too many pages.");
    result = parsed.text;
  } else if (!result.trim() && url) {
    result = (await fetchPaper(url)).text;
  }
  return result.slice(0, maxChars);
}
