import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { health } from "./routes/health";
import { oracle } from "./routes/oracle";
import { auth } from "./routes/auth";
import { stake } from "./routes/stake";
import { ai } from "./routes/ai";
import { lottery } from "./routes/lottery";
import { burn } from "./routes/burn";
import { referral } from "./routes/referral";
import { portfolio } from "./routes/portfolio";
import { admin } from "./routes/admin";
import { testControl } from "./routes/test-control";
import { runCron } from "./cron";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", maxAge: 600 }));
app.route("/health", health);
app.route("/oracle", oracle);
app.route("/auth", auth);
app.route("/stake", stake);
app.route("/ai", ai);
app.route("/lottery", lottery);
app.route("/burn", burn);
app.route("/referral", referral);
app.route("/portfolio", portfolio);
app.route("/admin", admin);
app.route("/__test", testControl);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runCron(event, env));
  },
};
