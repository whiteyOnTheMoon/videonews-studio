/**
 * Source provenance boundary for personally reviewed AI price/FX snapshots.
 *
 * The URL is a human audit reference, NEVER proof that the numbers are
 * accurate/current. No HTTP fetch or model/price/FX value is hardcoded here.
 * Only official published vendor or central-bank document locations qualify.
 */
export type ReviewSourceKind = "openai" | "google_gemini" | "eur_usd";

const OFFICIAL_DOCUMENTS: Readonly<Record<ReviewSourceKind, ReadonlyArray<readonly [string, string]>>> =
  Object.freeze({
    openai: [
      ["developers.openai.com", "/api/docs/pricing"],
      ["platform.openai.com", "/docs/pricing"],
      ["openai.com", "/api/pricing"],
      ["openai.com", "/api"],
    ],
    google_gemini: [["ai.google.dev", "/gemini-api/docs/pricing"]],
    eur_usd: [
      ["www.ecb.europa.eu", "/stats/policy_and_exchange_rates/euro_reference_exchange_rates/"],
      ["data.ecb.europa.eu", "/key-figures/ecb-interest-rates-and-exchange-rates/exchange-rates"],
      ["data.ecb.europa.eu", "/methodology/exchange-rates"],
      ["data-api.ecb.europa.eu", "/service/data/EXR/D.USD.EUR.SP00.A"],
    ],
  });

export function officialPriceReviewSource(kind: ReviewSourceKind, value: unknown): boolean {
  if (
    !Object.hasOwn(OFFICIAL_DOCUMENTS, kind) ||
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 512 ||
    value !== value.trim() ||
    !value.startsWith("https://") ||
    /[\s\\@]/.test(value)
  ) {
    return false;
  }
  try {
    const source = new URL(value);
    if (
      source.protocol !== "https:" ||
      source.username !== "" ||
      source.password !== "" ||
      source.port !== "" ||
      source.hash !== "" ||
      source.pathname.includes("%") ||
      source.hostname.endsWith(".")
    ) {
      return false;
    }
    return OFFICIAL_DOCUMENTS[kind].some(
      ([host, path]) =>
        source.hostname === host &&
        (source.pathname === path ||
          source.pathname === path + "/" ||
          (path.endsWith("/") && source.pathname.startsWith(path))),
    );
  } catch {
    return false;
  }
}
