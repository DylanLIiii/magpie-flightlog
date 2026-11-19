import { startServer } from "./lib/server.mjs";
const app = await startServer({
  port: Number(process.env.FLIGHTLOG_PORT ?? 3467),
});
console.log(`Flightlog http://127.0.0.1:${app.port}/`);
