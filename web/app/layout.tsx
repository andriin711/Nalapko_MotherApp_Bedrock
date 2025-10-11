'use client';
import './globals.css';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onChat = pathname === '/chat' || pathname.startsWith('/chat/');

  return (
    <html lang="en">
      <body>
        {/* Hide on /chat AND in backend /preview */}
        {!onChat && (
          <header data-hide-in-preview>
          </header>
        )}

        <div className="min-h-screen flex">
          <main className="flex-1">{children}</main>
        </div>

        {/* Example: footer hidden in preview but shown on normal routes (including /chat if you wish) */}
        {!onChat && (
          <footer className="text-center text-xs text-gray-500 py-4" data-hide-in-preview>
            © {new Date().getFullYear()} Example Co.
          </footer>
        )}
      </body>
    </html>
  );
}