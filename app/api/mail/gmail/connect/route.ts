import "server-only";
import type { NextRequest } from "next/server";
import { handleConnect } from "../../../../../lib/routes/gmail";
import { gmailRouteDeps } from "../../../../../lib/routes/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handleConnect(request, gmailRouteDeps());
}
