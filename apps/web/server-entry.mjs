// Production entry: wrap the built TanStack Start handler in an h3 node server.
import { serve } from "h3-v2";
import handler from "./dist/server/server.js";

const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? 3000);
serve(handler, { port });
console.log(`web listening on :${port}`);
