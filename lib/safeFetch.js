import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home"];

function normalizeHostname(hostname) {
  return String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPublicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Words(address) {
  let compact = normalizeHostname(address).split("%")[0];
  if (!compact || compact.split("::").length > 2) return null;

  // Convert a dotted IPv4 tail before expanding the compressed IPv6 form.
  if (compact.includes(".")) {
    const separator = compact.lastIndexOf(":");
    const tail = compact.slice(separator + 1);
    const parts = tail.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    compact = `${compact.slice(0, separator)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }

  const hasCompression = compact.includes("::");
  const [leftRaw, rightRaw = ""] = compact.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const missing = 8 - left.length - right.length;
  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return null;
  const words = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
  return words.length === 8 ? words : null;
}

function isPublicIpv6(address) {
  const words = ipv6Words(address);
  if (!words) return false;
  const [a, b, c, d, e, f, g, h] = words;

  // Unspecified, loopback, IPv4-compatible, and IPv4-mapped addresses can
  // otherwise disguise a private IPv4 target (for example ::ffff:7f00:1).
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff)) return false;
  if ((a & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return false; // deprecated site-local fec0::/10
  if ((a & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (a === 0x2001 && b === 0x0db8) return false; // documentation 2001:db8::/32
  if (a === 0x2001 && b === 0) return false; // Teredo 2001::/32
  if (a === 0x2002) return false; // 6to4 can tunnel to an embedded private IPv4 address
  if (a === 0x0064 && b === 0xff9b) return false; // NAT64 well-known/local-use prefixes

  // Public IPv6 unicast space is 2000::/3. Reject unallocated/special ranges
  // by default instead of trying to maintain an unsafe allow-by-exception list.
  void c; void d; void e; void g; void h;
  return (a & 0xe000) === 0x2000;
}

function isPublicIp(address) {
  const normalized = normalizeHostname(address).split("%")[0];
  const family = net.isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  return family === 6 ? isPublicIpv6(normalized) : false;
}

async function resolveRemoteUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("Enter a valid http or https URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Only standard web ports are allowed.");

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || BLOCKED_HOSTS.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("Local or private network addresses are not allowed.");
  }

  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error("Local or private network addresses are not allowed.");
    return { url, addresses: [{ address: hostname, family: net.isIP(hostname) }] };
  } else {
    let addresses;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("The URL hostname could not be resolved.");
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
      throw new Error("The URL resolves to a local or private network address.");
    }
    return { url, addresses };
  }
}

/** Validate a user-controlled remote URL before it reaches the network. */
export async function validateRemoteUrl(rawUrl) {
  return (await resolveRemoteUrl(rawUrl)).url;
}

function pinnedLookup(addresses) {
  let cursor = 0;
  return (_hostname, options, callback) => {
    const settings = typeof options === "number" ? { family: options } : (options || {});
    const eligible = settings.family
      ? addresses.filter(({ family }) => family === settings.family)
      : addresses;
    if (!eligible.length) {
      const error = new Error("The approved hostname has no address in the requested IP family.");
      error.code = "ENOTFOUND";
      callback(error);
      return;
    }
    if (settings.all) {
      callback(null, eligible.map(({ address, family }) => ({ address, family })));
      return;
    }
    const selected = eligible[cursor % eligible.length];
    cursor += 1;
    callback(null, selected.address, selected.family);
  };
}

function responseHeaders(rawHeaders) {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (key && value !== undefined) headers.append(key, value);
  }
  return headers;
}

/**
 * Make one request using only the public IP addresses validated above.
 * `agent: false` prevents a pooled socket from being reused for a different
 * validation decision. TLS still authenticates the original hostname.
 */
function requestPinned(url, addresses, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const signal = AbortSignal.timeout(timeoutMs);
    const request = transport.request(url, {
      method,
      headers,
      agent: false,
      signal,
      lookup: pinnedLookup(addresses),
    }, (incoming) => {
      const status = incoming.statusCode || 500;
      const bodyForbidden = method === "HEAD" || [101, 204, 205, 304].includes(status);
      if (bodyForbidden) incoming.resume();
      const response = new Response(
        bodyForbidden ? null : Readable.toWeb(incoming),
        {
          status,
          statusText: incoming.statusMessage || "",
          headers: responseHeaders(incoming.rawHeaders),
        }
      );
      resolve(response);
    });
    request.on("error", reject);
    if (body === undefined || body === null) {
      request.end();
    } else if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
      request.end(body);
    } else {
      request.destroy(new Error("Only string or byte request bodies are supported for remote fetches."));
    }
  });
}

/**
 * Fetch a remote web URL while validating every redirect hop.
 * Redirects are manual so an allowed public URL cannot bounce into a private service.
 */
export async function fetchRemote(rawUrl, options = {}) {
  const {
    timeoutMs = 20_000,
    maxRedirects = 4,
    headers,
    method = "GET",
    body,
  } = options;
  let resolved = await resolveRemoteUrl(rawUrl);
  let currentMethod = method;
  let currentBody = body;
  const boundedTimeout = Math.max(1_000, Math.min(Number(timeoutMs) || 20_000, 60_000));

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await requestPinned(resolved.url, resolved.addresses, {
      method: currentMethod,
      body: currentBody,
      headers,
      timeoutMs: boundedTimeout,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: resolved.url.toString() };
    if (redirect === maxRedirects) {
      await response.body?.cancel().catch(() => {});
      throw new Error("The URL redirected too many times.");
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error("The URL returned an invalid redirect.");
    resolved = await resolveRemoteUrl(new URL(location, resolved.url).toString());
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
      currentBody = undefined;
    }
  }
  throw new Error("The URL could not be fetched.");
}

export async function readResponseBuffer(response, maxBytes = 12 * 1024 * 1024) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("The remote file is too large.");
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error("The remote file is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export async function readResponseText(response, maxBytes = 2 * 1024 * 1024) {
  return (await readResponseBuffer(response, maxBytes)).toString("utf8");
}
