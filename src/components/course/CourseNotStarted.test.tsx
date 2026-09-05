/** @vitest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CourseNotStarted } from './CourseNotStarted';

/**
 * What a student sees for a course they are on the roster of that has not opened yet.
 *
 * Not a 404: they can see it listed under Upcoming Courses, so pretending it is not there
 * would read as a bug. The date is the whole point of the screen.
 */
describe('CourseNotStarted', () => {
  it('names the course and says when it opens, in the course timezone', () => {
    render(
      <CourseNotStarted
        name="Introduction to Digital Systems"
        code="CMPEN 271"
        startDate={new Date('2027-01-16T14:30:00.000Z')}
        timezone="UTC"
      />,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'CMPEN 271: Introduction to Digital Systems',
    );
    expect(screen.getByText(/01\/16\/27 at 02:30 PM/)).toBeInTheDocument();
  });

  it('falls back to the name alone when the course has no code', () => {
    render(<CourseNotStarted name="Special Topics" code={null} startDate={null} timezone={null} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Special Topics has not started yet',
    );
  });

  it('says the materials are not available rather than inventing a date', () => {
    render(<CourseNotStarted name="Special Topics" code={null} startDate={null} timezone={null} />);

    expect(screen.getByText(/not available yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/opens on/i)).not.toBeInTheDocument();
  });
});
