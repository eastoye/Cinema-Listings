// TMDB image configuration. The poster_path stored in the `movies` table is
// combined with a size prefix to build a full URL. Only the small poster size
// is needed for compact list rows.
// See: https://developer.themoviedb.org/docs/image-basics

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";
const POSTER_SIZE = "w185";

export function posterUrl(posterPath) {
  if (typeof posterPath !== "string" || !posterPath.trim()) return null;
  const path = posterPath.trim();
  if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(path)) return null;
  return `${TMDB_IMAGE_BASE}${POSTER_SIZE}${path}`;
}

export function verifiedArtworkUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function movieArtworkUrl(movie) {
  if (!movie) return null;

  if (movie.manually_confirmed === true) {
    return (
      verifiedArtworkUrl(movie.poster_override_url) || posterUrl(movie.poster_path)
    );
  }

  if (movie.match_status === "matched") {
    return posterUrl(movie.poster_path);
  }

  return null;
}