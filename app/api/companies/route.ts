import { fundingRead } from "@/lib/funding-api";

export async function GET() {
  return fundingRead();
}
