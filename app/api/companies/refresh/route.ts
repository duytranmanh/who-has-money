import { fundingRefresh } from "@/lib/funding-api";

export async function POST() {
  return fundingRefresh();
}
