function classifyStartupFailure(error) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("production requires ops_storage_driver=mysql")) return "CONFIG_STORAGE_DRIVER";
  if (message.includes("missing production variables")) return "CONFIG_REQUIRED_VARIABLES";
  if (message.includes("must be a production secret")) return "CONFIG_WEAK_SECRET";
  if (code === "ER_ACCESS_DENIED_ERROR") return "MYSQL_AUTH_FAILED";
  if (code === "ER_BAD_DB_ERROR") return "MYSQL_DATABASE_NOT_FOUND";
  if (code === "ER_DBACCESS_DENIED_ERROR") return "MYSQL_DATABASE_ACCESS_DENIED";
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return "MYSQL_UNREACHABLE";
  if (code.startsWith("ER_")) return "MYSQL_INITIALIZATION_FAILED";
  return "APPLICATION_STARTUP_FAILED";
}

try {
  await import("./dist/server/main.js");
} catch (error) {
  const failure = classifyStartupFailure(error);
  console.error(`[startup] fatal=${failure}. Revise Environment Variables y MySQL en hPanel.`);
  process.exitCode = 1;
}
