#!/usr/bin/env node
import type { AppContext } from "./context.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { WanderlogError } from "./errors.js";
import { createLogger } from "./logging.js";
import { buildServer } from "./server.js";

const log = createLogger("wanderdog");

async function main() {
  let ctx: AppContext;
  try {
    ctx = createContext();
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : (err as Error).message;
    log.error(`startup failed: ${msg}`);
    process.exit(1);
  }

  try {
    const user = await ctx.rest.getUser();
    ctx.userId = user.id;
    ctx.authenticated = true;
    log.info(`authenticated as ${user.username} (${user.id})`);
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : (err as Error).message;
    log.warn(
      `auth probe failed: ${msg}; server will start but all tools will require valid credentials`,
    );
  }

  const server = buildServer(ctx);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    ctx.pool.closeAll();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  log.info("ready (stdio)");
}

main().catch((err) => {
  log.error(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
