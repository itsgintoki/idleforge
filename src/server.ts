import { createApp } from "./app.js";
import { envSchema } from "./config.js";
import { createDatabase } from "./db/client.js";
import { signup } from "./auth/signup.js";

const config = envSchema.parse(process.env);
const port = config.PORT;
const { db, pool } = createDatabase(config.DATABASE_URL);
const app = createApp({ signup: (input) => signup(db, input) });

pool.on("error", () => console.error("Unexpected idle database connection failure"));

const server = app.listen(port, () => {
    console.log(`IdleForge listening on port ${port}`);
});

function shutdown() {
  server.close(() => {
    void pool.end().catch(() => {
      console.error("Database shutdown failed");
      process.exitCode = 1;
    });
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
