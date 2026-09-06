import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.js";
import { applyOp, type Json0Op } from "../../src/ot/apply.js";
import type { TripPlan } from "../../src/types.js";
import { reorderSectionItems } from "../../src/tools/reorder-section-items.js";
import { checklistTrip } from "../fixtures/checklist-trip.js";

function fresh(trip: TripPlan): TripPlan {
  return structuredClone(trip);
}

function makeFakeContext(trip: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
} {
  const submittedOps: Json0Op[][] = [];
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const ctx = {
    userId: 100,
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
      get: async () => entry.snapshot,
      getEntry: async () => entry,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;

  return { ctx, submittedOps };
}

function makeSampleTrip(): TripPlan {
  const base = fresh(checklistTrip);
  base.itinerary.sections = [
    {
      id: 1,
      type: "normal",
      mode: "placeList",
      heading: "Places to visit",
      date: null,
      blocks: [
        { id: 101, type: "note", text: { ops: [{ insert: "Alpha note\n" }] } },
        { id: 102, type: "note", text: { ops: [{ insert: "Beta note\n" }] } },
        { id: 103, type: "note", text: { ops: [{ insert: "Gamma note\n" }] } },
      ],
    },
  ];
  return base;
}

describe("reorderSectionItems — happy path", () => {
  it("reorders item by from_position and to_position using JSON0 ld + li ops", async () => {
    const trip = makeSampleTrip();
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      from_position: 3,
      to_position: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Reordered item from position 3 to position 1");
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]).toHaveLength(2);
    expect(submittedOps[0]![0]!.p).toEqual(["itinerary", "sections", 0, "blocks", 2]);
    expect((submittedOps[0]![0] as unknown as { ld: unknown }).ld).toBeDefined();
    expect(submittedOps[0]![1]!.p).toEqual(["itinerary", "sections", 0, "blocks", 0]);
    expect((submittedOps[0]![1] as unknown as { li: unknown }).li).toBeDefined();
  });

  it("reorders item by item_id and to_position", async () => {
    const trip = makeSampleTrip();
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      item_id: 103,
      to_position: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]).toHaveLength(2);
  });

  it("reorders item by text match and to_position", async () => {
    const trip = makeSampleTrip();
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      text: "Gamma",
      to_position: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]).toHaveLength(2);
  });

  it("reorders section items by explicit order array of IDs", async () => {
    const trip = makeSampleTrip();
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      order: [103, 101, 102],
    });

    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
  });
});

describe("reorderSectionItems — edge cases & error handling", () => {
  it("returns error if neither section nor day is specified", async () => {
    const trip = makeSampleTrip();
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      from_position: 1,
      to_position: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("specify either 'section' or 'day'");
  });

  it("returns error if section is not found", async () => {
    const trip = makeSampleTrip();
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Nonexistent Section",
      from_position: 1,
      to_position: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("returns error when section has no blocks", async () => {
    const trip = makeSampleTrip();
    trip.itinerary.sections[0]!.blocks = [];
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      from_position: 1,
      to_position: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("empty");
  });

  it("returns error when from_position is out of bounds (< 1)", async () => {
    const trip = makeSampleTrip();
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      from_position: 0,
      to_position: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("out of range");
  });

  it("returns error when from_position is out of bounds (> length)", async () => {
    const trip = makeSampleTrip();
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      from_position: 10,
      to_position: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("out of range");
  });

  it("returns error when to_position is out of bounds", async () => {
    const trip = makeSampleTrip();
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      from_position: 1,
      to_position: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("out of range");
  });

  it("returns error when item_id is not in section", async () => {
    const trip = makeSampleTrip();
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      item_id: 9999,
      to_position: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("returns error when text is not found in section", async () => {
    const trip = makeSampleTrip();
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      text: "Nonexistent text",
      to_position: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("handles from_position === to_position as no-op", async () => {
    const trip = makeSampleTrip();
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      from_position: 2,
      to_position: 2,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("already at position 2");
    expect(submittedOps).toHaveLength(0);
  });

  it("returns error when order array contains invalid ID or missing IDs", async () => {
    const trip = makeSampleTrip();
    const { ctx } = makeFakeContext(trip);
    const result = await reorderSectionItems(ctx, {
      trip_key: "sampletrip",
      section: "Places to visit",
      order: [101, 9999],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("does not match");
  });
});
