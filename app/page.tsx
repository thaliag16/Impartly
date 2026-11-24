import Link from "next/link";

export default function Home() {
  return (
    <main className="px-page">
      <header className="px-header">
        <span className="px-wordmark">impartly</span>
      </header>
      <div className="px-field">
        <h1 className="px-h1">Your newsletters, read to you.</h1>
        <p className="px-body">
          So far: pick the newsletters you want, set when your briefing is ready, connect Gmail (optional, read-only) and try the Phase 0 audio test.
        </p>
      </div>
      <Link href="/newsletters" className="px-btn px-btn-primary">
        Pick newsletters
      </Link>
      <nav aria-label="More" className="px-row">
        <Link href="/settings" className="px-btn">
          Delivery time
        </Link>
        <Link href="/mail" className="px-btn">
          Mail connection
        </Link>
        <Link href="/spike" className="px-btn">
          Open the audio test
        </Link>
      </nav>
    </main>
  );
}
