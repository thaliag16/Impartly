import type { NextRequest } from "next/server";
import { handleSignIn } from "../../../lib/routes/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return handleSignIn(request);
}
