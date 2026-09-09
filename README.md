# AFCT Dashboard

A modern Next.js 16 dashboard for the Automated Feedback for CS Theory (AFCT) system.
Built with:

![Node.js](https://img.shields.io/badge/Node.js-22%2B-brightgreen?logo=node.js)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-336791?logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-38B2AC?logo=tailwindcss&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker)

[![CI](https://github.com/PennStateCS/AFCT/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/PennStateCS/AFCT/actions/workflows/ci.yml)
[![Publish](https://github.com/PennStateCS/AFCT/actions/workflows/publish-ghcr.yml/badge.svg?branch=main)](https://github.com/PennStateCS/AFCT/actions/workflows/publish-ghcr.yml)

## Tech Stack

- **Runtime:** Node.js 22+
- **Web:** Next.js 16, React 19, TypeScript 5.9
- **Database:** PostgreSQL 15, Prisma 7
- **Authentication:** Auth.js / NextAuth v5
- **UI:** Tailwind CSS 4, Radix UI
- **Data:** TanStack Query, TanStack Table
- **Automata Viewer:** Cytoscape.js
- **Rich Text:** TipTap
- **Testing:** Vitest, Playwright, axe-core
- **Deployment:** Docker, GitHub Container Registry (GHCR)

## Funding

This project is supported in part by the National Science Foundation under Grant No. 2439326. Any opinions, findings, conclusions, or recommendations expressed are those of the authors and do not necessarily reflect the views of the NSF.

## AFCT Components

AFCT is composed of three related repositories:

| Component | Repository | Purpose | Relationship |
| --- | --- | --- | --- |
| Dashboard | [AFCT](https://github.com/PennStateCS/AFCT) | Web application for courses, assignments, submissions, grading, and administration. | **Depends on AFCT-Evaluator** for automated evaluation. |
| Evaluator | [AFCT-Evaluator](https://github.com/PennStateCS/AFCT-Evaluator) | Evaluates submitted automata and formal-language assignments. | Used by the AFCT Dashboard for automated grading. |
| Client | [AFCT-Client](https://github.com/PennStateCS/AFCT-Client) | Customized JFLAP desktop client used to create, test, and submit automata. | Used by students and also provides functionality required by the current evaluator. |

## Participating Institutions

AFCT is part of a multi-institutional collaboration involving:

- College of the Holy Cross
- Rochester Institute of Technology
- The Pennsylvania State University
- The University of New Mexico
- University of Rochester

This collaboration supports the continued development, deployment, and study of AFCT across undergraduate computing theory courses.

## Documentation

Developer and user documentation is available at: **<https://pennstatecs.github.io/AFCT/>**

## Certifications

AFCT is certified by 1EdTech for **LTI Advantage Complete**, covering LTI 1.3, Deep Linking 2.0,
Names and Role Provisioning Services 2.0, and Assignment and Grade Services 2.0. It connects to
Canvas, D2L Brightspace, Blackboard, and any other LMS that supports LTI 1.3.

<a href="https://site.imsglobal.org/certifications/pennsylvania-state-university/afct"><img src="https://site.imsglobal.org/sites/default/files/media/images/logo_ims/1edtech_trusted-apps-certified.svg" alt="1EdTech Certified" width="140" border="0"></a>

## Acknowledgments

AFCT works with a Java evaluator that uses [JFLAP](https://www.jflap.org/) to process and evaluate formal-language assignments. JFLAP was developed by Susan H. Rodger and contributors at Duke University, and their work provides an important foundation for AFCT’s evaluation capabilities. JFLAP remains subject to its own [JFLAP 7.1 license](https://www.jflap.org/jflaptmp/july27-18/license.html) and is not covered by AFCT’s AGPL license.

## Contributors

| Name                | Affiliation | GitHub                                        |
| ------------------- | ----------- | --------------------------------------------- |
| Josmar Amado        | PSU         | [Josmar-A](https://github.com/Josmar-A)       |
| Jesse Burdick-Pless | RIT         | [jb4411](https://github.com/jb4411)           |
| Jace Chernesky       | PSU         | [chernjac321](https://github.com/chernjac321) |
| Jeffrey Chiampi     | PSU         | [jdc308](https://github.com/jdc308)           |
| Edwin Kimsal        | PSU         | [EdwinKimsal](https://github.com/EdwinKimsal) |
| Adam Manowski       | PSU         | [Adam-Manowski](https://github.com/Adam-Manowski)   |
| Bruno Rodriguez     | PSU         | [MrBrunoRod](https://github.com/MrBrunoRod)   |
| Andrew Sutton       | PSU         | [asutton24](https://github.com/asutton24)     |



