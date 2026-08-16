import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.js";
import type { Json0Op } from "../../src/ot/apply.js";
import type { TripPlan } from "../../src/types.js";
import { removeChecklist } from "../../src/tools/remove-checklist.js";
import { checklistTrip } from "../fixtures/checklist-trip.js";

function fresh(trip: TripPlan): TripPlan {
  return structuredClone(trip);
}

function makeFakeContext(trip: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
} {
  const submittedOps: Json0Op[][] = [];
  const ctx = {
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      get: async () => structuredClone(trip),
      applyLocalOp: () => {},
      invalidate: () => {},
    },
  } as unknown as AppContext;

  return { ctx, submittedOps };
}

describe("removeChecklist — happy path & error cases", () => {
  it("removes a checklist by title match", async () => {
    const trip = fresh(checklistTrip);
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeChecklist(ctx, {
      trip_key: "checklisttripkey",
      checklist_ref: "Packing list",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Removed checklist");
    expect(submittedOps).toHaveLength(1);
  });

  it("removes a checklist by block id", async () => {
    const trip = fresh(checklistTrip);
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeChecklist(ctx, {
      trip_key: "checklisttripkey",
      checklist_id: 60003,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Removed checklist");
    expect(submittedOps).toHaveLength(1);
  });

  it("returns error when checklist is not found", async () => {
    const trip = fresh(checklistTrip);
    const { ctx } = makeFakeContext(trip);
    const result = await removeChecklist(ctx, {
      trip_key: "checklisttripkey",
      checklist_ref: "Nonexistent Checklist",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });
});
