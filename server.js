function classifyStartupFailure(error) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("production requires ops_storage_driver=mysql")) return "CONFIG_STORAGE_DRIVER";
  if (message.includes("missing production variables")) return "CONFIG_REQUIRED_VARIABLES";
  if (message.includes("must be a production secret")) return "CONFIG_WEAK_SECRET";
  if (message.includes("invalid bootstrap admin password hash")) return "CONFIG_INVALID_VARIABLES";
  if (error?.name === "ZodError") return "CONFIG_INVALID_VARIABLES";
  if (code === "ER_ACCESS_DENIED_ERROR") return "MYSQL_AUTH_FAILED";
  if (code === "ER_BAD_DB_ERROR") return "MYSQL_DATABASE_NOT_FOUND";
  if (code === "ER_DBACCESS_DENIED_ERROR") return "MYSQL_DATABASE_ACCESS_DENIED";
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return "MYSQL_UNREACHABLE";
  if (code.startsWith("ER_")) return "MYSQL_INITIALIZATION_FAILED";
  return "APPLICATION_STARTUP_FAILED";
}

if (process.env.DB_HOST === "localhost" || process.env.DB_HOST === "::1") {
  process.env.DB_HOST = "127.0.0.1";
}

console.info("[startup] entry=server.js");
import("./dist/server/main.js")
  .then(() => {
    console.info("[startup] server=ready");
  })
  .catch((error) => {
    const failure = classifyStartupFailure(error);
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN";
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error(`[startup] fatal=${failure}. Revise Environment Variables y MySQL en hPanel.`);
    console.error(`[startup] cause_name=${name} cause_code=${code}`);
    process.exit(1);
  });
