import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".secrets", "hostinger.env");
const credentialsPath = resolve(root, ".secrets", "ADMIN_CREDENTIALS.txt");

function pick(chars) { return chars[randomBytes(1)[0] % chars.length]; }
function randomPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789"; const symbols = "!@#%_-+="; const all = upper + lower + digits + symbols;
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < 28) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = randomBytes(1)[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

function scrypt(password, salt) {
  return new Promise((resolvePromise, reject) => scryptCallback(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolvePromise(value)));
}

const password = randomPassword();
const salt = randomBytes(16);
const derived = await scrypt(password, salt);
const hash = `scrypt$32768$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
const currentEnv = await readFile(envPath, "utf8");
if (!/^OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH=.*$/m.test(currentEnv)) throw new Error("OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH is missing from hostinger.env");
const nextEnv = currentEnv.replace(/^OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH=.*$/m, `OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH=${hash}`);
const credentials = [
  "HOLA SALTA OPS - CREDENCIALES ADMIN ROTADAS",
  "Guardar en un gestor de contrasenas y eliminar este archivo cuando se haya respaldado.", "",
  "URL: https://ops.holasalta.com", "Email: holasalta@acceso.com", `Password: ${password}`, "",
  "Primer ingreso: dejar Codigo 2FA vacio. Activarlo luego desde Seguridad.", "",
].join("\n");

await Promise.all([
  writeFile(envPath, nextEnv, { encoding: "utf8", mode: 0o600 }),
  writeFile(credentialsPath, credentials, { encoding: "utf8", mode: 0o600 }),
]);
await Promise.all([envPath, credentialsPath].map((path) => chmod(path, 0o600).catch(() => undefined)));
console.log("Credencial admin rotada localmente. Valores ocultos; sincronice el hash de hostinger.env en hPanel.");
