import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const entrypoint = resolve(import.meta.dirname, "..", "server.js");
const source = await readFile(entrypoint, "utf8");
const failures = [];
const serverImport = 'import("./dist/server/main.js")';
const dbHostNormalization = 'process.env.DB_HOST = "127.0.0.1"';
const hashNormalization = String.raw`replaceAll("\\$", "$")`;

if (/\bawait\s+import\s*\(\s*["']\.\/dist\/server\/main\.js["']\s*\)/.test(source)) {
  failures.push("server.js must not use top-level await for the server import");
}
if (!source.includes(serverImport)) {
  failures.push("server.js must dynamically import ./dist/server/main.js");
}
if (!source.includes(dbHostNormalization)) {
  failures.push("server.js must normalize DB_HOST to 127.0.0.1");
}
if (!source.includes('process.env.DB_HOST === "localhost"') || !source.includes('process.env.DB_HOST === "::1"')) {
  failures.push("server.js must normalize both localhost and ::1");
}
if (!source.includes("OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH") || !source.includes(hashNormalization)) {
  failures.push("server.js must normalize escaped bootstrap admin password hash separators");
}

const startupOrder = [
  source.indexOf(dbHostNormalization),
  source.indexOf(hashNormalization),
  source.indexOf('console.info("[startup] entry=server.js")'),
  source.indexOf(serverImport),
];
if (startupOrder.some((position) => position < 0) || startupOrder.some((position, index) => index > 0 && position <= startupOrder[index - 1])) {
  failures.push("server.js startup normalization and import order is invalid");
}

for (const diagnostic of ["admin_hash_present", "admin_hash_length", "admin_hash_parts", "admin_hash_segment_lengths", "admin_hash_quoted"]) {
  if (source.includes(diagnostic)) failures.push(`server.js contains forbidden temporary diagnostic: ${diagnostic}`);
}

if (failures.length) {
  for (const failure of failures) console.error(`[check:hostinger] ${failure}`);
  process.exit(1);
}
console.log("[check:hostinger] entrypoint and environment normalization are compatible with LiteSpeed require()");
