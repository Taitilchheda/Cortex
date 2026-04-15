import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cortex — Local AI Coding Agent',
  description: 'Fully local, multi-model AI coding agent system. Build entire projects, chat with AI, and refactor codebases — all running on your machine with Ollama.',
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body suppressHydrationWarning>
        <Providers>
          {children}
          <Toaster position="bottom-right" expand={false} richColors closeButton toastOptions={{ style: { background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-1)' } }} />
        </Providers>
      </body>
    </html>
  );
}
