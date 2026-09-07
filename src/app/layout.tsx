import './globals.css';
import './login-transition-tuning.css';
import type { Metadata } from 'next';
import { geistSans, geistMono } from '@/app/fonts';
import { RootProviders } from '@/components/providers/RootProviders';

// Now that the root layout is a Server Component, it can carry app-wide metadata.
// A plain default title (no template) so pages that set their own title keep it.
export const metadata: Metadata = {
  title: 'AFCT Dashboard',
  description: 'Automata-focused course tooling for building and grading assignments.',
};

/**
 * Every page renders per request, because every page needs a nonce.
 *
 * `src/proxy.ts` sends a Content-Security-Policy carrying a fresh nonce on each response, and
 * Next stamps that nonce onto its script tags only while rendering per request. A page
 * prerendered at build time has HTML that predates the nonce, so the browser blocks every script
 * on it: the page loads, nothing hydrates, and the reader sees a blank screen with no error.
 * That is what happened to /lti/complete, /forgot-password and /reset-password at once.
 *
 * Set here rather than page by page because the rule follows from the policy, not from any one
 * page, and because route segment config is silently ignored in a 'use client' file, which is
 * what two of those three pages are. Nothing is lost: this app is session-scoped and
 * database-backed, so there was nothing worth prerendering.
 *
 * `scripts/check-prerendered-pages.mjs` fails the build if a page escapes this.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* KaTeX, self-hosted from public/katex (see scripts/vendor-katex.mjs). Linked rather
            than imported, which is exactly what no-css-tags warns about, and is the point: the
            stylesheet's 60 relative font urls would otherwise become 60 bundler modules in the
            chunk graph of every route that renders maths, and dev compiles stalled for minutes.
            It is a static third-party stylesheet that never changes between builds, so Next's
            CSS pipeline buys nothing here. Same origin, never a CDN. */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/katex/katex.min.css" />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} flex antialiased`}>
        <RootProviders>{children}</RootProviders>
      </body>
    </html>
  );
}
