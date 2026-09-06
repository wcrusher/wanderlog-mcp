import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { VALID_PLACE_MARKER_ICONS, type ValidPlaceMarkerIcon } from "../types.js";
import {
  findPlacesToVisitSection,
  findSectionByRef,
  submitOp,
} from "./shared.js";

export const updateSectionInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip containing the section to update."),
  section: z
    .string()
    .min(1)
    .describe(
      "The section to update, identified by its current heading (e.g. 'Food & Drink', 'Places to visit'). Use wanderlog_get_trip to see available sections.",
    ),
  heading: z
    .string()
    .optional()
    .describe(
      'New heading for the section. Pass "" (empty string) to clear it back to an untitled section.',
    ),
  place_marker_color: z
    .string()
    .optional()
    .describe(
      "New marker hex color for places in this custom list/section (e.g. '#3498db', '#e74c3c').",
    ),
  place_marker_icon: z
    .enum(VALID_PLACE_MARKER_ICONS)
    .optional()
    .describe(
      `New marker icon name for places in this custom list/section. Must be one of: ${VALID_PLACE_MARKER_ICONS.join(", ")}.`,
    ),
};

export const updateSectionDescription = `
Updates a custom section's heading, marker color, or marker icon in a Wanderlog trip.

Identify the section by its current heading. Use wanderlog_get_trip to see all sections and
their current headings if you are unsure. Pass an empty string for "heading" to clear the
section title.

Returns a confirmation showing the applied updates.
`.trim();

type Args = {
  trip_key: string;
  section: string;
  heading?: string;
  place_marker_color?: string;
  place_marker_icon?: ValidPlaceMarkerIcon;
};

const SYSTEM_SECTION_TYPES = new Set(["hotels", "flights", "transit"]);

export async function updateSection(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (
      args.heading === undefined &&
      args.place_marker_color === undefined &&
      args.place_marker_icon === undefined
    ) {
      throw new WanderlogValidationError(
        "At least one property ('heading', 'place_marker_color', or 'place_marker_icon') must be provided to update.",
      );
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const found = findSectionByRef(trip, args.section);
      if (!found) {
        throw new WanderlogValidationError(
          `Section "${args.section}" not found in trip "${trip.title}". Use wanderlog_get_trip to see available sections.`,
        );
      }
      const { index, section } = found;

      if (section.mode === "dayPlan") {
        throw new WanderlogValidationError(
          `Day sections cannot be renamed or modified here. Use wanderlog_rename_day to change a day's heading instead.`,
        );
      }

      if (findPlacesToVisitSection(trip)?.index === index) {
        throw new WanderlogValidationError(
          `The "Places to visit" section cannot be renamed or modified — it is the trip's default place list. Use wanderlog_get_trip to see your custom sections.`,
        );
      }

      if (SYSTEM_SECTION_TYPES.has(section.type)) {
        throw new WanderlogValidationError(
          `The "${section.heading || section.type}" section is a system section and cannot be renamed or modified. Use wanderlog_get_trip to see your custom sections.`,
        );
      }

      const ops: Json0Op[] = [];
      const changes: string[] = [];

      if (args.heading !== undefined && args.heading !== section.heading) {
        ops.push({
          p: ["itinerary", "sections", index, "heading"],
          od: section.heading,
          oi: args.heading,
        });
        const oldLabel = section.heading || "(untitled)";
        const newLabel = args.heading || "(untitled)";
        changes.push(`heading "${oldLabel}" → "${newLabel}"`);
      }

      if (
        args.place_marker_color !== undefined &&
        args.place_marker_color !== section.placeMarkerColor
      ) {
        ops.push({
          p: ["itinerary", "sections", index, "placeMarkerColor"],
          od: section.placeMarkerColor,
          oi: args.place_marker_color,
        });
        changes.push(
          `marker color "${section.placeMarkerColor ?? "none"}" → "${args.place_marker_color}"`,
        );
      }

      if (
        args.place_marker_icon !== undefined &&
        args.place_marker_icon !== section.placeMarkerIcon
      ) {
        ops.push({
          p: ["itinerary", "sections", index, "placeMarkerIcon"],
          od: section.placeMarkerIcon,
          oi: args.place_marker_icon,
        });
        changes.push(
          `marker icon "${section.placeMarkerIcon ?? "none"}" → "${args.place_marker_icon}"`,
        );
      }

      if (ops.length === 0) {
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `Section "${section.heading || "(untitled)"}" already has the specified attributes — no change made.`,
              },
            ],
          },
        };
      }

      await submit(ops);
      return {
        sectionHeading: section.heading || "(untitled)",
        changes,
        tripTitle: trip.title,
      };
    });

    if ("response" in result && result.response) return result.response;

    const text = `Updated section "${result.sectionHeading}" (${result.changes.join(", ")}) in "${result.tripTitle}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
