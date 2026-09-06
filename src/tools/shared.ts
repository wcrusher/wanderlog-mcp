import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import { createLogger } from "../logging.js";
import type { Json0Op } from "../ot/apply.js";

const log = createLogger("wanderdog");
import { resolveDay } from "../resolvers/day.js";
import type {
  Block,
  ChecklistItem,
  Geo,
  PlaceData,
  RentalCarEndpoint,
  Section,
  TransitEndpoint,
  TripPlan,
} from "../types.js";
import { isPlaceBlock, VALID_PLACE_MARKER_ICONS } from "../types.js";

/**
 * Per-trip mutex — serializes submits against the same trip so concurrent
 * callers can't race each other on the ShareDB version vector. Without this,
 * parallel Promise.all batches of mutations all read the cache at version N
 * simultaneously and submit stale ops that the server rejects as conflicts.
 */
const submitLocks = new Map<string, Promise<unknown>>();

async function withSubmitLock<T>(
  tripKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = submitLocks.get(tripKey) ?? Promise.resolve();
  // Chain regardless of whether the previous op succeeded or failed —
  // one failed op should not permanently block the queue.
  const next = prev.then(fn, fn);
  // The map always holds a never-rejecting tail so the next caller can chain
  // onto it safely. Dead promises are negligible; the map is keyed by trip.
  submitLocks.set(
    tripKey,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Submit a JSON0 op array to the server and apply it to the live cache on
 * success. Encapsulates the version handshake so tools don't touch
 * ShareDBClient directly.
 *
 * Rules:
 * - Trip must already be in the cache (caller should have called tripCache.get()).
 * - Per-trip mutex: concurrent calls on the same trip serialize automatically.
 * - Op fails atomically: if submit rejects, the cache is invalidated so the
 *   next read refetches a fresh snapshot from the server.
 * - On success, cache.applyLocalOp() is called with the server-accepted version.
 */
export async function submitOp(
  ctx: AppContext,
  tripKey: string,
  ops: Json0Op[],
): Promise<void> {
  log.info(`submitting op (${ops.length} op${ops.length === 1 ? "" : "s"}) to trip ${tripKey}`, {
    tripKey,
    opCount: ops.length,
    paths: ops.map((o) => o.p),
  });
  return withSubmitLock(tripKey, async () => {
    const client = ctx.pool.get(tripKey);
    if (!client.isSubscribed) {
      log.warn(`submitOp rejected: trip ${tripKey} is not subscribed`, { tripKey });
      throw new WanderlogError(
        `Trip ${tripKey} is not subscribed — call tripCache.get() first`,
        "not_subscribed",
      );
    }
    try {
      await submitWithRateLimitRetry(client, ops, tripKey);
      log.info(`op accepted by server for trip ${tripKey} (new version: ${client.version})`, {
        tripKey,
        newVersion: client.version,
      });
      ctx.tripCache.applyLocalOp(tripKey, ops, client.version);
    } catch (err) {
      log.error(`submitOp failed on trip ${tripKey}: ${(err as Error).message}`, {
        tripKey,
        error: (err as Error).message,
      });
      // Any submit failure leaves our cached view possibly inconsistent with
      // the server. Invalidate so the next get() refetches + resubscribes.
      ctx.tripCache.invalidate(tripKey);
      throw err;
    }
  });
}

const RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

// A rate-limited op (code 4001) is rejected before the server processes it —
// it never acks and never applies — so resubmitting the same ops at the same
// version is safe. Burst mutations (e.g. an LLM building a full itinerary)
// hit the limit routinely; waiting out the window beats surfacing an error.
async function submitWithRateLimitRetry(
  client: { submit(ops: Json0Op[]): Promise<void> },
  ops: Json0Op[],
  tripKey?: string,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await client.submit(ops);
      return;
    } catch (err) {
      const isRateLimit =
        err instanceof WanderlogError && err.code === "rate_limited";
      if (!isRateLimit || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) {
        throw err;
      }
      const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      log.warn(`rate limited by Wanderlog (4001) on trip ${tripKey ?? "unknown"}, retrying in ${delay}ms`, {
        tripKey,
        attempt: attempt + 1,
        delayMs: delay,
      });
      await new Promise((r) =>
        setTimeout(r, delay),
      );
      attempt += 1;
    }
  }
}

/** Wanderlog block IDs are 9-digit numeric. Sections use the same format. */
export function generateBlockId(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

/**
 * Build a new custom section matching the shape Wanderlog inserts from its UI.
 * Always type "normal" / mode "placeList" — day sections are managed by update-trip-dates.
 */
export function buildSectionObject(
  heading: string,
  color?: string,
  icon?: string,
): Section {
  const resolvedIcon =
    icon && (VALID_PLACE_MARKER_ICONS as readonly string[]).includes(icon)
      ? icon
      : "map-marker";
  return {
    id: generateBlockId(),
    type: "normal",
    mode: "placeList",
    heading,
    date: null,
    blocks: [],
    text: { ops: [{ insert: "\n" }] },
    placeMarkerColor: color ?? "#3498db",
    placeMarkerIcon: resolvedIcon,
  };
}

/**
 * Resolves a natural-language section reference to its index and Section object.
 * Resolution order:
 *   1. "places to visit" / "places" → the default placeList section (via findPlacesToVisitSection)
 *   2. Case-insensitive exact heading match across all sections
 *   3. Normalized punctuation match (e.g. "food and drink" vs "food & drink")
 *   4. Substring match
 * Returns null when no section matches.
 */
export function findSectionByRef(
  trip: TripPlan,
  ref: string,
): { index: number; section: Section } | null {
  const normalized = ref.trim().toLowerCase();
  if (normalized === "places to visit" || normalized === "places") {
    return findPlacesToVisitSection(trip);
  }
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (s.heading.trim().toLowerCase() === normalized) {
      return { index: i, section: s };
    }
  }
  const cleanRef = normalized.replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    const cleanHeading = s.heading.trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
    if (cleanHeading.length > 0 && cleanHeading === cleanRef) {
      return { index: i, section: s };
    }
  }
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    const sHeading = s.heading.trim().toLowerCase();
    if (sHeading.length > 0 && (sHeading.includes(normalized) || normalized.includes(sHeading))) {
      return { index: i, section: s };
    }
  }
  return null;
}

export function requireUserId(ctx: AppContext): number {
  if (ctx.userId == null) {
    throw new WanderlogError(
      "User ID not available — auth probe has not completed",
      "no_user_id",
    );
  }
  return ctx.userId;
}

/**
 * Build a newly-inserted place block matching Wanderlog's schema.
 * Based on the shape captured in HAR during real trip-add operations.
 */
export function buildPlaceBlock(
  place: PlaceData,
  userId: number,
  extras: {
    hotel?: {
      checkIn: string;
      checkOut: string;
      travelerNames?: string[];
      confirmationNumber?: string | null;
    };
    startTime?: string;
    endTime?: string;
  } = {},
): Block {
  const base: Record<string, unknown> = {
    id: generateBlockId(),
    type: "place",
    place,
    text: { ops: [{ insert: "\n" }] },
    addedBy: { type: "user", userId },
    imageSize: "small",
    upvotedBy: [],
    travelMode: null,
    attachments: [],
  };
  if (extras.hotel) {
    base.hotel = {
      checkIn: extras.hotel.checkIn,
      checkOut: extras.hotel.checkOut,
      travelerNames: extras.hotel.travelerNames ?? [],
      confirmationNumber: extras.hotel.confirmationNumber ?? null,
    };
  }
  if (extras.startTime) base.startTime = extras.startTime;
  if (extras.endTime) base.endTime = extras.endTime;
  return base as unknown as Block;
}

/**
 * Finds the "Places to visit" section (the default normal+placeList section
 * at the top of every trip). Returns its index in trip.itinerary.sections.
 */
export function findPlacesToVisitSection(trip: TripPlan): {
  index: number;
  section: Section;
} | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (
      s.type === "normal" &&
      s.mode === "placeList" &&
      (s.heading === "Places to visit" || s.heading === "")
    ) {
      return { index: i, section: s };
    }
  }
  return null;
}

/** Finds the first hotels-type section in the trip. */
export function findHotelsSection(trip: TripPlan): {
  index: number;
  section: Section;
} | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (s.type === "hotels") return { index: i, section: s };
  }
  return null;
}

/**
 * Finds a day section by ISO date. Returns null if no matching section exists
 * (e.g. the date is outside the trip range).
 */
export function findDaySectionByDate(
  trip: TripPlan,
  isoDate: string,
): { index: number; section: Section } | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (s.mode === "dayPlan" && s.date === isoDate) {
      return { index: i, section: s };
    }
  }
  return null;
}

/**
 * Returns a search-biasing location for the trip. Tries in order:
 *   1. The first place block with geometry (most specific)
 *   2. The trip's first associated geo (from /api/tripPlans/{key} resources)
 *   3. Null if both are absent
 */
export function findTripCenter(
  trip: TripPlan,
  geos?: Geo[],
): { lat: number; lng: number } | null {
  for (const section of trip.itinerary.sections) {
    for (const block of section.blocks) {
      if (!isPlaceBlock(block)) continue;
      const loc = block.place.geometry?.location;
      if (loc) return loc;
    }
  }
  const first = geos?.[0];
  if (first) return { lat: first.latitude, lng: first.longitude };
  return null;
}

/**
 * Resolves the target section for adding a block — a specific day, a custom
 * section, or the default "Places to visit" list. Shared by add-place, add-note, add-checklist.
 */
export function findTargetSection(
  trip: TripPlan,
  day?: string,
  section?: string,
): { index: number; section: Section; label: string } {
  if (day && section) {
    throw new WanderlogValidationError(
      "Cannot specify both 'day' and 'section' as target list. Pick one or omit both for 'Places to visit'.",
    );
  }
  if (day) {
    const daySection = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, daySection.date!);
    if (!found) {
      throw new WanderlogValidationError(`Day ${day} not found in trip`);
    }
    return { index: found.index, section: found.section, label: `day ${daySection.date}` };
  }
  if (section) {
    const found = findSectionByRef(trip, section);
    if (!found) {
      throw new WanderlogValidationError(
        `Section "${section}" not found in trip "${trip.title}". Use wanderlog_add_section to create it first or check wanderlog_get_trip.`,
      );
    }
    return {
      index: found.index,
      section: found.section,
      label: `section "${found.section.heading || section}"`,
    };
  }
  const places = findPlacesToVisitSection(trip);
  if (!places) {
    throw new WanderlogError(
      "Trip has no 'Places to visit' list",
      "no_places_section",
      "This is unexpected — Wanderlog usually creates one automatically. Try adding to a specific day instead.",
    );
  }
  return { index: places.index, section: places.section, label: "places to visit" };
}

/** Build a note block matching the shape captured from the Wanderlog UI. */
export function buildNoteBlock(userId: number): Record<string, unknown> {
  return {
    id: generateBlockId(),
    type: "note",
    text: { ops: [{ insert: "\n" }] },
    addedBy: { type: "user", userId },
    attachments: [],
  };
}

export function buildTransitBlock(
  type: "ferry" | "bus" | "train",
  userId: number,
  args: {
    carrier: string;
    depart: TransitEndpoint;
    arrive: TransitEndpoint;
    confirmationNumber?: string;
    travelerNames?: string[];
    notes?: string;
  },
): Block {
  const block: Record<string, unknown> = {
    id: generateBlockId(),
    type,
    carrier: args.carrier,
    depart: args.depart,
    arrive: args.arrive,
    addedBy: { type: "user", userId },
    text: { ops: [{ insert: args.notes ? `${args.notes}\n` : "\n" }] },
    attachments: [],
  };
  if (args.confirmationNumber) block.confirmationNumber = args.confirmationNumber;
  if (args.travelerNames && args.travelerNames.length > 0) {
    block.travelerNames = args.travelerNames;
  }
  return block as unknown as Block;
}

export function buildRentalCarBlock(
  userId: number,
  args: {
    pickUp: RentalCarEndpoint;
    dropOff: RentalCarEndpoint;
    confirmationNumber?: string;
    travelerNames?: string[];
    notes?: string;
  },
): Block {
  const block: Record<string, unknown> = {
    id: generateBlockId(),
    type: "rentalCar",
    addedBy: { type: "user", userId },
    pickUp: args.pickUp,
    dropOff: args.dropOff,
    text: { ops: [{ insert: args.notes ? `${args.notes}\n` : "\n" }] },
    attachments: [],
  };
  if (args.confirmationNumber) block.confirmationNumber = args.confirmationNumber;
  if (args.travelerNames && args.travelerNames.length > 0) {
    block.travelerNames = args.travelerNames;
  }
  return block as unknown as Block;
}

const TRANSIT_SECTION_META: Record<
  "transit" | "rentalCars",
  { heading: string; placeMarkerIcon: string; placeMarkerColor: string }
> = {
  transit: { heading: "Transit", placeMarkerIcon: "subway", placeMarkerColor: "#17b978" },
  rentalCars: { heading: "Rental cars", placeMarkerIcon: "car", placeMarkerColor: "#38a4a6" },
};

/**
 * Build a JSON0 `li` op that places `block` into the section of `sectionType`.
 * Appends to an existing section's blocks, or inserts a new section (block
 * embedded) at the end of itinerary.sections. Resolve-by-type keeps us safe
 * against unstable indices (invariant #6).
 */
export function sectionInsertOp(
  trip: TripPlan,
  sectionType: "transit" | "rentalCars",
  block: Block,
): Json0Op {
  const sections = trip.itinerary.sections;
  const index = sections.findIndex((s) => s.type === sectionType);
  if (index >= 0) {
    return {
      p: ["itinerary", "sections", index, "blocks", sections[index]!.blocks.length],
      li: block,
    };
  }
  const meta = TRANSIT_SECTION_META[sectionType];
  const section = {
    id: generateBlockId(),
    type: sectionType,
    mode: "placeList",
    heading: meta.heading,
    date: null,
    blocks: [block],
    placeMarkerColor: meta.placeMarkerColor,
    placeMarkerIcon: meta.placeMarkerIcon,
    text: { ops: [{ insert: "\n" }] },
  };
  return { p: ["itinerary", "sections", sections.length], li: section };
}

export function validateChronology(
  startLabel: string,
  startDate: string,
  startTime: string,
  endLabel: string,
  endDate: string,
  endTime: string,
): void {
  for (const [label, d] of [
    [`${startLabel}_date`, startDate],
    [`${endLabel}_date`, endDate],
  ] as const) {
    if (!isValidDate(d)) {
      throw new WanderlogValidationError(`Invalid ${label}: "${d}". Use YYYY-MM-DD.`);
    }
  }
  for (const [label, t] of [
    [`${startLabel}_time`, startTime],
    [`${endLabel}_time`, endTime],
  ] as const) {
    if (!TIME_REGEX.test(t)) {
      throw new WanderlogValidationError(`Invalid ${label}: "${t}". Use HH:mm (00:00–23:59).`);
    }
  }
  // Zero-padded ISO "YYYY-MM-DDTHH:mm" sorts chronologically as a string.
  if (`${endDate}T${endTime}` < `${startDate}T${startTime}`) {
    throw new WanderlogValidationError(
      `${endLabel} (${endDate} ${endTime}) must be on or after ${startLabel} (${startDate} ${startTime}).`,
    );
  }
}

/** Resolve a place-name query to full PlaceData, biased to the trip center. */
export async function resolveEndpointPlace(
  ctx: AppContext,
  trip: TripPlan,
  geos: Geo[] | undefined,
  query: string,
): Promise<PlaceData> {
  const center = findTripCenter(trip, geos);
  if (!center) {
    throw new WanderlogValidationError(
      `Cannot resolve "${query}" in "${trip.title}" because no location anchor is available`,
      "This trip has no associated geo and no existing places.",
    );
  }
  const predictions = await ctx.rest.searchPlacesAutocomplete({
    input: query,
    sessionToken: crypto.randomUUID(),
    location: { latitude: center.lat, longitude: center.lng },
    radius: 15000,
  });
  if (predictions.length === 0) {
    throw new WanderlogError(
      `No place found matching "${query}" near ${trip.title}`,
      "place_not_found",
      "Try a more specific name or check the spelling.",
    );
  }
  return ctx.rest.getPlaceDetails(predictions[0]!.place_id);
}

/** Build a checklist block with pre-populated items. */
export function buildChecklistBlock(
  items: string[],
  title: string,
  userId: number,
): Record<string, unknown> {
  const checklistItems: ChecklistItem[] = items.map((text) => ({
    id: generateBlockId(),
    checked: false,
    text: { ops: [{ insert: `${text}\n` }] },
  }));
  return {
    id: generateBlockId(),
    type: "checklist",
    items: checklistItems,
    title,
    addedBy: { type: "user", userId },
    attachments: [],
  };
}

const TIME_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateTimeInputs(startTime?: string, endTime?: string): void {
  if (startTime && !TIME_REGEX.test(startTime)) {
    throw new WanderlogValidationError(
      `Invalid start_time: "${startTime}". Hours must be between 00 and 23, and minutes between 00 and 59.`,
    );
  }
  if (endTime && !TIME_REGEX.test(endTime)) {
    throw new WanderlogValidationError(
      `Invalid end_time: "${endTime}". Hours must be between 00 and 23, and minutes between 00 and 59.`,
    );
  }
  // Format is validated above, so a lexicographic compare on zero-padded HH:mm
  // is equivalent to a chronological compare.
  if (startTime && endTime && startTime >= endTime) {
    throw new WanderlogValidationError(
      `end_time (${endTime}) must be after start_time (${startTime}).`,
    );
  }
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;

  const [year, month, day] = dateStr.split("-").map((s) => parseInt(s, 10));
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

export function validateDateRange(startDate: string, endDate: string): void {
  // Both dates are validated as YYYY-MM-DD before this runs, so a
  // lexicographic compare matches chronological order.
  if (startDate > endDate) {
    throw new WanderlogValidationError(
      `end_date (${endDate}) must be on or after start_date (${startDate}).`,
    );
  }
}
