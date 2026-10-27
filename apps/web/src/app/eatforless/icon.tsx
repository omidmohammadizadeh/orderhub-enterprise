import { ImageResponse } from "next/og";

// The Eat For Less tab icon: the lime "£" mark.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          background: "#D4FF3F",
          borderRadius: "8px 16px 16px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#0B0B0B",
          fontSize: 20,
          fontWeight: 800,
          fontFamily: "sans-serif",
        }}
      >
        £
      </div>
    ),
    size,
  );
}
