import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import type { Json0Op } from "../../src/ot/apply.ts";
import type { TripPlan } from "../../src/types.ts";
import {
  extractPlainText,
  findNoteMatches,
  removeNote,
} from "../../src/tools/remove-note.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";
import { mixedBlocksTrip } from "../fixtures/mixed-blocks-trip.ts";

function fresh(trip: TripPlan): TripPlan {
  return structuredClone(trip);
}

function makeFakeContext(trip: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
  invalidateCount: { value: number };
} {
  const submittedOps: Json0Op[][] = [];
  const invalidateCount = { value: 0 };

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
      invalidate: () => {
        invalidateCount.value++;
      },
    },
  } as unknown as AppContext;

  return { ctx, submittedOps, invalidateCount };
}

// ---------------------------------------------------------------------------
// extractPlainText
// ---------------------------------------------------------------------------

describe("extractPlainText", () => {
  it("joins all insert strings from delta ops", () => {
    const block = {
      id: 1,
      type: "note" as const,
      text: {
        ops: [
          { insert: "Check out the " },
          { insert: "Nakamise shopping street", attributes: { link: "https://example.com" } },
          { insert: " before heading to the temple.\n" },
        ],
      },
    };
    expect(extractPlainText(block)).toBe(
      "Check out the Nakamise shopping street before heading to the temple.\n",
    );
  });

  it("skips embed ops (non-string inserts)", () => {
    const block = {
      id: 1,
      type: "note" as const,
      text: {
        ops: [
          { insert: "Before " },
          { insert: { image: "https://example.com/img.jpg" } as unknown as string },
          { insert: "after\n" },
        ],
      },
    };
    expect(extractPlainText(block)).toBe("Before after\n");
  });

  it("handles unicode checkbox characters and brackets", () => {
    const block = {
      id: 1,
      type: "note" as const,
      text: {
        ops: [
          { insert: "☑ Pre-departure checklist\n" },
          { insert: "[ ] Book Pokemon Cafe Tokyo\n" },
          { insert: "[ ] opens 31 days ahead, sells out in minutes\n" },
        ],
      },
    };
    const text = extractPlainText(block);
    expect(text).toContain("☑");
    expect(text.toLowerCase()).toContain("pre-departure checklist");
    expect(text.toLowerCase()).toContain("book pokemon cafe tokyo");
    expect(text.toLowerCase()).toContain("opens 31 days ahead");
  });

  it("returns empty string for missing text", () => {
    expect(extractPlainText({ id: 1, type: "note" as const })).toBe("");
  });

  it("returns empty string for empty ops array", () => {
    expect(extractPlainText({ id: 1, type: "note" as const, text: { ops: [] } })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findNoteMatches
// ---------------------------------------------------------------------------

describe("findNoteMatches", () => {
  it("returns empty array when no notes match", () => {
    const trip = fresh(checklistTrip);
    const result = findNoteMatches(trip, "xyz_impossible_match");
    expect(result).toHaveLength(0);
  });

  it("finds a matching note case-insensitively", () => {
    const trip = fresh(checklistTrip);
    const result = findNoteMatches(trip, "SUNSCREEN");
    expect(result).toHaveLength(1);
    expect(result[0]!.plainText).toContain("sunscreen");
  });

  it("finds notes with multi-op rich-text deltas (mixed-blocks fixture)", () => {
    const trip = fresh(mixedBlocksTrip);
    const result = findNoteMatches(trip, "nakamise");
    expect(result).toHaveLength(1);
    expect(result[0]!.plainText).toContain("Nakamise");
  });

  it("returns correct sectionIndex and blockIndex", () => {
    const trip = fresh(checklistTrip);
    const result = findNoteMatches(trip, "sunscreen");
    expect(result).toHaveLength(1);
    const { sectionIndex, blockIndex } = result[0]!;
    const section = trip.itinerary.sections[sectionIndex]!;
    const block = section.blocks[blockIndex]!;
    expect(block.type).toBe("note");
  });

  it("filters by day when day is specified", () => {
    const trip = fresh(checklistTrip);
    // The sunscreen note is on 2026-06-01 (day 1)
    const onDay1 = findNoteMatches(trip, "sunscreen", "day 1");
    expect(onDay1).toHaveLength(1);

    const onDay2 = findNoteMatches(trip, "sunscreen", "day 2");
    expect(onDay2).toHaveLength(0);
  });

  it("returns multiple matches when substring is broad", () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 10, type: "note", text: { ops: [{ insert: "Book the restaurant early\n" }] } },
              { id: 11, type: "note", text: { ops: [{ insert: "Book tickets online\n" }] } },
            ],
          },
        ],
      },
    };
    const result = findNoteMatches(trip, "book");
    expect(result).toHaveLength(2);
  });

  it("finds notes with unicode checkboxes via substring match", () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "dayPlan",
            heading: "",
            date: "2026-06-01",
            blocks: [
              {
                id: 99,
                type: "note",
                text: {
                  ops: [
                    { insert: "☑ Pre-departure checklist\n" },
                    { insert: "[ ] Book Pokemon Cafe Tokyo\n" },
                    { insert: "[ ] opens 31 days ahead, sells out in minutes\n" },
                  ],
                },
              },
            ],
          },
        ],
      },
    };
    expect(findNoteMatches(trip, "Pre-departure checklist")).toHaveLength(1);
    expect(findNoteMatches(trip, "Book Pokemon Cafe Tokyo")).toHaveLength(1);
    expect(findNoteMatches(trip, "opens 31 days ahead, sells out in minutes")).toHaveLength(1);
  });

  it("ignores non-note blocks", () => {
    const trip = fresh(checklistTrip);
    // "Park" is a place name, not a note — should not match
    const result = findNoteMatches(trip, "Park Güell");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// removeNote handler
// ---------------------------------------------------------------------------

describe("removeNote", () => {
  it("returns not-found error when no notes match", async () => {
    const { ctx } = makeFakeContext(checklistTrip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      text: "xyz_no_match_at_all",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("removes the matching note and returns confirmation", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      text: "sunscreen",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Removed note");
    expect(result.content[0]!.text).toContain("sunscreen");
    expect(submittedOps).toHaveLength(1);
    // The op must be an ld (list delete) — never expose raw paths in the response
    const op = submittedOps[0]![0] as { p: unknown[]; ld: unknown };
    expect(op.ld).toBeDefined();
    expect((op.ld as { type: string }).type).toBe("note");
  });

  it("returns ambiguous list when multiple notes match", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 10, type: "note", text: { ops: [{ insert: "Book the restaurant early\n" }] } },
              { id: 11, type: "note", text: { ops: [{ insert: "Book tickets online\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, { trip_key: "checklisttripkey", text: "book" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("matches 2 notes");
    expect(result.content[0]!.text).toContain("Book the restaurant");
    expect(result.content[0]!.text).toContain("Book tickets");
    expect(submittedOps).toHaveLength(0);
  });

  it("respects day filter in handler", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    // sunscreen note is on day 1 — filtering by day 2 should give not-found
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      text: "sunscreen",
      day: "day 2",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
    expect(submittedOps).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Enhancements: note_id (single & array), section filter, instance index, candidates formatting
  // ---------------------------------------------------------------------------

  it("removes note by single note_id", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 472680376, type: "note", text: { ops: [{ insert: "Identical note text\n" }] } },
              { id: 981273918, type: "note", text: { ops: [{ insert: "Identical note text\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      note_id: 472680376,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Removed note");
    expect(submittedOps).toHaveLength(1);
    const op = submittedOps[0]![0] as { p: (string | number)[]; ld: { id: number } };
    expect(op.ld.id).toBe(472680376);
  });

  it("removes multiple notes by array of note_ids in batch", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 100, type: "note", text: { ops: [{ insert: "Note 100\n" }] } },
              { id: 101, type: "note", text: { ops: [{ insert: "Note 101\n" }] } },
              { id: 102, type: "note", text: { ops: [{ insert: "Note 102\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      note_id: [100, 102],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Removed 2 notes");
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]).toHaveLength(2);
    // Ops should delete block index 2 first then block index 0 to preserve indices
    const op1 = submittedOps[0]![0] as { p: (string | number)[]; ld: { id: number } };
    const op2 = submittedOps[0]![1] as { p: (string | number)[]; ld: { id: number } };
    expect(op1.ld.id).toBe(102);
    expect(op2.ld.id).toBe(100);
  });

  it("filters notes by section heading", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 10, type: "note", text: { ops: [{ insert: "Breakfast place\n" }] } },
            ],
          },
          {
            id: 2,
            type: "normal",
            mode: "placeList",
            heading: "Milan Restaurants",
            date: null,
            blocks: [
              { id: 20, type: "note", text: { ops: [{ insert: "Breakfast place\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      text: "Breakfast",
      section: "Milan Restaurants",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Removed note");
    expect(submittedOps).toHaveLength(1);
    const op = submittedOps[0]![0] as { p: (string | number)[]; ld: { id: number } };
    expect(op.ld.id).toBe(20);
  });

  it("selects specific note by 1-based instance index", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 10, type: "note", text: { ops: [{ insert: "Duplicated note\n" }] } },
              { id: 20, type: "note", text: { ops: [{ insert: "Duplicated note\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      text: "Duplicated note",
      instance: 2,
    });
    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    const op = submittedOps[0]![0] as { p: (string | number)[]; ld: { id: number } };
    expect(op.ld.id).toBe(20);
  });

  it("formats candidates error with [ID: <id>] and section headings when multiple notes match", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 472680376, type: "note", text: { ops: [{ insert: "Breakfast place\n" }] } },
            ],
          },
          {
            id: 2,
            type: "normal",
            mode: "placeList",
            heading: "Milan Restaurants",
            date: null,
            blocks: [
              { id: 981273918, type: "note", text: { ops: [{ insert: "Breakfast place\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, { trip_key: "checklisttripkey", text: "Breakfast" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("[ID: 472680376] in \"Places to visit\"");
    expect(result.content[0]!.text).toContain("[ID: 981273918] in \"Milan Restaurants\"");
    expect(result.content[0]!.text).toContain("note_id");
    expect(submittedOps).toHaveLength(0);
  });

  // Edge cases
  it("returns error when neither text nor note_id is provided", async () => {
    const { ctx } = makeFakeContext(checklistTrip);
    const result = await removeNote(ctx, { trip_key: "checklisttripkey" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("provide either 'text' or 'note_id'");
  });

  it("returns error when single note_id does not exist", async () => {
    const { ctx } = makeFakeContext(checklistTrip);
    const result = await removeNote(ctx, { trip_key: "checklisttripkey", note_id: 999999 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("returns error when some IDs in note_id array are missing", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 100, type: "note", text: { ops: [{ insert: "Note 100\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      note_id: [100, 999999],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("999999");
    expect(submittedOps).toHaveLength(0);
  });

  it("returns error when instance index is out of bounds", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 10, type: "note", text: { ops: [{ insert: "Repeated\n" }] } },
              { id: 20, type: "note", text: { ops: [{ insert: "Repeated\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx } = makeFakeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      text: "Repeated",
      instance: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("out of range");
  });

  it("returns error when note_id exists but in a different section than section filter", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 100, type: "note", text: { ops: [{ insert: "In Places to visit\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx } = makeFakeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      note_id: 100,
      section: "Milan Restaurants",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("handles duplicate IDs in note_id array cleanly", async () => {
    const trip: TripPlan = {
      ...fresh(checklistTrip),
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [
              { id: 100, type: "note", text: { ops: [{ insert: "Note 100\n" }] } },
            ],
          },
        ],
      },
    };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: "checklisttripkey",
      note_id: [100, 100],
    });
    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]).toHaveLength(1);
  });
});
