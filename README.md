# Orbit - Team Collaboration & Work Management System

Orbit is a team collaboration and work management system designed to help teams organise projects, assign work, review submissions and communicate in one place.

The CE-1 frontend is retained as static HTML, CSS and JavaScript. The Node.js backend uses MongoDB for persistent users, workspaces, teams, tasks, events, and announcements, bcrypt for password hashing, JWT for authentication, protected routes, and role-based authorization.

## Team members

- Aarav Sharma
- Ishita Verma
- Rohan Kapoor
- Ananya Singh

## Project phases

- **CE-1:** HTML, CSS and JavaScript implementation
- **CE-2:** Conversion to React

## Requirements

- Node.js 18 or newer

## Run locally

1. Open a terminal in the project folder.
2. Install the project metadata and lockfile dependencies:

   ```powershell
   npm install
   ```

3. Start MongoDB locally, or set `MONGODB_URI` to an Atlas connection string.

4. Optionally create a `.env` file:

   ```env
   MONGODB_URI=mongodb://127.0.0.1:27017
   MONGODB_DB=Orbit
   JWT_SECRET=replace-with-a-long-random-secret
   PORT=3000
   ```

5. Start the local server:

   ```powershell
   npm start
   ```

6. Open [http://localhost:3000](http://localhost:3000) in a browser.

The review workspace is available at [http://localhost:3000/approvals.html](http://localhost:3000/approvals.html). Approval decisions and comments are demo interactions and reset when the page is refreshed.

## Dashboard, teams, events, and announcements API

All dashboard, task-list, event, announcement, and checklist endpoints require the existing JWT session (cookie or bearer token). Event and announcement writes, plus event checklist creation/deletion and detail edits, require the `manager` or `admin` role. An assigned checklist member may change only that item's completion state.

### Workspaces and invitations

- The first account can create a workspace by providing `workspaceName` during `POST /api/auth/signup`; its creator becomes an admin.
- Further accounts join by providing the current `inviteCode`, or create a separate workspace by providing a new `workspaceName`.
- `GET /api/organizations/bootstrap-status` tells the sign-up form whether any workspaces already exist.
- `GET /api/organizations/me` returns the signed-in user's workspace. Admins and managers can view its invite code.
- `POST /api/organizations/me/invite-code` rotates the invitation code (admin only); the old code immediately stops working.
- `GET /api/organizations/members` returns the current workspace's member directory without exposing email addresses.
- The workspace settings page lets admins and managers create teams and assign workspace members. Admins can delete teams that have no tasks.
- `GET /api/teams` lists workspace teams and members. `POST /api/teams` creates a team; `PUT /api/teams/:id` updates its name or member list; `DELETE /api/teams/:id` removes an unused team.

Existing records without `organizationId` are assigned once at startup to a `Legacy Workspace`. This keeps existing accounts and data together while ensuring that new workspaces cannot read them. New user, task, event, announcement, and checklist-assignee queries are scoped to the authenticated workspace; client-provided organization IDs are not accepted.

Teams are stored as workspace-scoped records with stable IDs and member IDs. Startup removes the obsolete globally unique team-name index, replaces it with workspace-scoped uniqueness, and migrates legacy team memberships into the `Legacy Workspace`. New workspaces are initialized with the existing five team names. Existing tasks are backfilled with their team's ID during startup, while new task assignments store both the team ID/name and assignee ID/name. The Teams dashboard and detail page use live workspace data rather than demo/local-storage data.

The dashboard APIs aggregate workspace data:

- `GET /api/dashboard/overview` returns all-time totals and rolling 7-day/30-day chart data.
- `GET /api/dashboard/task-stats` returns totals and counts grouped by status.
- `GET /api/dashboard/completion` returns completion totals and percentage.
- `GET /api/dashboard/team-performance` returns all teams, including teams with no tasks, with stable IDs, member counts, task totals, and contribution percentages. `team` can filter by ID or name.
- `GET /api/dashboard/member-performance` returns paginated member summaries; supports `team` and `member` filters.
- `GET /api/dashboard/top-performers` ranks by contribution points, then completion percentage; supports `team`, `member`, `page`, and `limit`.
- `GET /api/tasks?team=<team-id>` returns tasks scoped to a workspace team as well as the signed-in workspace.
- `GET /api/tasks?due=upcoming&limit=4` returns upcoming incomplete task deadlines for the dashboard.
- `PATCH /api/tasks/:id/status` lets a manager/admin update task status, or an assigned member update their own task. Supported statuses are Assigned, In Progress, Pending review, Completed, Changes requested, and Rejected.

Events support `GET`/`POST /api/events`, `GET`/`PUT`/`DELETE /api/events/:id`, `GET`/`POST /api/events/:id/checklist`, and `PATCH`/`DELETE /api/events/:id/checklist/:itemId`. Event listing supports `status=upcoming|past`, `from`, `to`, `page`, and `limit`.

Announcements support `GET`/`POST /api/announcements` and `GET`/`PUT`/`DELETE /api/announcements/:id`. List filters include `priority=Normal|Important|Urgent`, `page`, and `limit`.

The dashboard links to dedicated Teams, Events, Announcements, and Workspace pages. Managers/admins can create and manage events, checklist items, announcements, and teams; assigned members can update their checklist completion. Members with no tasks still appear in team/member performance when they belong to the relevant team/workspace.

Run the API integration tests with `npm test`. MongoDB must be running locally or `MONGODB_URI` must point to a test database server; the test suite creates and drops its own uniquely named database.

## Project structure

- `index.html` - login/landing page
- `dashboard.html` - dashboard page
- `team.html` - workspace team details, task statuses, members, and event checklist
- `workspace.html` - workspace invitations, members, and team management
- `create-task.html` - task creation page
- `approvals.html` - task review workspace
- `css/` - page stylesheets
- `js/` - page scripts
- `assets/images/` - image assets
- `server.js` - dependency-free static Node.js server
