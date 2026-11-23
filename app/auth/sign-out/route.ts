import type { NextRequest } from "next/server";
import { handleSignOut } from "../../../lib/routes/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return handleSignOut(request);
}
