export function databaseSslConfig(env = process.env) {
  const mode = String(env.DATABASE_SSL ?? "1").trim().toLowerCase();
  if (["0", "false", "disable"].includes(mode)) return false;

  const certificate = String(env.DATABASE_CA_CERT || "").replace(/\\n/g, "\n").trim();
  return certificate
    ? { ca: certificate, rejectUnauthorized: true }
    : { rejectUnauthorized: true };
}
