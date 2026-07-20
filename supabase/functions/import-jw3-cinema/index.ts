// JW3 Cinema importer.
//
// Source: Spektrix API (client "jw3").
//   events:  https://system.spektrix.com/jw3/api/v3/events
//   instances: https://system.spektrix.com/jw3/api/v3/events/{eventId}/instances
//   plans/venues: https://system.spektrix.com/jw3/api/v3/plans / /venues
//
// The JW3 Spektrix account contains many non-cinema events (language classes,
// talks, workshops, music, family activities, etc.). We filter to cinema
// screenings using attribute_Genre == "Cinema", which JW3 applies consistently
// to all film/cinema events.
//
// SOLD-OUT SAFETY: JW3 Spektrix instances use isOnSale = false for several
// non-sold-out states (sales not yet open, online sales ended, members-only,
// past performances). The shared spektrixParser.isSoldOut() would treat a
// future !isOnSale instance as sold out — which violates the task's sold-out
// safety rules. We therefore force sold_out = false on every JW3 screening.
// JW3's Spektrix data has no explicit "sold out" flag, so per the rules we
// default to false (uncertain → not sold out). A cancelled instance is still
// skipped outright by fetchAllScreenings.
//
// source_reference = jw3:spektrix:{EventInstanceId}

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  fetchAllScreenings,
  type SpektrixConfig,
  type SpektrixEvent,
} from "../_shared/spektrixParser.ts";

const CINEMA_NAME = "JW3 Cinema";
const MIN_SCREENINGS = 3;

const config: SpektrixConfig = {
  client: "jw3",
  baseUrl: "https://system.spektrix.com",
  sourcePrefix: "jw3",
};

// JW3 classifies cinema events via attribute_Genre == "Cinema".
// This excludes classes, talks-without-film, workshops, children's
// activities, music, food events, religious events, memberships and
// donations, which carry other Genre values (Languages, Talks & Discussions,
// Classes & Courses, Families & Youth, Music, Special Events, etc.).
function isCinemaEvent(event: SpektrixEvent): boolean {
  const genre = (event.attributes.attribute_Genre as string) || "";
  return /^cinema$/i.test(genre.trim());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-jw3-cinema] starting at ${startedIso}`);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ctx: ImportRunContext = {
    supabase,
    cinemaName: CINEMA_NAME,
    minScreenings: MIN_SCREENINGS,
    startedAt,
  };

  const runStart = await startRun(ctx);
  if (runStart.blocked) {
    return jsonResponse(
      { success: false, error: "Another import is already running for JW3 Cinema.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  try {
    const nowUtc = new Date();
    const result = await fetchAllScreenings(config, isCinemaEvent, {
      fromDate: nowUtc,
    });

    console.log(
      `[import-jw3-cinema] events=${result.eventsCount} cinemaEvents=${result.cinemaEventsCount} instances=${result.instancesFetched} screenings=${result.screenings.length}`
    );

    // Abort before any DB write when a meaningful portion of event requests
    // failed, to avoid incomplete coverage triggering stale cleanup.
    const failedRatio =
      result.cinemaEventsCount > 0
        ? result.errors.length / result.cinemaEventsCount
        : 0;
    if (result.errors.length > 0 && failedRatio > 0.25) {
      const msg = `Too many event fetch errors (${result.errors.length}/${result.cinemaEventsCount}). Database left untouched.`;
      await endRun(ctx, runId, "failed", result.screenings.length, 0, msg);
      return jsonResponse(
        {
          success: false,
          error: msg,
          screenings_found: result.screenings.length,
          fetch_errors: result.errors.slice(0, 10),
        },
        500
      );
    }

    if (result.screenings.length < MIN_SCREENINGS) {
      const msg = `Unusually low screening count (${result.screenings.length}). Database left untouched.`;
      await endRun(ctx, runId, "failed", result.screenings.length, 0, msg);
      return jsonResponse(
        { success: false, error: msg, screenings_found: result.screenings.length },
        500
      );
    }

    // Deduplicate by source_reference before commit, and force sold_out = false.
    // JW3's isOnSale flag does not reliably indicate sold-out status.
    const seen = new Set<string>();
    const records: ScreeningRecord[] = result.screenings
      .filter((s) => {
        if (seen.has(s.source_reference)) return false;
        seen.add(s.source_reference);
        return true;
      })
      .map((s) => ({
        cinema_name: CINEMA_NAME,
        movie_title: s.movie_title,
        start_time: s.start_time_iso,
        booking_url: s.booking_url,
        format: s.format || (s.labels.length > 0 ? s.labels.join(", ") : null),
        sold_out: false,
        source_reference: s.source_reference,
        last_seen_at: new Date().toISOString(),
      }));

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length > 0) {
      const msg = `Import errors: ${errors.join("; ")}`;
      await endRun(ctx, runId, "failed", result.screenings.length, saved, msg);
      return jsonResponse(
        {
          success: false,
          error: msg,
          screenings_found: result.screenings.length,
          screenings_saved: saved,
        },
        500
      );
    }

    await endRun(ctx, runId, "success", result.screenings.length, saved);
    console.log(`[import-jw3-cinema] done: found=${result.screenings.length} saved=${saved}`);

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: result.screenings.length,
      screenings_saved: saved,
      events_total: result.eventsCount,
      cinema_events: result.cinemaEventsCount,
      instances_fetched: result.instancesFetched,
      fetch_errors: result.errors.slice(0, 10),
      import_started_at: startedIso,
      import_completed_at: new Date().toISOString(),
      examples: records.slice(0, 5).map((r) => ({
        movie_title: r.movie_title,
        start_time: r.start_time,
        source_reference: r.source_reference,
        booking_url: r.booking_url,
        format: r.format,
        sold_out: r.sold_out,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }
});
