import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { NoteBlock, QuillDelta, TripPlan } from "../types.js";
import { findDaySectionByDate, submitOp } from "./shared.js";

export const removeNoteInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  text: z
    .string()
    .optional()
    .describe("Substring to match against note content (case-insensitive). Optional if note_id is specified."),
  note_id: z
    .union([z.number(), z.string(), z.array(z.union([z.number(), z.string()]))])
    .optional()
    .describe(
      "Exact Wanderlog block ID or array of block IDs (e.g. 472680376 or [472680376, 981273918]) to target specific notes directly.",
    ),
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

export const removeNoteDescription = `
Removes one or more note blocks from a Wanderlog trip by note_id (single or array), text substring, section, or instance index.

- note_id: Supply a single ID (472680376) or array of IDs ([472680376, 981273918]) to delete directly.
- section: Filter notes to a specific section heading.
- instance: Pick the Nth match (1-based index) when multiple notes match a search string.
- text: Match notes by content substring (case-insensitive).
`.trim();

type Args = {
  trip_key: string;
  text?: string;
  note_id?: number | string | Array<number | string>;
  section?: string;
  day?: string;
  instance?: number;
};

export type NoteMatch = {
  sectionIndex: number;
  blockIndex: number;
  sectionHeading: string;
  plainText: string;
  block: NoteBlock;
};

export function extractDeltaText(delta: QuillDelta | undefined): string {
  const ops = delta?.ops ?? [];
  return ops.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}

export function extractPlainText(block: NoteBlock): string {
  return extractDeltaText(block.text);
}

export function findNoteMatches(
  trip: TripPlan,
  query?: string,
  day?: string,
  note_id?: number | string | Array<number | string>,
  sectionFilter?: string,
): NoteMatch[] {
  const lowerQuery = query ? query.toLowerCase() : undefined;
  const sections = trip.itinerary.sections;
  const matches: NoteMatch[] = [];

  const targetIds = note_id != null
    ? (Array.isArray(note_id) ? note_id.map(String) : [String(note_id)])
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

  for (const sectionIndex of sectionIndices) {
    const section = sections[sectionIndex]!;
    if (sectionFilter) {
      const heading = (section.heading ?? "").toLowerCase();
      if (!heading.includes(sectionFilter.toLowerCase())) continue;
    }
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (block.type !== "note") continue;
      const noteBlock = block as NoteBlock;
      const plainText = extractPlainText(noteBlock);

      let isMatch = false;
      if (targetIds) {
        if (targetIds.includes(String(block.id))) {
          isMatch = true;
        }
      } else if (lowerQuery) {
        if (plainText.toLowerCase().includes(lowerQuery)) {
          isMatch = true;
        }
      }

      if (isMatch) {
        matches.push({
          sectionIndex,
          blockIndex,
          sectionHeading: section.heading?.trim() || section.type || "section",
          plainText,
          block: noteBlock,
        });
      }
    }
  }

  return matches;
}

function notePreview(plainText: string): string {
  const flat = plainText.replace(/\n/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

export async function removeNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.text && args.note_id == null) {
      return {
        content: [
          {
            type: "text",
            text: "Please provide either 'text' or 'note_id' to identify the note to remove.",
          },
        ],
        isError: true,
      };
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      let matches = findNoteMatches(trip, args.text, args.day, args.note_id, args.section);

      if (args.note_id != null) {
        const requestedIds = Array.from(
          new Set(
            Array.isArray(args.note_id) ? args.note_id.map(String) : [String(args.note_id)],
          ),
        );
        const foundIdSet = new Set(matches.map((m) => String(m.block.id)));
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

        // Deduplicate matches by block.id
        const seen = new Set<string>();
        matches = matches.filter((m) => {
          const key = String(m.block.id);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      if (matches.length === 0) {
        throw new WanderlogNotFoundError("Note", args.text || String(args.note_id));
      }

      if (args.instance != null) {
        if (args.instance >= 1 && args.instance <= matches.length) {
          matches = [matches[args.instance - 1]!];
        } else {
          const lines = matches
            .slice(0, 10)
            .map(
              (m, i) =>
                `  ${i + 1}. [ID: ${m.block.id}] in "${m.sectionHeading}": "${notePreview(m.plainText)}"`,
            )
            .join("\n");
          return {
            response: {
              content: [
                {
                  type: "text" as const,
                  text: `Instance ${args.instance} is out of range. "${args.text || args.note_id}" matched ${matches.length} notes:\n${lines}\n\nCall again with a valid instance index or 'note_id'.`,
                },
              ],
              isError: true,
            },
          };
        }
      }

      if (matches.length > 1 && args.note_id == null) {
        const lines = matches
          .slice(0, 10)
          .map(
            (m, i) =>
              `  ${i + 1}. [ID: ${m.block.id}] in "${m.sectionHeading}": "${notePreview(m.plainText)}"`,
          )
          .join("\n");
        const suffix = matches.length > 10 ? `\n  (${matches.length - 10} more…)` : "";
        const queryLabel = args.text ? `"${args.text}"` : "Note search";
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `${queryLabel} matches ${matches.length} notes:\n${lines}${suffix}\n\nCall again with 'note_id' (e.g. note_id: ${matches[0]!.block.id} or [${matches.map((m) => m.block.id).slice(0, 3).join(", ")}]), 'section', or 'instance'.`,
              },
            ],
            isError: true,
          },
        };
      }

      // Sort matches in reverse sectionIndex and blockIndex order for safe batch removal
      const sorted = [...matches].sort((a, b) => {
        if (a.sectionIndex !== b.sectionIndex) return b.sectionIndex - a.sectionIndex;
        return b.blockIndex - a.blockIndex;
      });

      const ops: Json0Op[] = sorted.map((m) => ({
        p: ["itinerary", "sections", m.sectionIndex, "blocks", m.blockIndex],
        ld: m.block,
      }));

      await submit(ops);

      const removedIds = new Set(sorted.map((m) => m.block.id));
      const remains = entry.snapshot.itinerary.sections.some((section) =>
        section.blocks.some((candidate) => removedIds.has(candidate.id)),
      );
      if (remains) throw new WanderlogError("Removed note is still present", "stale_target");

      return {
        count: sorted.length,
        firstPreview: notePreview(sorted[0]!.plainText),
        tripTitle: trip.title,
      };
    });

    if ("response" in result && result.response) return result.response;

    const countText =
      result.count === 1
        ? `note "${result.firstPreview}"`
        : `${result.count} notes`;
    const text = `Removed ${countText} from "${result.tripTitle}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
