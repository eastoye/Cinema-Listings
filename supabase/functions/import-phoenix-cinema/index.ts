// Phoenix Cinema (East Finchley) importer.
//
// Source: https://www.phoenixcinema.co.uk/whats-on
// Provider: Savoy Systems. The whats-on page embeds a JSON blob of the form
// {"Events":[{...,"Performances":[...]}]} — the same shape used by The Lexi
// Cinema and Rio Cinema. Each Performance carries an ID (used as the stable
// performance id), StartDate (YYYY-MM-DD), StartTimeAndNotes (HH:MM),
// AuditoriumName (Screen 1 / Screen 2), IsSoldOut ("Y"/"N") and a relative
// booking URL ending in TcsPerformance_{id}.
//
// The booking URL is relative to the Phoenix .dll path, so it is prefixed with
// the Savoy base. Performance ID is the stable source_reference.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonToUtc,
  decodeEntities,
  stripTags,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";

const WHATSON_URL = "https://www.phoenixcinema.co.uk/whats-on";
const SAVOY_BASE = "https://www.phoenixcinema.co.uk/PhoenixCinemaLondon.dll/";
const CINEMA_NAME = "Phoenix Cinema";
const SOURCE_PREFIX = "phoenix";
const MIN_SCREENINGS = 3;

interface PhoenixPerformance {
  ID: number;
  IsSoldOut: string; // "Y" / "N"
  BB: string; // Bring Baby
  CC: string; // Closed Caption / open caption
  AD: string; // Audio Described
  R: string; // Relaxed
  QA: string; // Q&A
  SU: string; // Subtitled
  StartDate: string; // YYYY-MM-DD
  StartTimeAndNotes: string; // HH:MM
  Notes: string;
  StartTime: string;
  ReadableDate: string;
  AuditoriumName: string;
  AuditoriumID: number;
  URL: string; // relative booking URL
  IsOpenForSale: boolean;
}

interface PhoenixEvent {
  ID: number;
  Title: string;
  Rating: string;
  TypeDescription: string; // "Film", "Phoenix Classics", "Opera", "Ballet & Dance", ...
  Tags: { Format: string }[];
  Performances: PhoenixPerformance[];
}

interface PhoenixData {
  Events: PhoenixEvent[];
}

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string | null;
  booking_url: string;
  performance_id: string;
  format: string | null;
  sold_out: boolean;
  source_reference: string;
  parse_error?: string;
}

function parse24hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

// Build a format/label string from performance flags, event type and notes.
// Preserves the Phoenix-specific labels listed in the task brief.
function buildFormat(
  ev: PhoenixEvent,
  p: PhoenixPerformance
): string | null {
  const labels: string[] = [];
  const typeDesc = (ev.TypeDescription || "").trim();
  if (typeDesc && !/^film$/i.test(typeDesc)) labels.push(typeDesc);
  if (p.BB === "Y") labels.push("Parent and Baby");
  if (p.CC === "Y") labels.push("open caption");
  if (p.AD === "Y") labels.push("audio described");
  if (p.R === "Y") labels.push("relaxed");
  if (p.QA === "Y") labels.push("Q&A");
  if (p.SU === "Y") labels.push("subtitled");
  if (p.Notes && p.Notes.trim()) labels.push(p.Notes.trim());
  if (p.AuditoriumName && p.AuditoriumName.trim()) labels.push(p.AuditoriumName.trim());
  return labels.length > 0 ? labels.join(", ") : null;
}

// Extract the embedded {"Events":[...]} JSON blob from the whats-on HTML.
function extractEventsJson(html: string): string {
  const startIdx = html.indexOf('{"Events":[');
  if (startIdx < 0) {
    throw new Error('Could not find Events JSON in Phoenix whats-on page.');
  }
  let depth = 0;
  let i = startIdx;
  while (i < html.length) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  return html.slice(startIdx, i + 1);
}

function parsePhoenix(html: string): ParsedScreening[] {
  const jsonStr = extractEventsJson(html);
  const data = JSON.parse(jsonStr) as PhoenixData;
  const results: ParsedScreening[] = [];

  for (const ev of data.Events) {
    const title = decodeEntities(stripTags(ev.Title)).trim();
    if (!title) continue;
    for (const p of ev.Performances) {
      const perfId = String(p.ID);
      const bookingUrl = p.URL ? SAVOY_BASE + p.URL : "";
      const format = buildFormat(ev, p);

      const timeParts = parse24hTime(p.StartTimeAndNotes);
      if (!timeParts) {
        results.push({
          movie_title: title,
          start_time_iso: null,
          booking_url: bookingUrl,
          performance_id: perfId,
          format,
          sold_out: p.IsSoldOut === "Y",
          source_reference: `${SOURCE_PREFIX}:${perfId}`,
          parse_error: `Unparseable time: "${p.StartTimeAndNotes}"`,
        });
        continue;
      }
      const dateParts = p.StartDate.split("-").map((n) => parseInt(n, 10));
      if (dateParts.length !== 3 || dateParts.some(isNaN)) {
        results.push({
          movie_title: title,
          start_time_iso: null,
          booking_url: bookingUrl,
          performance_id: perfId,
          format,
          sold_out: p.IsSoldOut === "Y",
          source_reference: `${SOURCE_PREFIX}:${perfId}`,
          parse_error: `Unparseable date: "${p.StartDate}"`,
        });
        continue;
      }
      const utc = londonToUtc(
        dateParts[0],
        dateParts[1],
        dateParts[2],
        timeParts.hour,
        timeParts.minute
      );
      results.push({
        movie_title: title,
        start_time_iso: utc.toISOString(),
        booking_url: bookingUrl,
        performance_id: perfId,
        format,
        sold_out: p.IsSoldOut === "Y",
        source_reference: `${SOURCE_PREFIX}:${perfId}`,
      });
    }
  }
  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-phoenix-cinema] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Phoenix Cinema.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  let html: string;
  try {
    const resp = await fetch(WHATSON_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      const msg = `Failed to fetch programme: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    html = await resp.text();
    console.log(`[import-phoenix-cinema] fetched ${html.length} bytes`);
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    parsed = parsePhoenix(html);
    parseErrors = parsed.filter((p) => p.parse_error).map((p) => p.parse_error as string);
    console.log(`[import-phoenix-cinema] parsed ${parsed.length} screenings, ${parseErrors.length} errors`);
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

  const nowUtc = new Date();
  const upcoming = parsed.filter(
    (p) => p.start_time_iso !== null && new Date(p.start_time_iso).getTime() > nowUtc.getTime()
  );
  const skippedPast = parsed.length - upcoming.length;
  console.log(`[import-phoenix-cinema] ${upcoming.length} upcoming, ${skippedPast} past skipped`);

  // Deduplicate by source_reference before commit.
  const seen = new Set<string>();
  const records: ScreeningRecord[] = upcoming
    .filter((p) => p.start_time_iso !== null && p.source_reference)
    .filter((p) => {
      if (seen.has(p.source_reference)) return false;
      seen.add(p.source_reference);
      return true;
    })
    .map((p) => ({
      cinema_name: CINEMA_NAME,
      movie_title: p.movie_title,
      start_time: p.start_time_iso as string,
      booking_url: p.booking_url || null,
      format: p.format,
      sold_out: p.sold_out,
      source_reference: p.source_reference,
      last_seen_at: new Date().toISOString(),
    }));

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
  console.log(`[import-phoenix-cinema] done: found=${parsed.length} saved=${saved}`);

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
      source_reference: p.source_reference,
      booking_url: p.booking_url || null,
      format: p.format,
      sold_out: p.sold_out,
    })),
  });
});
