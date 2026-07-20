// Olympic Cinema Barnes importer.
//
// Source: https://www.olympiccinema.com/whats-on
// Provider: mycloudcinema (same platform as the other Olympic venues).
//
// This is a SEPARATE importer from import-olympic-cinemas (which handles
// Selfridges, Power Station and Arches). Barnes is isolated so that the
// working multi-venue importer cannot be affected, and so that Barnes
// screenings use the cinema_name "Olympic Cinema Barnes" and a Barnes-only
// source_reference prefix.
//
// The olympiccinema.com/whats-on page is Barnes-only: its date-sections
// contain film links and mycloudcinema booking buttons with no venue h6
// headings (the Selfridges/Power Station references on the page are only in
// the site navigation, not in the programme sections). The shared
// parseOlympicPage() parser handles the date-section + booking-button markup
// directly. All parsed screenings are treated as Barnes.
//
// Booking URLs are mycloudcinema (#/book/{id}) and the numeric booking id is
// used as the stable source_reference: olympic:barnes:{bookingId}.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonOffsetMinutes,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  parseOlympicPage,
  fallbackSourceRef,
  type ParsedOlympicScreening,
} from "../_shared/olympicParser.ts";

const WHATSON_URL = "https://www.olympiccinema.com/whats-on";
const SITE_BASE = "https://www.olympiccinema.com";
const CINEMA_NAME = "Olympic Cinema Barnes";
const PREFIX = "barnes";
const MIN_SCREENINGS = 3;

const fetchOpts: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow" as const,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-olympic-barnes] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Olympic Cinema Barnes.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  let html: string;
  try {
    const resp = await fetch(WHATSON_URL, fetchOpts);
    if (!resp.ok) {
      const msg = `Failed to fetch Barnes programme: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    html = await resp.text();
    console.log(`[import-olympic-barnes] fetched ${html.length} bytes`);
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  let parsed: ParsedOlympicScreening[] = [];
  let parseErrors: string[] = [];
  try {
    const result = parseOlympicPage(html, SITE_BASE, nowLondon);
    parsed = result.screenings;
    parseErrors = parsed
      .filter((p) => p.parse_error)
      .map((p) => p.parse_error as string);
    console.log(
      `[import-olympic-barnes] parsed ${parsed.length} screenings, ${parseErrors.length} errors`
    );
  } catch (err) {
    const msg = `Parse error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }

  if (parsed.length < MIN_SCREENINGS) {
    const msg = `Unusually low screening count (${parsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", parsed.length, 0, msg);
    return jsonResponse({ success: false, error: msg, screenings_found: parsed.length }, 500);
  }

  const upcoming = parsed.filter(
    (p) =>
      p.start_time_iso !== null &&
      new Date(p.start_time_iso).getTime() > nowUtc.getTime()
  );
  const skippedPast = parsed.length - upcoming.length;
  console.log(
    `[import-olympic-barnes] ${upcoming.length} upcoming, ${skippedPast} past skipped`
  );

  // Deduplicate by source_reference before commit.
  const seen = new Set<string>();
  const records: ScreeningRecord[] = upcoming
    .filter((p) => p.start_time_iso !== null)
    .map((p) => {
      const sourceRef = p.booking_id
        ? `olympic:${PREFIX}:${p.booking_id}`
        : fallbackSourceRef(PREFIX, p.movie_title, p.start_time_iso!);
      return {
        cinema_name: CINEMA_NAME,
        movie_title: p.movie_title,
        start_time: p.start_time_iso!,
        booking_url: p.booking_url,
        format: p.status_label,
        sold_out: p.sold_out,
        source_reference: sourceRef,
        last_seen_at: new Date().toISOString(),
      };
    })
    .filter((r) => {
      if (seen.has(r.source_reference)) return false;
      seen.add(r.source_reference);
      return true;
    });

  const { saved, errors } = await commitImport(ctx, records, nowUtc);
  if (errors.length > 0) {
    const msg = `Import errors: ${errors.join("; ")}`;
    await endRun(ctx, runId, "failed", parsed.length, saved, msg);
    return jsonResponse(
      { success: false, error: msg, screenings_found: parsed.length, screenings_saved: saved },
      500
    );
  }

  await endRun(ctx, runId, "success", parsed.length, saved);
  console.log(`[import-olympic-barnes] done: found=${parsed.length} saved=${saved}`);

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    parse_errors: parseErrors.slice(0, 10),
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    examples: upcoming.slice(0, 5).map((p) => ({
      movie_title: p.movie_title,
      start_time: p.start_time_iso,
      source_reference: p.booking_id
        ? `olympic:${PREFIX}:${p.booking_id}`
        : fallbackSourceRef(PREFIX, p.movie_title, p.start_time_iso!),
      booking_url: p.booking_url,
      format: p.status_label,
      sold_out: p.sold_out,
    })),
  });
});
