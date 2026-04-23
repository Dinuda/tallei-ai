import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <svg
        width="180"
        height="180"
        viewBox="0 0 256 256"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Tallei"
      >
        <rect x="8" y="8" width="240" height="240" rx="58" fill="#080D1A" stroke="#394055" strokeWidth="8" />
        <rect x="68" y="74" width="24" height="110" rx="12" fill="#F5F7FC" />
        <rect x="102" y="74" width="24" height="110" rx="12" fill="#F5F7FC" />
        <rect x="136" y="74" width="24" height="110" rx="12" fill="#F5F7FC" />
        <rect x="170" y="74" width="24" height="110" rx="12" fill="#F5F7FC" />
        <path d="M62 126L69 103L188 139L181 161L62 126Z" fill="#F5F7FC" />
      </svg>
    ),
    { ...size }
  );
}
