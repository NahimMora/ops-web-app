import { createApp } from "./app.js";
import { config } from "./config.js";
import { MemoryRepository, type Repository } from "./repository.js";
import { MySqlRepository } from "./mysql-repository.js";

const repository: Repository = config.storageDriver === "mysql" ? new MySqlRepository(config.db, config.autoMigrate) : new MemoryRepository();
await repository.initialize(config.bootstrap);
const app = await createApp(repository);

const reaper = setInterval(async () => {
  try { const count = await repository.reapExpired(new Date().toISOString()); if (count) app.log.warn({ count }, "expired command leases recovered"); }
  catch (error) { app.log.error({ err: error }, "command lease reaper failed"); }
}, 30_000);
reaper.unref();

const shutdown = async () => { clearInterval(reaper); await app.close(); await repository.close(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);

try { await app.listen({ host: "0.0.0.0", port: config.port }); }
catch (error) { app.log.fatal(error); await repository.close(); process.exit(1); }
