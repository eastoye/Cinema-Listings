import { useEffect, useState } from "react";
import { londonTime, londonDateHeading, isToday } from "./time.js";
import { movieArtworkUrl, verifiedArtworkUrl } from "./posterUrl.js";

function ChevronIcon() {
  return (
    <svg
      className="s-cta-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function fallbackCategory(title) {
  if (
    /\b(mystery|secret|surprise)\s+(movie|film|screening|showing)\b/i.test(
      title
    ) ||
    /\bundisclosed\s+(movie|film|title)\b/i.test(title) ||
    /^(?:.{2,50}\s*[-:]\s*)?mystery\b.{0,80}\b(?:cinema|matinees?|marathon)\b/i.test(
      title.trim()
    )
  ) {
    return "Mystery Film";
  }
  if (
    /\b(double|triple)\s+(bill|feature)\b/i.test(title) ||
    /\ball[- ]?nighter\b/i.test(title) ||
    /\b(film|movie|season|series|trilogy|saga|franchise|mystery|horror|anime)\s+marathon\b/i.test(
      title
    ) ||
    /\bmarathon\s*(?:screening|programme|program|:|-)/i.test(title) ||
    /-a-thon\b/i.test(title)
  ) {
    return "Double Bill";
  }
  if (
    /\b(shorts?|short films?)\s+(programme|program|selection|showcase|collection|night)\b/i.test(
      title
    ) ||
    /\bprogramme\s+of\s+shorts?\b/i.test(title) ||
    /^shorts\b/i.test(title.trim())
  ) {
    return "Short Film Programme";
  }
  if (
    /^(?:nt live|national theatre live|met opera|royal ballet|royal opera|rbo live|exhibition on screen)\b/i.test(
      title.trim()
    ) ||
    /\b(event cinema|live broadcast|encore broadcast|in conversation)\b/i.test(
      title
    ) ||
    /\bepisodes?\s+\d+(?:\s*[-–—]\s*\d+)?\b/i.test(title)
  ) {
    return "Live Event";
  }
  return "General Screening";
}

function Poster({ screening }) {
  const movieUrl = movieArtworkUrl(screening.movies);
  const cinemaUrl = verifiedArtworkUrl(screening.verified_artwork_url);
  const [imageUrl, setImageUrl] = useState(movieUrl || cinemaUrl);

  useEffect(() => {
    setImageUrl(movieUrl || cinemaUrl);
  }, [movieUrl, cinemaUrl]);

  if (imageUrl) {
    return (
      <img
        className="poster"
        src={imageUrl}
        alt={`${screening.movie_title} artwork`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          if (cinemaUrl && imageUrl !== cinemaUrl) setImageUrl(cinemaUrl);
          else setImageUrl(null);
        }}
      />
    );
  }

  return (
    <div
      className="poster poster-placeholder"
      role="img"
      aria-label={`No confirmed artwork for ${screening.movie_title}`}
    >
      <span className="poster-placeholder-category">
        {fallbackCategory(screening.movie_title)}
      </span>
      <span className="poster-placeholder-title">{screening.movie_title}</span>
      <span className="poster-placeholder-cinema">{screening.cinema_name}</span>
    </div>
  );
}

export default function ScreeningRow({ screening }) {
  const soldOut = screening.sold_out === true;
  const bookable = Boolean(screening.booking_url) && !soldOut;

  const formats = screening.format
    ? screening.format
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  const content = (
    <>
      <Poster screening={screening} />
      <span className="s-time">{londonTime(screening.start_time)}</span>
      <span className="s-body">
        <span className="s-title">{screening.movie_title}</span>
        <span className="s-cinema">{screening.cinema_name}</span>
        <span className="s-meta">
          {formats.map((f) => (
            <span key={f} className="chip">
              {f}
            </span>
          ))}
          {soldOut && <span className="sold-badge">Sold out</span>}
        </span>
      </span>
      <span className="s-cta">
        {bookable ? (
          <>
            <span className="s-cta-text">Book</span>
            <ChevronIcon />
          </>
        ) : soldOut ? (
          <span className="s-cta-text">—</span>
        ) : (
          ""
        )}
      </span>
    </>
  );

  if (bookable) {
    return (
      <a
        className="screening"
        href={screening.booking_url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
    );
  }

  return (
    <div className="screening sold-out" aria-disabled="true">
      {content}
    </div>
  );
}

export function DayGroup({ dateKey, screenings }) {
  const heading = londonDateHeading(screenings[0].start_time);
  const today = isToday(screenings[0].start_time);
  return (
    <section className="day-group">
      <h2 className={`day-heading${today ? " today" : ""}`}>{heading}</h2>
      {screenings.map((s) => (
        <ScreeningRow key={s.id} screening={s} />
      ))}
    </section>
  );
}
