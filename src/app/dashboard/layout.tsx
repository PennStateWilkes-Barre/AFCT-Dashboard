import React from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

import DashboardSidebarShell from '@/components/DashboardSidebarShell';
import Navbar from '@/components/Navbar';
import { SidebarProvider } from '@/components/ui/sidebar';
import AuthGate from '@/components/AuthGate';
import { NavbarBreadcrumbProvider } from '@/components/navbar/NavbarBreadcrumbContext';
import QueryProvider from '@/components/providers/QueryProvider';
import UnsavedChangesProvider from '@/components/unsaved-changes/UnsavedChangesProvider';
import SessionWatcher from '@/components/session/SessionWatcher';
import DashboardEntryTransition from '@/components/dashboard/DashboardEntryTransition';

export const metadata: Metadata = {
  title: {
    default: 'AFCT Dashboard',
    template: 'AFCT Dashboard - %s',
  },
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const cookieStore = await cookies();
  const sidebarCookie = cookieStore.get('sidebar_state');
  // Default to open for first-time users (no cookie), otherwise use cookie value
  const defaultOpen = sidebarCookie ? sidebarCookie.value === 'true' : true;

  // Reject a missing session, or one the session callback marked inactive (a
  // disabled/deleted account or one whose idle-timeout has lapsed) so a stale
  // token can't SSR-render a dashboard page.
  if (!session || !session.user || session.user.inactive) {
    redirect('/login');
  }

  if (session.user.mustChangePassword) {
    redirect('/change-password');
  }

  return (
    <>
      {/* First in the tree on purpose: its script has to be parsed before the markup below it
          paints. See the component for why this is a script and not a hook. */}
      <DashboardEntryTransition />
      <SidebarProvider
        style={
          {
            '--sidebar-width': '16rem',
            // The mobile sheet ignored this variable until now (it hardcoded its own
            // default), so the 10rem declared here never actually applied. Set to the
            // width the drawer has really been rendering at; 10rem is too narrow for
            // rows like "Archived Courses" and has never been seen in practice.
            '--sidebar-width-mobile': '18rem',
            '--sidebar-width-icon': '3.5rem',
          } as React.CSSProperties
        }
        defaultOpen={defaultOpen}
      >
        <AuthGate>
          <QueryProvider>
            <SessionWatcher />
            {/* Inside QueryProvider, outside the page: every dashboard surface shares ONE guard,
              so two dirty forms cannot stack two confirmation dialogs. */}
            <UnsavedChangesProvider>
              <NavbarBreadcrumbProvider>
                <div className="flex min-h-screen w-full">
                  {/* Skip link: visually hidden until a keyboard user tabs to it, then it
                  jumps focus past the sidebar and navbar to the page content. */}
                  <a
                    href="#main-content"
                    className="bg-background text-foreground ring-ring sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:px-3 focus:py-2 focus:shadow-md focus:ring-2"
                  >
                    Skip to main content
                  </a>
                  <DashboardSidebarShell />
                  {/* min-w-0: without it this flex item refuses to shrink below its
                  content's intrinsic width, so a wide table stretches the whole
                  page sideways instead of scrolling inside its own container. */}
                  <div className="flex min-w-0 flex-1 flex-col">
                    {/* The gutter belongs to the content, not the column: on the column it
                      inset the navbar too, so the header read as a floating strip with a
                      divider that stopped short of both edges. */}
                    <Navbar />
                    {/* flex-1 so a page-level surface (see WorkspaceSurface) can fill the
                      viewport instead of stopping where its content does. */}
                    <main
                      id="main-content"
                      data-entry="main"
                      tabIndex={-1}
                      lang="en"
                      // py-6, not py-4: 24px is the air a page title wants above it, and
                      // every page's title sits directly against this padding. Paired with
                      // the 24px under the title, the heading reads as centred in its own
                      // band rather than pinned to the navbar. WorkspaceSurface bleeds back
                      // through these values, so it matches them.
                      className="flex min-w-0 flex-1 flex-col px-4 py-6 lg:px-6"
                    >
                      {children}
                    </main>
                  </div>
                </div>
              </NavbarBreadcrumbProvider>
            </UnsavedChangesProvider>
          </QueryProvider>
        </AuthGate>
      </SidebarProvider>
    </>
  );
}
