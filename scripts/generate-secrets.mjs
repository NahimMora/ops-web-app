import { createHmac, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const secretsDir = resolve(root, ".secrets");
const force = process.argv.includes("--force");

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function randomPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#%_-+=";
  const all = upper + lower + digits + symbols;
  const pick = (chars) => chars[randomBytes(1)[0] % chars.length];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < 28) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function scrypt(password, salt, length, options) {
  return new Promise((resolvePromise, reject) => {
    scryptCallback(password, salt, length, options, (error, value) => error ? reject(error) : resolvePromise(value));
  });
}

async function passwordHash(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

await mkdir(secretsDir, { recursive: true, mode: 0o700 });
const files = ["hostinger.env", "agent.env", "ADMIN_CREDENTIALS.txt"].map((name) => resolve(secretsDir, name));
if (!force && (await Promise.all(files.map(exists))).some(Boolean)) {
  throw new Error("Ya existen credenciales. Use --force solo si desea rotarlas de forma coordinada.");
}

const adminPassword = randomPassword();
const adminHash = await passwordHash(adminPassword);
const agentToken = randomBytes(48).toString("base64url");
const sessionSecret = randomBytes(48).toString("base64url");
const totpKey = randomBytes(48).toString("base64url");
const pepper = randomBytes(48).toString("base64url");
const agentTokenHash = createHmac("sha256", pepper).update(agentToken).digest("hex");

const hostinger = [
  "# Copiar en Hostinger hPanel > Variables de entorno. No subir a Git.",
  "NODE_ENV=production",
  "OPS_APP_URL=https://ops.holasalta.com",
  "OPS_STORAGE_DRIVER=mysql",
  "OPS_DB_AUTO_MIGRATE=true",
  "DB_HOST=127.0.0.1",
  "DB_PORT=3306",
  "DB_USER=REEMPLAZAR_CON_USUARIO_MYSQL_HOSTINGER",
  "DB_PASSWORD=REEMPLAZAR_CON_PASSWORD_MYSQL_HOSTINGER",
  "DB_NAME=REEMPLAZAR_CON_BASE_MYSQL_HOSTINGER",
  `OPS_SESSION_SECRET=${sessionSecret}`,
  `OPS_TOTP_ENCRYPTION_KEY=${totpKey}`,
  `OPS_TOKEN_PEPPER=${pepper}`,
  "OPS_BOOTSTRAP_ADMIN_EMAIL=holasalta@acceso.com",
  `OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH=${adminHash}`,
  "OPS_BOOTSTRAP_AGENT_ID=pc-holasalta-01",
  "OPS_BOOTSTRAP_AGENT_NAME=PC HolaSalta",
  `OPS_BOOTSTRAP_AGENT_TOKEN_HASH=${agentTokenHash}`,
  "OPS_SESSION_TTL_HOURS=12",
  "OPS_COMMAND_RETENTION_DAYS=90",
  "OPS_LOG_LEVEL=info",
  "",
].join("\n");

const agent = [
  "# Solo PC local. El agente tambien carga D:\\WebApp_HolaSalta\\backend\\.env sin sobreescribir valores.",
  "OPS_AGENT_SERVER_URL=https://ops.holasalta.com",
  "OPS_AGENT_ID=pc-holasalta-01",
  `OPS_AGENT_TOKEN=${agentToken}`,
  "OPS_AGENT_POLL_MS=5000",
  "OPS_AGENT_HEARTBEAT_MS=10000",
  "OPS_LOCAL_API_URL=http://127.0.0.1:8000",
  "OPS_LOCAL_API_USERNAME=admin",
  "OPS_LOCAL_BACKEND_ENV_PATH=D:\\WebApp_HolaSalta\\backend\\.env",
  "OPS_AGENT_STATE_DIR=D:\\Ops\\agent-state",
  "OPS_R2_VIDEO_PREFIX=ops/videos",
  "",
].join("\n");

const credentials = [
  "HOLA SALTA OPS - CREDENCIALES INICIALES",
  "Guardar en un gestor de contrasenas y eliminar este archivo cuando se haya respaldado.",
  "",
  "URL: https://ops.holasalta.com",
  "Email: holasalta@acceso.com",
  `Password inicial: ${adminPassword}`,
  "",
  "En el primer ingreso: Configuracion > preparar y activar TOTP.",
  "",
].join("\n");

await Promise.all([
  writeFile(files[0], hostinger, { encoding: "utf8", mode: 0o600 }),
  writeFile(files[1], agent, { encoding: "utf8", mode: 0o600 }),
  writeFile(files[2], credentials, { encoding: "utf8", mode: 0o600 }),
]);
await Promise.all(files.map((path) => chmod(path, 0o600).catch(() => undefined)));
console.log("Credenciales generadas dentro de .secrets (valores ocultos). Consulte docs/DEPLOY_HOSTINGER.md.");
