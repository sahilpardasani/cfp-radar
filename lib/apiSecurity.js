import { NextResponse } from "next/server.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 13 * 1024 * 1024;

const globalState = globalThis;
const buckets = globalState.__cfpRadarRateBuckets || new Map();
globalState.__cfpRadarRateBuckets = buckets;

function requestIp(req) {
  // Use the right-most forwarded address: a trusted edge appends the real
  // connection address, whereas the left-most value can be supplied by a
  // client attempting to rotate its rate-limit key.
  const forwarded = (req.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates = [
    ...forwarded.reverse(),
    req.headers.get("x-real-ip")?.trim(),
    req.headers.get("cf-connecting-ip")?.trim(),
  ];
  return candidates.find((value) => isIP(value)) || "unknown";
}

function pruneBuckets(now) {
  if (buckets.size < 5_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  while (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
}

/** Best-effort per-instance protection for public, computationally expensive routes. */
export function guardExpensiveRequest(req, scope, { limit = 20, windowMs = 60 * 60 * 1000 } = {}) {
  const origin = req.headers.get("origin");
  const expectedHost = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  let foreignOrigin = false;
  if (origin && expectedHost) {
    try {
      foreignOrigin = new URL(origin).host !== expectedHost;
    } catch {
      foreignOrigin = true;
    }
  }
  if (req.headers.get("sec-fetch-site") === "cross-site" || foreignOrigin) {
    return NextResponse.json(
      { error: "Cross-site requests are not allowed." },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  const now = Date.now();
  pruneBuckets(now);
  const key = `${scope}:${requestIp(req)}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= limit) return null;

  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return NextResponse.json(
    { error: "Too many requests. Please wait before trying this operation again." },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } }
  );
}

/** Read and parse multipart form data without allowing an unbounded request body. */
export async function parseLimitedFormData(req, maxBytes = MAX_REQUEST_BYTES) {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data") && !contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new Error("This endpoint requires form data.");
  }
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("The upload is too large.");
  if (!req.body) return req.formData();

  const chunks = [];
  let total = 0;
  for await (const chunk of req.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("The upload is too large.");
    chunks.push(buffer);
  }
  const request = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: Buffer.concat(chunks, total),
  });
  return request.formData();
}

export function safeErrorMessage(error, fallback) {
  const message = String(error?.message || "");
  const expected = [
    "too large", "valid http", "Only http", "credentials", "standard web ports",
    "private network", "hostname could not be resolved", "redirected too many",
    "invalid redirect", "Could not fetch", "Could not read", "Only PDF",
    "not a valid PDF", "too many pages", "did not return a valid PDF", "requires form data",
  ];
  return expected.some((part) => message.includes(part)) ? message : fallback;
}

export function apiErrorResponse(error, fallback) {
  const message = safeErrorMessage(error, fallback);
  return NextResponse.json({ error: message }, { status: message === fallback ? 500 : 400 });
}

export function requireAdminToken(req) {
  const expected = process.env.PIPELINE_ADMIN_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "This batch operation is disabled on the public API." }, { status: 403 });
  }
  const authorization = req.headers.get("authorization") || "";
  const supplied = req.headers.get("x-cfp-admin-token") || authorization.replace(/^Bearer\s+/i, "");
  // Compare fixed-length digests so the response does not reveal the configured
  // token length and timingSafeEqual is always used with equal-size buffers.
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(suppliedDigest, expectedDigest)) {
    return NextResponse.json({ error: "Administrative authorization is required." }, { status: 401 });
  }
  return null;
}
