import { connection } from "next/server";
import { fundingRead } from "@/lib/funding-api";

export async function GET() {
  // Snapshots live on the runtime data mount, outside the built image.
  await connection();
  return fundingRead();
}
