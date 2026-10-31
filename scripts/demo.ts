import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreServer as createServer } from "../server/core-http.ts";
import { demoRoot } from "./demo-seed.ts";
import { attachDailyBackups } from "../server/backup-service.ts";

// This launcher never reads private local.config.json or starts a companion.
const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.VORTON_DEMO_PORT || 47840);
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  [47833, 32774].includes(port)
)
  throw new Error("Invalid or reserved demo port");
const { server, backups, ready, close } = createServer({
  root: demoRoot,
  port,
  dist: path.join(root, "dist"),
  enabledProfiles: ["LastResort"],
  defaultPath: "/lastresort/bridge",
});
attachDailyBackups(server, backups);
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
try {
  await ready();
  server.listen(port, "127.0.0.1", () =>
    console.log(`The Last Resort: http://127.0.0.1:${port}/lastresort/bridge`),
  );
} catch (error) { await close(); throw error; }
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close());
