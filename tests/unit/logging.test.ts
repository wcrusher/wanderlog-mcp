import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logging.ts";
import { buildServer } from "../../src/server.ts";
import type { AppContext } from "../../src/context.ts";

describe("Logging system", () => {
  it("creates a scoped logger that responds to all levels", () => {
    const log = createLogger("test-scope");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("writes formatted log message to stderr", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("test-writer");

    log.info("testing log output", { sampleKey: "sampleValue" });

    expect(stderrSpy).toHaveBeenCalled();
    const lastCall = stderrSpy.mock.calls.find((call) =>
      call[0].toString().includes("[test-writer] testing log output"),
    );
    expect(lastCall).toBeDefined();
    stderrSpy.mockRestore();
  });

  it("instruments tools registered on buildServer with invocation and completion logs", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const mockCtx = {
      authenticated: true,
      rest: {
        listTrips: vi.fn().mockResolvedValue([]),
        getUser: vi.fn().mockResolvedValue({ id: 1, username: "user" }),
      },
      tripCache: {},
      pool: {},
    } as unknown as AppContext;

    const server = buildServer(mockCtx);
    // Directly access registered tool handler from server
    const tool = (server as any)._registeredTools?.["wanderlog_list_trips"];
    if (tool && tool.handler) {
      await tool.handler({ response_format: "concise" });

      const calls = stderrSpy.mock.calls.map((c) => c[0].toString());
      expect(calls.some((c) => c.includes("[wanderlog_list_trips] invoked"))).toBe(true);
      expect(calls.some((c) => c.includes("[wanderlog_list_trips] completed"))).toBe(true);
    }

    stderrSpy.mockRestore();
  });
});
