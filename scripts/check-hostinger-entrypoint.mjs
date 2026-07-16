import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const entrypoint = resolve(import.meta.dirname, "..", "server.js");
const source = await readFile(entrypoint, "utf8");
const failures = [];

if (/\bawait\s+import\s*\(\s*["']\.\/dist\/server\/main\.js["']\s*\)/.test(source)) {
  failures.push("server.js must not use top-level await for the server import");
}
if (!/\bimport\s*\(\s*["']\.\/dist\/server\/main\.js["']\s*\)/.test(source)) {
  failures.push("server.js must dynamically import ./dist/server/main.js");
}
if (!source.includes('process.env.DB_HOST = "127.0.0.1"')) {
  failures.push("server.js must normalize DB_HOST to 127.0.0.1");
}
if (!source.includes('process.env.DB_HOST === "localhost"') || !source.includes('process.env.DB_HOST === "::1"')) {
  failures.push("server.js must normalize both localhost and ::1");
}

if (failures.length) {
  for (const failure of failures) console.error(`[check:hostinger] ${failure}`);
  process.exit(1);
}
console.log("[check:hostinger] entrypoint compatible with LiteSpeed require()");
