/**
 * Operator directive 2026-09-07 ("yes, US only"): the candidate applies to
 * United States postings only. Six non-US Stripe intern postings (Dublin,
 * Toronto, Bucharest, Bengaluru, Singapore, London) had been submitted from
 * a board sweep because nothing looked at location. This classifier is
 * shared by JobRight feed eligibility and the ATS board sweep.
 *
 * Verdicts:
 * - "us":      a US signal is present (country, state name/abbreviation,
 *              "US remote").
 * - "non_us":  a non-US country, or a well-known non-US city, with no US
 *              signal.
 * - "unknown": empty, bare "Remote", or a city we cannot place. Unknown is
 *              NOT a rejection — a bare city like "Baltimore" must not be
 *              filtered; it is surfaced as a warning instead.
 */

export type LocationVerdict = "us" | "non_us" | "unknown";

const US_COUNTRY_RE =
  /\b(united states( of america)?|u\.?s\.?a?\.?|usa)\b(?![a-z])/i;

const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia", "puerto rico",
];

const US_STATE_ABBR = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC", "PR",
];

/** ", CA" / ", NY 10001" / "Austin, TX" — an abbreviation after a comma. */
const US_STATE_ABBR_RE = new RegExp(
  `,\\s*(${US_STATE_ABBR.join("|")})(?:\\s+\\d{5})?\\b(?![a-z])`,
);

const US_STATE_NAME_RE = new RegExp(
  `(?<![a-z])(${US_STATE_NAMES.map((s) => s.replace(/ /g, "\\s+")).join("|")})(?![a-z])`,
  "i",
);

const NON_US_COUNTRIES = [
  "canada", "mexico", "united kingdom", "uk", "england", "scotland", "wales",
  "northern ireland", "ireland", "germany", "france", "spain", "portugal",
  "italy", "netherlands", "belgium", "luxembourg", "switzerland", "austria",
  "poland", "czech republic", "czechia", "romania", "hungary", "bulgaria",
  "greece", "sweden", "norway", "denmark", "finland", "iceland", "estonia",
  "latvia", "lithuania", "ukraine", "turkey", "israel", "united arab emirates",
  "uae", "saudi arabia", "qatar", "egypt", "nigeria", "kenya", "south africa",
  "india", "pakistan", "bangladesh", "sri lanka", "singapore", "malaysia",
  "indonesia", "philippines", "vietnam", "thailand", "china", "hong kong",
  "taiwan", "japan", "south korea", "korea", "australia", "new zealand",
  "brazil", "argentina", "chile", "colombia", "peru", "costa rica",
];

const NON_US_CITIES = [
  "london", "dublin", "cork", "edinburgh", "manchester", "belfast", "cambridge uk",
  "toronto", "vancouver", "montreal", "montréal", "ottawa", "calgary", "edmonton",
  "waterloo", "kitchener", "mississauga",
  "mexico city", "guadalajara", "monterrey",
  "berlin", "munich", "münchen", "hamburg", "frankfurt", "paris", "amsterdam",
  "brussels", "zurich", "zürich", "geneva", "vienna", "warsaw", "krakow", "kraków",
  "prague", "bucharest", "budapest", "lisbon", "madrid", "barcelona", "milan",
  "rome", "stockholm", "oslo", "copenhagen", "helsinki", "tallinn", "athens",
  "tel aviv", "dubai", "riyadh", "istanbul", "cairo", "lagos", "nairobi",
  "johannesburg", "cape town",
  "bengaluru", "bangalore", "hyderabad", "mumbai", "pune", "chennai", "gurgaon",
  "gurugram", "noida", "new delhi", "delhi", "kolkata",
  "singapore", "kuala lumpur", "jakarta", "manila", "bangkok", "ho chi minh",
  "hanoi", "shanghai", "beijing", "shenzhen", "hong kong", "taipei", "tokyo",
  "osaka", "seoul", "sydney", "melbourne", "brisbane", "auckland",
  "são paulo", "sao paulo", "buenos aires", "santiago", "bogotá", "bogota", "lima",
];

const NON_US_RE = new RegExp(
  `(?<![a-z])(${[...NON_US_COUNTRIES, ...NON_US_CITIES]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
    .join("|")})(?![a-z])`,
  "i",
);

function hasUsSignal(text: string): boolean {
  return (
    US_COUNTRY_RE.test(text) ||
    US_STATE_ABBR_RE.test(text) ||
    US_STATE_NAME_RE.test(text) ||
    /\bremote\b[^a-z]{0,6}\b(us|usa)\b/i.test(text) ||
    /\b(us|usa)\b[^a-z]{0,6}\bremote\b/i.test(text)
  );
}

/** Classify a posting's location string. Never throws. */
export function classifyLocation(location: string | null | undefined): {
  verdict: LocationVerdict;
  evidence: string;
} {
  const text = (location ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { verdict: "unknown", evidence: "no location on the posting" };
  if (hasUsSignal(text)) return { verdict: "us", evidence: `US signal in "${text}"` };
  const m = NON_US_RE.exec(text);
  if (m) {
    return { verdict: "non_us", evidence: `non-US location "${text}" (matched "${m[1]}")` };
  }
  if (/^\s*remote\s*$/i.test(text)) {
    return { verdict: "unknown", evidence: `bare "Remote" — country unspecified` };
  }
  return { verdict: "unknown", evidence: `could not place "${text}"` };
}
