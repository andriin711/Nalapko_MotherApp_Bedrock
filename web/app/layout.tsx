'use client';
import './globals.css';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

function Sidebar() {
  return (
    <div className="p-4">
      <h2 className="font-semibold">Sidebar</h2>
      <ul className="mt-2 space-y-1 text-sm">
        <li>Item A</li>
        <li>Item B</li>
        <li>Item C</li>
      </ul>
    </div>
  );
}

function GlobalBanner() {
  return (
    <div className="w-full text-center py-2 text-white" style={{ background: '#0ea5e9' }}>
      Welcome banner
    </div>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onChat = pathname === '/chat' || pathname.startsWith('/chat/');

  return (
    <html lang="en">
      <body>
        {/* Hide on /chat AND in backend /preview */}
        {!onChat && (
          <header data-hide-in-preview>
            <GlobalBanner />
          </header>
        )}

        <div className="min-h-screen flex">
          {/* Hide on /chat AND in backend /preview */}
          {!onChat && (
            <aside className="w-64 shrink-0 border-r" data-hide-in-preview>
              <Sidebar />
            </aside>
          )}

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
