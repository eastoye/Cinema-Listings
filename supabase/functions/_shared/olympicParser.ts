// Shared parser for Olympic/mycloudcinema whats-on pages.
// Used by import-olympic-cinemas edge function.

import {
  londonToUtc,
  inferYear,
  decodeEntities,
  stripTags,
} from "./importSafety.ts";

export interface ParsedOlympicScreening {
  movie_title: string;
  start_time_iso: string | null;
  venue_label: string;
  booking_url: string | null;
  booking_id: string | null;
  film_slug: string;
  film_url: string;
  status_label: string | null;
  sold_out: boolean;
  parse_error?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Parse a date heading. Supports both orderings, with optional year:
//   "Sunday July 19"  /  "Sunday July 19 2026"
//   "Sunday 19 July"  /  "Sunday 19 July 2026"
function parseDateHeading(
  text: string
): { day: number; month: number; year: number | null } | null {
  const trimmed = text.trim();
  // Format A: weekday  month  day  [year]  — "Sunday July 19"
  let m = trimmed.match(/^(?:[A-Za-z]+)\s+([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    return { day: parseInt(m[2], 10), month, year: m[3] ? parseInt(m[3], 10) : null };
  }
  // Format B: weekday  day  month  [year]  — "Sunday 19 July"
  m = trimmed.match(/^(?:[A-Za-z]+)\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    return { day: parseInt(m[1], 10), month, year: m[3] ? parseInt(m[3], 10) : null };
  }
  return null;
}

// Parse 24h time like "19:30".
function parse24hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

// Normalise a title for fallback source_reference.
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Extract numeric booking ID from a mycloudcinema URL.
export function extractBookingId(url: string): string | null {
  const m = url.match(/mycloudcinema\.com\/#\/book\/(\d+)/);
  return m ? m[1] : null;
}

// Extract a format label from the booking URL suffix.
function extractFormatFromUrl(url: string): string | null {
  const m = url.match(/mycloudcinema\.com\/#\/book\/\d+\/([a-z-]+)/);
  if (!m) return null;
  const suffix = m[1];
  if (suffix === "preview-screening") return "Preview Screening";
  if (suffix === "q&a" || suffix === "q-amp-a") return "Q&A";
  return suffix;
}

// Parse a single Olympic/mycloudcinema whats-on page.
// Returns raw screenings with venue_label set; the caller assigns cinema_name
// and source_reference based on the page source and venue label.
export function parseOlympicPage(
  html: string,
  baseUrl: string,
  nowLondon: Date
): ParsedOlympicScreening[] {
  const results: ParsedOlympicScreening[] = [];

  // Split by date sections. Extract the h3 date heading and everything
  // until the next date-section or end of the container.
  const sectionRegex = /<section class="date-section">/g;
  const sectionStarts: number[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sectionRegex.exec(html)) !== null) {
    sectionStarts.push(sm.index);
  }

  for (let si = 0; si < sectionStarts.length; si++) {
    const start = sectionStarts[si];
    const end = si + 1 < sectionStarts.length ? sectionStarts[si + 1] : html.length;
    const sectionBody = html.slice(start, end);

    // Extract date from h3.
    const dateMatch = sectionBody.match(
      /<h3[^>]*class="date-day[^"]*"[^>]*>([^<]+)<\/h3>/
    );
    if (!dateMatch) continue;
    const dateText = stripTags(dateMatch[1]).trim();
    const dateParts = parseDateHeading(dateText);
    if (!dateParts) continue;

    const year =
      dateParts.year ?? inferYear(dateParts.day, dateParts.month, nowLondon);

    // Find all film link anchors to delimit film blocks.
    // Matching the full <a ...>...</a> tag ensures the block starts at the
    // opening <a, so nested booking buttons are included in the block.
    const filmLinkRegex =
      /<a\s+[^>]*href="\/film\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const filmLinks: { slug: string; index: number; title: string }[] = [];
    let flMatch: RegExpExecArray | null;
    while ((flMatch = filmLinkRegex.exec(sectionBody)) !== null) {
      const anchorTitle = decodeEntities(stripTags(flMatch[2])).trim();
      filmLinks.push({ slug: flMatch[1], index: flMatch.index, title: anchorTitle });
    }

    for (let i = 0; i < filmLinks.length; i++) {
      const { slug, title: anchorTitle } = filmLinks[i];
      const blockStart = filmLinks[i].index;
      const blockEnd =
        i + 1 < filmLinks.length ? filmLinks[i + 1].index : sectionBody.length;
      const block = sectionBody.slice(blockStart, blockEnd);

      // Title: prefer the anchor text, fall back to img alt, then slug.
      let movieTitle: string | null = anchorTitle || null;
      if (!movieTitle) {
        const altMatch = block.match(/<img[^>]*alt="([^"]+)"/);
        if (altMatch && altMatch[1].trim() && !altMatch[1].startsWith("BBFC")) {
          movieTitle = decodeEntities(altMatch[1]).trim();
        }
      }
      if (!movieTitle) {
        movieTitle = slug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (!movieTitle) continue;

      const filmUrl = `${baseUrl}/film/${slug}`;

      // Extract h6 venue label.
      const h6Match = block.match(/<h6[^>]*>([^<]+)<\/h6>/);
      const venueLabel = h6Match ? h6Match[1].trim() : "";

      // Find booking button anchors directly by their class pattern.
      // These are <a class="btn btn-{venue} ..." href="...mycloudcinema.../book/{id}">
      // containing <span class="btn-times-fs">time</span>.
      // The href and class attributes can appear in any order.
      const btnAnchorRegex =
        /<a\s+[^>]*class="[^"]*btn\s+btn-[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
      let btnMatch: RegExpExecArray | null;
      while ((btnMatch = btnAnchorRegex.exec(block)) !== null) {
        const fullAnchor = btnMatch[0];
        const innerContent = btnMatch[1];

        // Extract href from the anchor.
        const hrefMatch = fullAnchor.match(/href="([^"]*)"/);
        const rawHref = hrefMatch ? hrefMatch[1] : null;

        // Extract time.
        const timeMatch = innerContent.match(
          /<span class="btn-times-fs"[^>]*>([^<]+)<\/span>/
        );
        if (!timeMatch) continue;
        const timeText = timeMatch[1].trim();
        const timeParts = parse24hTime(timeText);
        if (!timeParts) {
          results.push({
            movie_title: movieTitle,
            start_time_iso: null,
            venue_label: venueLabel,
            booking_url: null,
            booking_id: null,
            film_slug: slug,
            film_url: filmUrl,
            status_label: null,
            sold_out: false,
            parse_error: `Unparseable time: "${timeText}"`,
          });
          continue;
        }

        const bookingId = rawHref ? extractBookingId(rawHref) : null;
        const bookingUrl = rawHref && bookingId ? rawHref : null;

        // Extract status label (e.g., "Last Few").
        const statusMatch = innerContent.match(
          /<span class="ms-2[^"]*"[^>]*>([^<]+)<\/span>/
        );
        const rawStatus = statusMatch ? statusMatch[1].trim() : null;
        const statusLabel = rawStatus || null;

        // Check for sold-out indicators.
        const soldOut =
          /sold[- ]?out/i.test(btnMatch[0]) ||
          /class="[^"]*(?:inactive|disabled)[^"]*"/.test(btnMatch[0]);

        // Format from URL suffix.
        const formatFromUrl = bookingUrl
          ? extractFormatFromUrl(bookingUrl)
          : null;

        const utc = londonToUtc(
          year,
          dateParts.month,
          dateParts.day,
          timeParts.hour,
          timeParts.minute
        );

        results.push({
          movie_title: movieTitle,
          start_time_iso: utc.toISOString(),
          venue_label: venueLabel,
          booking_url: bookingUrl,
          booking_id: bookingId,
          film_slug: slug,
          film_url: filmUrl,
          status_label: statusLabel ?? formatFromUrl,
          sold_out: soldOut,
        });
      }
    }
  }

  return results;
}

// Build a stable source_reference for a screening without a booking ID.
export function fallbackSourceRef(
  prefix: string,
  title: string,
  startIso: string
): string {
  const d = new Date(startIso);
  const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const timeStr = `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `olympic:${prefix}:${normaliseTitle(title)}:${dateStr}:${timeStr}`;
}
