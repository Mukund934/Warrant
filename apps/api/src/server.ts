import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const allowedOrigin = process.env.WARRANT_ALLOWED_ORIGIN ?? "*";

createApp({ allowedOrigin }).listen(port, () => {
  console.log(`warrant api listening on http://localhost:${port} (in-memory, no database)`);
});
