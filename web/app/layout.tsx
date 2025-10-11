// web/app/layout.tsx
import "./globals.css";

export const metadata = {
  title: "Bedrock AI Dev",
  description: "Chat + code editor preview",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* Use system font stack; no next/font / geist imports */}
      <body className="antialiased">{children}</body>
    </html>
  );
}
