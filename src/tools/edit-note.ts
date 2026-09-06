import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { ChecklistBlock, NoteBlock, QuillDelta, TripPlan } from "../types.js";
import { isChecklistBlock, isPlaceBlock } from "../types.js";
import { findDaySectionByDate, submitOp } from "./shared.js";
import { extractDeltaText } from "./remove-note.js";

export const editNoteInputSchema = {
  trip_key: z.string().min(1).describe("The trip to edit."),
  old_text: z
    .string()
    .optional()
    .describe("Substring to find and replace (case-insensitive). Optional if note_id is specified."),
  new_text: z.string().describe("Replacement text."),
  note_id: z
    .union([z.number(), z.string(), z.array(z.union([z.number(), z.string()]))])
    .optional()
    .describe("Exact Wanderlog block ID or array of block IDs to target specific notes directly."),
  section: z
    .string()
    .optional()
    .describe("Optional section heading filter (e.g. 'Places to visit', 'Milan Restaurants')."),
  day: z
    .string()
    .optional()
    .describe(
      "Optional day to search. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to search the entire trip.",
    ),
  instance: z
    .number()
    .optional()
    .describe("Optional 1-based instance index to select the Nth match when multiple notes match."),
};

export const editNoteDescription = `
Edits note content in a Wanderlog trip by finding and replacing text, or by note_id, section, or instance index.

- note_id: Target a specific block by its numeric ID.
- section: Filter edit targets to a specific section heading.
- instance: Select the Nth match (1-based index) when multiple notes match.
- old_text / new_text: Match notes by content substring (case-insensitive) and supply replacement text.
`.trim();

type Args = {
  trip_key: string;
  old_text?: string;
  new_text: string;
  note_id?: number | string | Array<number | string>;
  section?: string;
  day?: string;
  instance?: number;
};

type RichTextTarget = {
  kind: "rich-text";
  label: string;
  preview: string;
  blockId: number | string;
  sectionHeading: string;
  sectionIndex: number;
  blockIndex: number;
  fieldPath: (string | number)[];
  offset: number;
  matchedLen: number;
  crossesBoundary: boolean;
};

type PlainTarget = {
  kind: "plain";
  label: string;
  preview: string;
  blockId: number | string;
  sectionHeading: string;
  sectionIndex: number;
  blockIndex: number;
  fieldPath: (string | number)[];
  oldValue: string;
  offset: number;
  matchedLen: number;
};

export type EditTarget = RichTextTarget | PlainTarget;

function previewText(text: string): string {
  const flat = text.replace(/\n/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

function matchInDelta(
  delta: QuillDelta | undefined,
  query: string,
): { offset: number; matchedLen: number; crossesBoundary: boolean } | null {
  const ops = delta?.ops ?? [];
  const lowerQuery = query.toLowerCase();
  const boundaries: number[] = [];
  let plainText = "";
  for (const op of ops) {
    boundaries.push(plainText.length);
    plainText += typeof op.insert === "string" ? op.insert : "";
  }
  const lowerText = plainText.toLowerCase();
  const matchStart = lowerText.indexOf(lowerQuery);
  if (matchStart === -1) return null;
  const matchEnd = matchStart + lowerQuery.length;
  const crossesBoundary = boundaries.some((b) => b > matchStart && b < matchEnd);
  return { offset: matchStart, matchedLen: lowerQuery.length, crossesBoundary };
}

export function findEditTargets(
  trip: TripPlan,
  query?: string,
  day?: string,
  note_id?: number | string | Array<number | string>,
  sectionFilter?: string,
): EditTarget[] {
  const sections = trip.itinerary.sections;
  const targets: EditTarget[] = [];
  const lowerQuery = query ? query.toLowerCase() : undefined;

  const targetIds =
    note_id != null
      ? Array.isArray(note_id)
        ? note_id.map(String)
        : [String(note_id)]
      : undefined;

  let sectionIndices: number[];
  if (day) {
    const resolved = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, resolved.date!);
    if (!found) return [];
    sectionIndices = [found.index];
  } else {
    sectionIndices = Array.from({ length: sections.length }, (_, i) => i);
  }

  for (const si of sectionIndices) {
    const section = sections[si]!;
    if (sectionFilter) {
      const heading = (section.heading ?? "").toLowerCase();
      if (!heading.includes(sectionFilter.toLowerCase())) continue;
    }
    const sectionHeading = section.heading?.trim() || section.type || "section";

    for (let bi = 0; bi < section.blocks.length; bi++) {
      const block = section.blocks[bi]!;
      const blockBase: (string | number)[] = ["itinerary", "sections", si, "blocks", bi];
      const blockId = block.id;

      if (targetIds && !targetIds.includes(String(blockId))) {
        continue;
      }

      if (block.type === "note") {
        const delta = (block as NoteBlock).text;
        if (targetIds) {
          targets.push({
            kind: "rich-text",
            label: "note",
            preview: `Note: "${previewText(extractDeltaText(delta))}"`,
            blockId,
            sectionHeading,
            sectionIndex: si,
            blockIndex: bi,
            fieldPath: [...blockBase, "text"],
            offset: 0,
            matchedLen: extractDeltaText(delta).length,
            crossesBoundary: false,
          });
        } else if (lowerQuery) {
          const m = matchInDelta(delta, lowerQuery);
          if (m) {
            targets.push({
              kind: "rich-text",
              label: "note",
              preview: `Note: "${previewText(extractDeltaText(delta))}"`,
              blockId,
              sectionHeading,
              sectionIndex: si,
              blockIndex: bi,
              fieldPath: [...blockBase, "text"],
              offset: m.offset,
              matchedLen: m.matchedLen,
              crossesBoundary: m.crossesBoundary,
            });
          }
        }
      } else if (isPlaceBlock(block)) {
        const delta = block.text;
        if (delta) {
          if (targetIds) {
            targets.push({
              kind: "rich-text",
              label: `"${block.place.name}" annotation`,
              preview: `"${block.place.name}" annotation: "${previewText(extractDeltaText(delta))}"`,
              blockId,
              sectionHeading,
              sectionIndex: si,
              blockIndex: bi,
              fieldPath: [...blockBase, "text"],
              offset: 0,
              matchedLen: extractDeltaText(delta).length,
              crossesBoundary: false,
            });
          } else if (lowerQuery) {
            const m = matchInDelta(delta, lowerQuery);
            if (m) {
              targets.push({
                kind: "rich-text",
                label: `"${block.place.name}" annotation`,
                preview: `"${block.place.name}" annotation: "${previewText(extractDeltaText(delta))}"`,
                blockId,
                sectionHeading,
                sectionIndex: si,
                blockIndex: bi,
                fieldPath: [...blockBase, "text"],
                offset: m.offset,
                matchedLen: m.matchedLen,
                crossesBoundary: m.crossesBoundary,
              });
            }
          }
        }
      } else if (isChecklistBlock(block)) {
        const cb = block as ChecklistBlock;
        const title = cb.title ?? "";
        if (targetIds) {
          if (title) {
            targets.push({
              kind: "plain",
              label: "checklist title",
              preview: `Checklist title: "${previewText(title)}"`,
              blockId,
              sectionHeading,
              sectionIndex: si,
              blockIndex: bi,
              fieldPath: [...blockBase, "title"],
              oldValue: title,
              offset: 0,
              matchedLen: title.length,
            });
          }
        } else if (lowerQuery && title && title.toLowerCase().includes(lowerQuery)) {
          const offset = title.toLowerCase().indexOf(lowerQuery);
          targets.push({
            kind: "plain",
            label: "checklist title",
            preview: `Checklist title: "${previewText(title)}"`,
            blockId,
            sectionHeading,
            sectionIndex: si,
            blockIndex: bi,
            fieldPath: [...blockBase, "title"],
            oldValue: title,
            offset,
            matchedLen: lowerQuery.length,
          });
        }
        for (let ii = 0; ii < cb.items.length; ii++) {
          const item = cb.items[ii]!;
          if (targetIds) {
            targets.push({
              kind: "rich-text",
              label: "checklist item",
              preview: `Checklist item: "${previewText(extractDeltaText(item.text))}"`,
              blockId,
              sectionHeading,
              sectionIndex: si,
              blockIndex: bi,
              fieldPath: [...blockBase, "items", ii, "text"],
              offset: 0,
              matchedLen: extractDeltaText(item.text).length,
              crossesBoundary: false,
            });
          } else if (lowerQuery) {
            const m = matchInDelta(item.text, lowerQuery);
            if (m) {
              targets.push({
                kind: "rich-text",
                label: "checklist item",
                preview: `Checklist item: "${previewText(extractDeltaText(item.text))}"`,
                blockId,
                sectionHeading,
                sectionIndex: si,
                blockIndex: bi,
                fieldPath: [...blockBase, "items", ii, "text"],
                offset: m.offset,
                matchedLen: m.matchedLen,
                crossesBoundary: m.crossesBoundary,
              });
            }
          }
        }
      }
    }
  }

  return targets;
}

export async function editNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.old_text && args.note_id == null) {
      return {
        content: [
          {
            type: "text",
            text: "Please provide either 'old_text' or 'note_id' to identify the note to edit.",
          },
        ],
        isError: true,
      };
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      let targets = findEditTargets(trip, args.old_text, args.day, args.note_id, args.section);

      if (args.note_id != null) {
        const requestedIds = Array.from(
          new Set(
            Array.isArray(args.note_id) ? args.note_id.map(String) : [String(args.note_id)],
          ),
        );
        const foundIdSet = new Set(targets.map((t) => String(t.blockId)));
        const missing = requestedIds.filter((id) => !foundIdSet.has(id));
        if (missing.length > 0) {
          return {
            response: {
              content: [
                {
                  type: "text" as const,
                  text: `Note ID(s) not found: ${missing.join(", ")}.`,
                },
              ],
              isError: true,
            },
          };
        }
      }

      if (targets.length === 0) {
        throw new WanderlogNotFoundError("Note", args.old_text || String(args.note_id));
      }

      if (args.instance != null) {
        if (args.instance >= 1 && args.instance <= targets.length) {
          targets = [targets[args.instance - 1]!];
        } else {
          const lines = targets
            .slice(0, 10)
            .map(
              (t, i) =>
                `  ${i + 1}. [ID: ${t.blockId}] in "${t.sectionHeading}": ${t.preview}`,
            )
            .join("\n");
          return {
            response: {
              content: [
                {
                  type: "text" as const,
                  text: `Instance ${args.instance} is out of range. "${args.old_text || args.note_id}" matched ${targets.length} notes:\n${lines}\n\nCall again with a valid instance index or 'note_id'.`,
                },
              ],
              isError: true,
            },
          };
        }
      }

      if (targets.length > 1 && args.note_id == null) {
        const lines = targets
          .slice(0, 10)
          .map(
            (t, i) =>
              `  ${i + 1}. [ID: ${t.blockId}] in "${t.sectionHeading}": ${t.preview}`,
          )
          .join("\n");
        const suffix = targets.length > 10 ? `\n  (${targets.length - 10} more…)` : "";
        const queryLabel = args.old_text ? `"${args.old_text}"` : "Note search";
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `${queryLabel} matches ${targets.length} notes:\n${lines}${suffix}\n\nCall again with 'note_id' (e.g. note_id: ${targets[0]!.blockId}), 'section', or 'instance'.`,
              },
            ],
            isError: true,
          },
        };
      }

      const target = targets[0]!;
      if (target.kind === "rich-text" && target.crossesBoundary) {
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `Cannot replace "${args.old_text}": the match crosses a formatting boundary (e.g. a link or bold section). Use a more specific substring that stays within one formatting run.`,
              },
            ],
            isError: true,
          },
        };
      }

      let ops: Json0Op[];
      if (target.kind === "rich-text") {
        const deltaOps: Array<Record<string, unknown>> = [];
        if (target.offset > 0) deltaOps.push({ retain: target.offset });
        deltaOps.push({ delete: target.matchedLen });
        if (args.new_text) deltaOps.push({ insert: args.new_text });
        ops = [{ p: target.fieldPath, t: "rich-text", o: deltaOps }];
      } else {
        const newValue =
          target.oldValue.slice(0, target.offset) +
          args.new_text +
          target.oldValue.slice(target.offset + target.matchedLen);
        ops = [{ p: target.fieldPath, od: target.oldValue, oi: newValue }];
      }
      await submit(ops);
      return {
        targetLabel: target.label,
        tripTitle: trip.title,
        oldPreview: previewText(args.old_text || target.preview),
      };
    });
    if ("response" in result && result.response) return result.response;

    const oldPreview = result.oldPreview;
    const newPreview = previewText(args.new_text || "(empty)");
    return {
      content: [
        {
          type: "text",
          text: `Updated ${result.targetLabel} in "${result.tripTitle}". Changed "${oldPreview}" → "${newPreview}".`,
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
