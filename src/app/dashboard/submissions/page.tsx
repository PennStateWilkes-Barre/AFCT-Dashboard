import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubmissionsClient from './SubmissionsClient';
import { WorkspaceSurface } from '@/components/WorkspaceSurface';
import { auth } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Submissions',
};

export default async function SubmissionsPage() {
  const session = await auth();
  // Admin-only, like every other page in the admin menu, and the only one that was not
  // saying so. It rendered for anyone signed in, then its POST to /api/admin/submissions
  // came back 403: a student who reached the URL got a broken page, and the refusal was
  // written to ActivityLog at SECURITY severity against their name for following a link.
  // The backing route is still the authoritative gate; this stops the page pretending.
  if (!session?.user?.isAdmin) {
    notFound();
  }

  // A work page, so it sits on the white surface rather than the slate canvas.
  return (
    <WorkspaceSurface>
      <SubmissionsClient />
    </WorkspaceSurface>
  );
}
