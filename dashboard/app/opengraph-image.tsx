import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "flex-end",
          background: "#ffffff",
          padding: "72px 80px",
          fontFamily: "'DM Sans', -apple-system, sans-serif",
          position: "relative",
        }}
      >
        {/* Top-right badge strip: platform pills */}
        <div
          style={{
            position: "absolute",
            top: 64,
            right: 80,
            display: "flex",
            gap: 12,
          }}
        >
          {["ChatGPT", "Claude", "Gemini"].map((name) => (
            <div
              key={name}
              style={{
                background: "#f3f4f6",
                color: "#4b5563",
                borderRadius: 0,
                padding: "8px 18px",
                fontSize: 20,
                fontWeight: 500,
                border: "1px solid #e5e7eb",
              }}
            >
              {name}
            </div>
          ))}
        </div>

        {/* Logo word mark */}
        <div
          style={{
            fontSize: 32,
            fontWeight: 700,
            color: "#111827",
            letterSpacing: "-0.5px",
            marginBottom: 28,
          }}
        >
          tallei
        </div>

        {/* Hero headline */}
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            color: "#111827",
            lineHeight: 1.1,
            letterSpacing: "-1.5px",
            maxWidth: 820,
            marginBottom: 24,
          }}
        >
          Your AI assistants should really talk to each other.
        </div>

        {/* Sub-tagline */}
        <div
          style={{
            fontSize: 28,
            fontWeight: 400,
            color: "#4b5563",
            lineHeight: 1.4,
            maxWidth: 740,
          }}
        >
          One memory. Every AI assistant. Always in sync.
        </div>

        {/* Bottom accent bar */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 6,
            background: "#111827",
          }}
        />
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
