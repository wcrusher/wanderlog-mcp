import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { ChecklistBlock } from "../types.js";
import { submitOp } from "./shared.js";

export const removeChecklistInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove the checklist from."),
  checklist_ref: z
    .string()
    .optional()
    .describe("Title or substring match of the checklist to remove."),
  checklist_id: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Exact Wanderlog block ID of the checklist to remove."),
};

export const removeChecklistDescription = `
Removes a checklist block from a Wanderlog trip by checklist_ref title or checklist_id.
`.trim();

type Args = {
  trip_key: string;
  checklist_ref?: string;
  checklist_id?: number | string;
};

export async function removeChecklist(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.checklist_ref && args.checklist_id == null) {
      return {
        content: [
          {
            type: "text",
            text: "Please provide either 'checklist_ref' or 'checklist_id' to identify the checklist to remove.",
          },
        ],
        isError: true,
      };
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const sections = trip.itinerary.sections;

      let targetSectionIdx = -1;
      let targetBlockIdx = -1;
      let targetBlock: ChecklistBlock | null = null;

      for (let si = 0; si < sections.length; si++) {
        const section = sections[si]!;
        for (let bi = 0; bi < section.blocks.length; bi++) {
          const block = section.blocks[bi]!;
          if (block.type !== "checklist") continue;
          const cb = block as ChecklistBlock;

          let isMatch = false;
          if (args.checklist_id != null) {
            if (String(cb.id) === String(args.checklist_id)) isMatch = true;
          } else if (args.checklist_ref) {
            const title = (cb.title ?? "").toLowerCase();
            if (title.includes(args.checklist_ref.toLowerCase())) isMatch = true;
          }

          if (isMatch) {
            targetSectionIdx = si;
            targetBlockIdx = bi;
            targetBlock = cb;
            break;
          }
        }
        if (targetBlock) break;
      }

      if (!targetBlock) {
        throw new WanderlogNotFoundError(
          "Checklist",
          args.checklist_ref || String(args.checklist_id),
        );
      }

      const ops: Json0Op[] = [
        {
          p: ["itinerary", "sections", targetSectionIdx, "blocks", targetBlockIdx],
          ld: targetBlock,
        },
      ];

      await submit(ops);

      const targetId = targetBlock.id;
      const remains = entry.snapshot.itinerary.sections.some((section) =>
        section.blocks.some((candidate) => candidate.id === targetId),
      );
      if (remains) throw new WanderlogError("Removed checklist is still present", "stale_target");

      return {
        id: targetBlock.id,
        title: targetBlock.title || "Checklist",
        tripTitle: trip.title,
      };
    });

    return {
      content: [
        {
          type: "text",
          text: `Removed checklist [ID: ${result.id}] "${result.title}" from "${result.tripTitle}".`,
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
