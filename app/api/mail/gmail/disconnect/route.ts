import "server-only";
import type { NextRequest } from "next/server";
import { handleDisconnect } from "../../../../../lib/routes/gmail";
import { gmailRouteDeps } from "../../../../../lib/routes/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return handleDisconnect(request, gmailRouteDeps());
}
