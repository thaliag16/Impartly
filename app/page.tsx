import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 32, margin: "0 0 8px" }}>Impartly</h1>
      <p style={{ fontSize: 17, lineHeight: 1.5, margin: "0 0 24px" }}>
        Your newsletters, summarized and read to you. So far: the Phase 0
        audio test and connecting Gmail (read-only).
      </p>
      <p style={{ margin: "0 0 24px" }}>
        <Link href="/mail">Mail connection</Link>
      </p>
      <Link
        href="/spike"
        style={{
          display: "inline-block",
          padding: "14px 20px",
          borderRadius: 12,
          background: "#1f1e1d",
          color: "#faf9f5",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Open the audio test
      </Link>
    </main>
  );
}
