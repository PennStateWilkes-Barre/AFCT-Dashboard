'use client';

import React, { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { useNavbarBreadcrumbs } from '@/components/navbar/NavbarBreadcrumbContext';

/**
 * Breadcrumbs, the sidebar trigger and the theme picker. Nothing here reads the session:
 * the account menu lives in the sidebar footer, which is the one place on desktop that
 * carries the name, the avatar and Sign out.
 */

// UI Components
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';

import { cn } from '@/lib/utils';

// Local
import { EnhancedSidebarTrigger } from './ui/EnhancedSidebarTrigger';

/**
 * The two controls that sit on the header band rather than on a page.
 *
 * Button's own hover and focus colours are the page's, and the band is not the page: its
 * hover has to separate from #EEF1F4 rather than from a white card, and in dark mode the
 * band is lighter than the surface those defaults assume. Call-site classes on purpose.
 * Nothing about the shared Button or SidebarTrigger changes, because both are used on
 * ordinary surfaces elsewhere.
 */
const NAVBAR_CONTROL_CLASS =
  'text-navbar-foreground hover:bg-navbar-accent hover:text-navbar-accent-foreground ' +
  'dark:hover:bg-navbar-accent focus-visible:border-navbar-ring focus-visible:ring-navbar-ring/70';

const Navbar: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const pathname = usePathname();
  const { courseLabel, assignmentLabel } = useNavbarBreadcrumbs();

  const crumbs = useMemo(() => {
    const toTitleCase = (value: string) =>
      value
        .split('-')
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    const segments = pathname.split('/').filter(Boolean);
    const dashboardIndex = segments.indexOf('dashboard');
    const dashboardSegments = dashboardIndex >= 0 ? segments.slice(dashboardIndex + 1) : segments;

    // `flexible` marks a crumb whose label comes from data rather than the route: a course
    // name or an assignment title, which can be any length. Static crumbs ("Dashboard",
    // "Courses", "System Settings") are short and known, so they never give up space.
    // Recorded here rather than inferred from the index later, which would break the
    // moment the trail gains a level.
    const nextCrumbs: Array<{
      href: string;
      label: string;
      isPage?: boolean;
      flexible?: boolean;
    }> = [{ href: '/dashboard', label: 'Dashboard', isPage: dashboardSegments.length === 0 }];

    if (dashboardSegments[0] === 'courses') {
      nextCrumbs.push({
        href: '/dashboard/courses',
        label: 'Courses',
        isPage: dashboardSegments.length === 1,
      });

      const courseId = dashboardSegments[1];
      if (courseId) {
        nextCrumbs.push({
          href: `/dashboard/courses/${courseId}`,
          label: courseLabel?.id === courseId ? courseLabel.name : toTitleCase(courseId),
          isPage: dashboardSegments.length === 2,
          flexible: true,
        });
      }

      const assignmentId = dashboardSegments[2];
      if (assignmentId) {
        nextCrumbs.push({
          href: `/dashboard/courses/${courseId}/${assignmentId}`,
          label:
            assignmentLabel?.id === assignmentId
              ? assignmentLabel.title
              : toTitleCase(assignmentId),
          isPage: dashboardSegments.length === 3,
          flexible: true,
        });
      }
    } else if (dashboardSegments[0] !== undefined) {
      let hrefAcc = '/dashboard';
      dashboardSegments.forEach((segment, index) => {
        hrefAcc = `${hrefAcc}/${segment}`;
        nextCrumbs.push({
          href: hrefAcc,
          label: toTitleCase(segment),
          isPage: index === dashboardSegments.length - 1,
        });
      });
    }

    return nextCrumbs;
  }, [pathname, courseLabel, assignmentLabel]);

  return (
    // Chrome, not content: a band one step off the page canvas, spanning the whole content
    // column so its divider reaches both edges. The page gutter lives on <main> below, not
    // around this.
    //
    // Every colour comes from the --navbar family rather than the page tokens. The band and
    // the canvas are close together on purpose, which makes the border the thing that says
    // where the header ends; see the notes on --navbar in globals.css for the steps and the
    // contrast figures.
    //
    // shrink-0 is load-bearing. This is a flex child of the column that also holds <main>,
    // and flex items shrink by default, so a tall page squeezed the header below its own
    // h-14: the bar was 56px on the dashboard and shorter on Submissions.
    // Two stops rather than a flat fill, dark at the rail end and a shade lighter across to
    // the right. Both are tokens, so the high-contrast theme sets them equal and the band goes
    // flat there without this file knowing about it. See --navbar in globals.css.
    <header
      // Read by the sign-in entrance animation in globals.css; see DashboardEntryTransition.
      data-entry="navbar"
      className="from-navbar to-navbar-end text-navbar-foreground border-navbar-border flex h-14 shrink-0 items-center justify-between border-b bg-gradient-to-r px-4"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
        <EnhancedSidebarTrigger className={NAVBAR_CONTROL_CLASS} />
        {/* min-w-0 + flex-1: the trail gets whatever the header has left after the two
            fixed controls, so collapsing the sidebar hands it that width automatically.
            It used to be capped at 50/60vw, which is why a long title still truncated on a
            1920px screen with hundreds of spare pixels: the cap, not the space, was the
            limit. Nothing here measures anything; flexbox decides. */}
        <Breadcrumb aria-label="Breadcrumb" className="min-w-0 flex-1 overflow-hidden">
          <BreadcrumbList className="text-navbar-muted-foreground w-full min-w-0 flex-nowrap overflow-hidden text-sm">
            {crumbs.map((crumb, index) => {
              const isLast = !!crumb.isPage;

              // Progressive disclosure. Four long levels do not fit a phone, and four
              // truncated fragments tell you less than one whole title, so levels arrive
              // as the width does:
              //   below sm   the current page alone
              //   sm to lg   Dashboard > current page
              //   lg and up  the whole trail
              const visibility = isLast
                ? 'inline-flex'
                : index === 0
                  ? 'hidden sm:inline-flex'
                  : 'hidden lg:inline-flex';

              // A separator belongs BEFORE an item, and only when something visible
              // precedes it. Rendering one after every crumb (as this did) leaves a
              // dangling chevron the moment its neighbour is hidden. The earliest any
              // earlier crumb appears is `sm` (Dashboard), so a separator shows at
              // whichever is later: `sm`, or the breakpoint of the item it introduces.
              const separatorVisibility = isLast
                ? 'hidden sm:inline-flex'
                : 'hidden lg:inline-flex';

              return (
                <React.Fragment key={crumb.href}>
                  {index > 0 && (
                    <BreadcrumbSeparator
                      className={`${separatorVisibility} text-navbar-muted-foreground shrink-0`}
                    />
                  )}
                  <BreadcrumbItem
                    className={cn(
                      visibility,
                      // The current page gets first claim on the leftover width, because
                      // it is the label that says where you are. A long course name can
                      // shrink; a static one ("Dashboard", "Courses") is short and known,
                      // so it holds its size and never truncates.
                      isLast ? 'min-w-0 flex-1' : crumb.flexible ? 'min-w-0 shrink' : 'shrink-0',
                    )}
                  >
                    {isLast ? (
                      // title= so the whole label is readable on hover when CSS clips it.
                      // The text itself is never shortened, so the accessible name stays
                      // complete either way.
                      <BreadcrumbPage
                        title={crumb.label}
                        className="text-navbar-foreground block truncate font-medium"
                      >
                        {crumb.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        href={crumb.href}
                        title={crumb.flexible ? crumb.label : undefined}
                        // Not TEXT_LINK_CLASS. That is for a link inside a document, and
                        // its cobalt is unreadable here; this is navigation drawn on dark
                        // chrome, where the trail's own shape is the affordance and the
                        // underline on hover is the non-colour cue.
                        className="text-navbar-muted-foreground hover:text-navbar-foreground block truncate hover:underline"
                      >
                        {crumb.label}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </React.Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* shrink-0: the theme control is a fixed cost, and the trail is what yields. */}
      <div className="ml-2 flex shrink-0 items-center gap-2 text-right sm:gap-4">
        <DropdownMenu>
          {/* `relative` so the Moon anchors to the button. It was absolutely positioned at
              its static spot, which the old wide button happened to have room for; in a
              square icon button it would hang off the right edge. */}
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className={cn('relative', NAVBAR_CONTROL_CLASS)}>
              <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
              <Moon className="absolute top-1/2 left-1/2 h-[1.2rem] w-[1.2rem] -translate-x-1/2 -translate-y-1/2 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
              <span className="sr-only">Toggle theme</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Radio group so the current theme is exposed as the checked option. */}
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
              {/* Derived from light, not a third surface ladder: AAA text contrast and
                  full-strength boundaries. See the .high-contrast block in globals.css. */}
              <DropdownMenuRadioItem value="high-contrast">High contrast</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
};

export default Navbar;
