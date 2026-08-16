import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { addChecklist } from "../../src/tools/add-checklist.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { formatBlockLine } from "../../src/formatters/trip-summary.ts";
import {
  buildNoteBlock,
  buildChecklistBlock,
  findTargetSection,
} from "../../src/tools/shared.ts";
import type {
  Block,
  ChecklistBlock,
  NoteBlock,
  TripPlan,
} from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

function fresh(trip: TripPlan): TripPlan {
  return structuredClone(trip);
}

function makeFakeContext(trip: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
  tripState: TripPlan;
} {
  const tripState = structuredClone(trip);
  const submittedOps: Json0Op[][] = [];
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
      getEntry: async () => ({ snapshot: structuredClone(tripState) }),
      applyLocalOp: (key: string, ops: Json0Op[]) => {
        const next = applyOp(tripState, ops);
        tripState.itinerary = next.itinerary;
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, submittedOps, tripState };
}

// ---------------------------------------------------------------------------
// Builder tests
// ---------------------------------------------------------------------------

describe("buildNoteBlock", () => {
  it("produces the correct shape", () => {
    const block = buildNoteBlock(42);
    expect(block.type).toBe("note");
    expect(block.text).toEqual({ ops: [{ insert: "\n" }] });
    expect(block.addedBy).toEqual({ type: "user", userId: 42 });
    expect(block.attachments).toEqual([]);
    expect(typeof block.id).toBe("number");
  });

  it("generates unique IDs across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => buildNoteBlock(1).id));
    expect(ids.size).toBeGreaterThan(45);
  });
});

describe("buildChecklistBlock", () => {
  it("produces the correct shape with items", () => {
    const block = buildChecklistBlock(
      ["passport", "adapter", "sunscreen"],
      "Packing list",
      42,
    );
    expect(block.type).toBe("checklist");
    expect(block.title).toBe("Packing list");
    expect(block.addedBy).toEqual({ type: "user", userId: 42 });
    expect(block.attachments).toEqual([]);

    const items = block.items as Array<{
      id: number;
      checked: boolean;
      text: { ops: Array<{ insert: string }> };
    }>;
    expect(items).toHaveLength(3);
    expect(items[0]!.checked).toBe(false);
    expect(items[0]!.text).toEqual({ ops: [{ insert: "passport\n" }] });
    expect(items[1]!.text).toEqual({ ops: [{ insert: "adapter\n" }] });
    expect(items[2]!.text).toEqual({ ops: [{ insert: "sunscreen\n" }] });
  });

  it("each item gets a unique ID", () => {
    const block = buildChecklistBlock(["a", "b", "c", "d", "e"], "", 1);
    const items = block.items as Array<{ id: number }>;
    const ids = new Set(items.map((i) => i.id));
    expect(ids.size).toBe(5);
  });

  it("defaults title to empty string", () => {
    const block = buildChecklistBlock(["item"], "", 1);
    expect(block.title).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findTargetSection tests
// ---------------------------------------------------------------------------

describe("findTargetSection", () => {
  it("returns the Places to visit section when no day given", () => {
    const trip = fresh(checklistTrip);
    const target = findTargetSection(trip);
    expect(target.label).toBe("places to visit");
    expect(target.section.heading).toBe("Places to visit");
  });

  it("resolves 'day 1' to the first day section", () => {
    const trip = fresh(checklistTrip);
    const target = findTargetSection(trip, "day 1");
    expect(target.label).toBe("day 2026-06-01");
    expect(target.section.date).toBe("2026-06-01");
  });

  it("resolves ISO date", () => {
    const trip = fresh(checklistTrip);
    const target = findTargetSection(trip, "2026-06-03");
    expect(target.section.date).toBe("2026-06-03");
  });

  it("resolves a custom section by name", () => {
    const trip = fresh(checklistTrip);
    const target = findTargetSection(trip, undefined, "Notes");
    expect(target.label).toBe('section "Notes"');
    expect(target.section.heading).toBe("Notes");
  });

  it("throws when both day and section are specified", () => {
    const trip = fresh(checklistTrip);
    expect(() => findTargetSection(trip, "day 1", "Notes")).toThrow();
  });

  it("throws for out-of-range day", () => {
    const trip = fresh(checklistTrip);
    expect(() => findTargetSection(trip, "day 99")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyOp round-trip: note block insert
// ---------------------------------------------------------------------------

describe("applyOp – note block li", () => {
  it("inserts a note block into a day section", () => {
    const doc = fresh(checklistTrip);
    const block = buildNoteBlock(3656632);
    const dayIdx = 3; // day 2026-06-02 (empty)
    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", dayIdx, "blocks", 0], li: block },
    ];
    const next = applyOp(doc, ops);
    expect(next.itinerary.sections[dayIdx]!.blocks).toHaveLength(1);
    expect(next.itinerary.sections[dayIdx]!.blocks[0]!.type).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// applyOp round-trip: rich-text subtype
// ---------------------------------------------------------------------------

describe("applyOp – rich-text subtype", () => {
  it("sets text on a note block via rich-text insert", () => {
    const doc = fresh(checklistTrip);
    // First insert a note block
    const block = buildNoteBlock(3656632);
    const dayIdx = 3;
    let next = applyOp(doc, [
      { p: ["itinerary", "sections", dayIdx, "blocks", 0], li: block },
    ]);

    // Then apply rich-text op
    next = applyOp(next, [
      {
        p: ["itinerary", "sections", dayIdx, "blocks", 0, "text"],
        t: "rich-text",
        o: [{ insert: "Hello world\n" }],
      },
    ]);

    const noteBlock = next.itinerary.sections[dayIdx]!.blocks[0] as NoteBlock;
    // The placeholder "\n" is retained after the insert, giving "Hello world\n\n".
    // This is correct Quill Delta compose behavior — Quill always has a trailing \n.
    expect(noteBlock.text!.ops![0]!.insert).toBe("Hello world\n\n");
  });

  it("inserts text at a specific position via retain + insert", () => {
    const doc = fresh(checklistTrip);
    // The note on day 1 has "Don't forget the sunscreen!\n"
    const dayIdx = 2; // day 2026-06-01
    const blockIdx = 1; // the note block

    const next = applyOp(doc, [
      {
        p: ["itinerary", "sections", dayIdx, "blocks", blockIdx, "text"],
        t: "rich-text",
        o: [{ retain: 27 }, { insert: " SPF 50" }],
      },
    ]);

    const noteBlock = next.itinerary.sections[dayIdx]!.blocks[blockIdx] as NoteBlock;
    expect(noteBlock.text!.ops![0]!.insert).toContain("sunscreen! SPF 50");
  });

  it("handles delete in rich-text op", () => {
    const doc = fresh(checklistTrip);
    const dayIdx = 2;
    const blockIdx = 1;

    // Delete "Don't forget the " (17 chars) from the start
    const next = applyOp(doc, [
      {
        p: ["itinerary", "sections", dayIdx, "blocks", blockIdx, "text"],
        t: "rich-text",
        o: [{ delete: 17 }],
      },
    ]);

    const noteBlock = next.itinerary.sections[dayIdx]!.blocks[blockIdx] as NoteBlock;
    expect(noteBlock.text!.ops![0]!.insert).toBe("sunscreen!\n");
  });

  it("unknown subtype ops are silently skipped", () => {
    const doc = fresh(checklistTrip);
    const next = applyOp(doc, [
      {
        p: ["itinerary", "sections", 2, "blocks", 1, "text"],
        t: "future-unknown-type",
        o: { something: true },
      },
    ]);
    // Doc should be unchanged
    const noteBlock = next.itinerary.sections[2]!.blocks[1] as NoteBlock;
    expect(noteBlock.text!.ops![0]!.insert).toBe("Don't forget the sunscreen!\n");
  });
});

// ---------------------------------------------------------------------------
// applyOp round-trip: checklist block insert
// ---------------------------------------------------------------------------

describe("applyOp – checklist block li", () => {
  it("inserts a checklist block with pre-populated items", () => {
    const doc = fresh(checklistTrip);
    const block = buildChecklistBlock(["item one", "item two"], "My list", 3656632);
    const dayIdx = 3; // empty day
    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", dayIdx, "blocks", 0], li: block },
    ];
    const next = applyOp(doc, ops);
    const inserted = next.itinerary.sections[dayIdx]!.blocks[0] as ChecklistBlock;
    expect(inserted.type).toBe("checklist");
    expect(inserted.title).toBe("My list");
    expect(inserted.items).toHaveLength(2);
    expect(inserted.items[0]!.text!.ops![0]!.insert).toBe("item one\n");
  });
});

// ---------------------------------------------------------------------------
// Formatter tests
// ---------------------------------------------------------------------------

describe("formatBlockLine – checklist", () => {
  it("renders a checklist with title in concise mode", () => {
    const block: ChecklistBlock = {
      id: 1,
      type: "checklist",
      title: "Packing list",
      items: [
        { id: 2, checked: true, text: { ops: [{ insert: "passport\n" }] } },
        { id: 3, checked: false, text: { ops: [{ insert: "adapter\n" }] } },
      ],
    };
    const result = formatBlockLine(block, "concise")!;
    expect(result).toContain("☑");
    expect(result).toContain("Packing list");
    expect(result).toContain("[x] passport");
    expect(result).toContain("[ ] adapter");
    expect(result).toContain("[1/2]");
  });

  it("renders a checklist in detailed mode with line breaks", () => {
    const block: ChecklistBlock = {
      id: 1,
      type: "checklist",
      title: "Tasks",
      items: [
        { id: 2, checked: false, text: { ops: [{ insert: "book flights\n" }] } },
        { id: 3, checked: true, text: { ops: [{ insert: "reserve hotel\n" }] } },
      ],
    };
    const result = formatBlockLine(block, "detailed")!;
    expect(result).toContain("☑ Tasks:");
    expect(result).toContain("[1/2]");
    expect(result).toContain("[ ] book flights");
    expect(result).toContain("[x] reserve hotel");
  });

  it("returns null for empty untitled checklist", () => {
    const block: ChecklistBlock = {
      id: 1,
      type: "checklist",
      items: [],
    };
    const result = formatBlockLine(block, "concise");
    expect(result).toBeNull();
  });

  it("truncates long checklists in concise mode", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      checked: false,
      text: { ops: [{ insert: `item ${i}\n` }] },
    }));
    const block: ChecklistBlock = { id: 1, type: "checklist", items };
    const result = formatBlockLine(block, "concise")!;
    expect(result).toContain("(+3 more)");
  });

  it("renders items with empty text as (empty)", () => {
    const block: ChecklistBlock = {
      id: 1,
      type: "checklist",
      title: "test",
      items: [{ id: 2, checked: false, text: { ops: [{ insert: "\n" }] } }],
    };
    const result = formatBlockLine(block, "concise")!;
    expect(result).toContain("(empty)");
  });
});

describe("formatBlockLine – note with addedBy", () => {
  it("renders the expanded note block shape correctly", () => {
    const block: NoteBlock = {
      id: 1,
      type: "note",
      text: { ops: [{ insert: "Remember to check opening hours\n" }] },
      addedBy: { type: "user", userId: 42 },
      attachments: [],
    };
    const result = formatBlockLine(block, "concise")!;
    expect(result).toContain("📝");
    expect(result).toContain("Remember to check opening hours");
  });
});

describe("addNote and addChecklist with custom sections", () => {
  it("adds a note to an existing custom section", async () => {
    const { ctx, tripState } = makeFakeContext(checklistTrip);
    const res = await addNote(ctx, {
      trip_key: "T",
      text: "Pack extra jacket",
      section: "Notes",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain('section "Notes"');
    const notesSection = tripState.itinerary.sections.find((s) => s.heading === "Notes")!;
    expect(notesSection.blocks.some((b) => b.type === "note")).toBe(true);
  });

  it("auto-creates a custom section when adding a note to a new section", async () => {
    const { ctx, tripState } = makeFakeContext(checklistTrip);
    const res = await addNote(ctx, {
      trip_key: "T",
      text: "Coffee spots in Shibuya",
      section: "Coffee & Cafe",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain('section "Coffee & Cafe"');
    const created = tripState.itinerary.sections.find((s) => s.heading === "Coffee & Cafe");
    expect(created).toBeDefined();
    expect(created!.blocks).toHaveLength(1);
  });

  it("adds a checklist to a custom section auto-creating it if missing", async () => {
    const { ctx, tripState } = makeFakeContext(checklistTrip);
    const res = await addChecklist(ctx, {
      trip_key: "T",
      title: "Flight Prep",
      items: ["Passport", "Boarding Pass", "Noise Cancelling Headphones"],
      section: "Checklists",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain('section "Checklists"');
    const created = tripState.itinerary.sections.find((s) => s.heading === "Checklists");
    expect(created).toBeDefined();
    expect(created!.blocks[0]!.type).toBe("checklist");
  });
});
