import {
  dormantPriceReviewProxy,
  priceReviewProxyConfig,
} from "../../../../lib/admin-price-fx-review-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return dormantPriceReviewProxy(request, priceReviewProxyConfig(process.env));
}
