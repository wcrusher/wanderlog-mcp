import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { NoteBlock } from "../types.js";
import { extractPlainText } from "./remove-note.js";
import { findDaySectionByDate, submitOp } from "./shared.js";

export const reorderSectionItemsInputSchema = {
  trip_key: z.string().min(1).describe("The trip to reorder items in."),
  section: z
    .string()
    .optional()
    .describe("Section heading (e.g. 'Places to visit', 'Milan Restaurants'). Required if day is omitted."),
  day: z
    .string()
    .optional()
    .describe("Day filter (e.g. 'day 2', 'May 4', '2026-05-04'). Required if section is omitted."),
  from_position: z
    .number()
    .optional()
    .describe("1-based current index of the item to move (e.g. 3 to move 3rd item)."),
  to_position: z
    .number()
    .optional()
    .describe("1-based target index to move the item to (e.g. 1 to move to top)."),
  item_id: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Exact block ID of the item to move (alternative to from_position or text)."),
  text: z
    .string()
    .optional()
    .describe("Substring match of the item/note to move (alternative to from_position or item_id)."),
  order: z
    .array(z.union([z.number(), z.string()]))
    .optional()
    .describe("Complete array of block IDs representing the exact desired order of all items in the section."),
};

export const reorderSectionItemsDescription = `
Reorders items (blocks) within a section or day plan in a Wanderlog trip.

Supports three reordering modes:
1. Position-to-position: from_position (e.g. 3) and to_position (e.g. 1).
2. Item/Text-to-position: item_id (or text substring) and to_position (e.g. 1).
3. Full sequence: order array of all block IDs in desired order (e.g. [103, 101, 102]).
`.trim();

type Args = {
  trip_key: string;
  section?: string;
  day?: string;
  from_position?: number;
  to_position?: number;
  item_id?: number | string;
  text?: string;
  order?: Array<number | string>;
};

export async function reorderSectionItems(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.section && !args.day) {
      return {
        content: [{ type: "text", text: "Please specify either 'section' or 'day' to identify the section." }],
        isError: true,
      };
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const sections = trip.itinerary?.sections ?? [];

      let sectionIndex = -1;
      if (args.day) {
        const resolved = resolveDay(trip, args.day);
        const found = findDaySectionByDate(trip, resolved.date!);
        if (found) sectionIndex = found.index;
      } else if (args.section) {
        const lower = args.section.toLowerCase();
        sectionIndex = sections.findIndex(
          (s) => (s.heading ?? "").toLowerCase().includes(lower) || (s.type ?? "").toLowerCase().includes(lower),
        );
      }

      if (sectionIndex === -1) {
        throw new WanderlogNotFoundError("Section", args.section || args.day || "");
      }

      const section = sections[sectionIndex]!;
      const blocks = section.blocks ?? [];
      const sectionName = section.heading?.trim() || (section.mode === "dayPlan" ? `day ${section.date}` : "section");

      if (blocks.length === 0) {
        return {
          response: {
            content: [{ type: "text" as const, text: `Section "${sectionName}" is empty.` }],
            isError: true,
          },
        };
      }

      // Mode 3: Reorder by full order array
      if (args.order) {
        if (args.order.length !== blocks.length) {
          return {
            response: {
              content: [
                {
                  type: "text" as const,
                  text: `The 'order' array length (${args.order.length}) does not match section blocks count (${blocks.length}).`,
                },
              ],
              isError: true,
            },
          };
        }

        const existingIds = blocks.map((b) => String(b.id));
        const requestedIds = args.order.map(String);
        const isPermutation =
          existingIds.length === requestedIds.length &&
          requestedIds.every((id) => existingIds.includes(id));

        if (!isPermutation) {
          return {
            response: {
              content: [
                {
                  type: "text" as const,
                  text: `The 'order' array does not match the block IDs in section "${sectionName}".`,
                },
              ],
              isError: true,
            },
          };
        }

        // Reorder blocks according to requested order array
        const blockMap = new Map(blocks.map((b) => [String(b.id), b]));
        const newBlocks = requestedIds.map((id) => blockMap.get(id)!);

        // JSON0 replace blocks array: path = ["itinerary", "sections", sectionIndex, "blocks"]
        const ops: Json0Op[] = [
          {
            p: ["itinerary", "sections", sectionIndex, "blocks"],
            od: blocks,
            oi: newBlocks,
          },
        ];

        await submit(ops);
        return {
          message: `Reordered all ${blocks.length} items in "${sectionName}".`,
        };
      }

      // Modes 1 & 2: Single item move (from_position or item_id or text -> to_position)
      let fromIdx: number;

      if (args.item_id != null) {
        const targetIdStr = String(args.item_id);
        fromIdx = blocks.findIndex((b) => String(b.id) === targetIdStr);
        if (fromIdx === -1) {
          return {
            response: {
              content: [{ type: "text" as const, text: `Item ID ${args.item_id} not found in section "${sectionName}".` }],
              isError: true,
            },
          };
        }
      } else if (args.text) {
        const lower = args.text.toLowerCase();
        fromIdx = blocks.findIndex((b) => {
          if (b.type === "note") return extractPlainText(b as NoteBlock).toLowerCase().includes(lower);
          if ("place" in b && b.place && typeof (b as unknown as { place: { name: string } }).place.name === "string") {
            return (b as unknown as { place: { name: string } }).place.name.toLowerCase().includes(lower);
          }
          return false;
        });
        if (fromIdx === -1) {
          return {
            response: {
              content: [{ type: "text" as const, text: `Item matching "${args.text}" not found in section "${sectionName}".` }],
              isError: true,
            },
          };
        }
      } else if (args.from_position != null) {
        if (args.from_position < 1 || args.from_position > blocks.length) {
          return {
            response: {
              content: [
                {
                  type: "text" as const,
                  text: `from_position ${args.from_position} is out of range for section "${sectionName}" (1-${blocks.length}).`,
                },
              ],
              isError: true,
            },
          };
        }
        fromIdx = args.from_position - 1;
      } else {
        return {
          response: {
            content: [{ type: "text" as const, text: "Please specify 'from_position', 'item_id', 'text', or 'order'." }],
            isError: true,
          },
        };
      }

      if (args.to_position == null) {
        return {
          response: {
            content: [{ type: "text" as const, text: "Please specify 'to_position'." }],
            isError: true,
          },
        };
      }

      if (args.to_position < 1 || args.to_position > blocks.length) {
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `to_position ${args.to_position} is out of range for section "${sectionName}" (1-${blocks.length}).`,
              },
            ],
            isError: true,
          },
        };
      }

      const toIdx = args.to_position - 1;

      if (fromIdx === toIdx) {
        return {
          response: {
            content: [{ type: "text" as const, text: `Item is already at position ${args.to_position} in "${sectionName}".` }],
          },
        };
      }

      // ShareDB JSON0 list delete from fromIdx, list insert at toIdx
      const blockToMove = blocks[fromIdx]!;
      const ops: Json0Op[] = [
        {
          p: ["itinerary", "sections", sectionIndex, "blocks", fromIdx],
          ld: blockToMove,
        },
        {
          p: ["itinerary", "sections", sectionIndex, "blocks", toIdx],
          li: blockToMove,
        },
      ];

      await submit(ops);

      return {
        message: `Reordered item from position ${fromIdx + 1} to position ${toIdx + 1} in "${sectionName}".`,
      };
    });

    if ("response" in result && result.response) return result.response;

    return {
      content: [
        {
          type: "text",
          text: result.message,
        },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
