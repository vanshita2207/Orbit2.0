"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const { MongoClient } = require("mongodb");

const projectDirectory = path.resolve(__dirname, "..");

function listenOnAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function request(baseUrl, method, route, token, body) {
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;
  return { status: response.status, body: payload };
}

function signup(baseUrl, name, email, workspace, inviteCode) {
  return request(baseUrl, "POST", "/api/auth/signup", null, {
    name,
    email,
    password: "TestPassword123!",
    ...(workspace ? { workspaceName: workspace } : {}),
    ...(inviteCode ? { inviteCode } : {}),
  });
}

test("workspace onboarding, isolation, analytics, events, and announcements", async (t) => {
  const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
  const databaseName = `OrbitIntegration_${process.pid}_${Date.now()}`;
  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
  try {
    await mongo.connect();
  } catch (error) {
    t.skip(`MongoDB is unavailable (${error.message}). Set MONGODB_URI to run API integration tests.`);
    return;
  }

  await mongo.db(databaseName).collection("teams").createIndex({ name: 1 }, { unique: true });
  const port = await listenOnAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secret = `test-${process.pid}-${Date.now()}-${Math.random()}`;
  const serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MONGODB_URI: mongoUri,
      MONGODB_DB: databaseName,
      JWT_SECRET: secret,
      PORT: String(port),
      NODE_ENV: "test",
    },
    stdio: "ignore",
  });

  async function waitForServer() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (serverProcess.exitCode !== null) throw new Error("The API server exited during startup.");
      try {
        const response = await fetch(`${baseUrl}/api/auth/session`);
        if (response.ok) return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("The API server did not start in time.");
  }

  try {
    await waitForServer();
    const teamIndexNames = (await mongo.db(databaseName).collection("teams").listIndexes().toArray())
      .map((index) => index.name);
    assert.ok(teamIndexNames.includes("organizationId_1_name_1"));
    assert.ok(!teamIndexNames.includes("name_1"));
    const bootstrap = await request(baseUrl, "GET", "/api/organizations/bootstrap-status");
    assert.deepEqual(bootstrap.body, { workspaceExists: false });

    const adminResponse = await signup(baseUrl, "Alpha Admin", "alpha-admin@example.test", "Alpha Workspace");
    assert.equal(adminResponse.status, 201);
    const admin = adminResponse.body.user;
    const adminToken = adminResponse.body.token;
    assert.equal(admin.role, "admin");
    assert.ok(admin.organizationId);

    const workspaceResponse = await request(baseUrl, "GET", "/api/organizations/me", adminToken);
    assert.equal(workspaceResponse.status, 200, JSON.stringify(workspaceResponse.body));
    const alphaWorkspace = workspaceResponse.body.organization;
    assert.equal(alphaWorkspace.name, "Alpha Workspace");
    assert.ok(alphaWorkspace.inviteCode);

    const missingInvite = await signup(baseUrl, "No Invite", "no-invite@example.test");
    assert.equal(missingInvite.status, 400);
    const invalidInvite = await signup(baseUrl, "Invalid Invite", "invalid-invite@example.test", null, "wrong-code");
    assert.equal(invalidInvite.status, 403);

    const memberResponse = await signup(
      baseUrl,
      "Alpha Member",
      "alpha-member@example.test",
      null,
      alphaWorkspace.inviteCode
    );
    assert.equal(memberResponse.status, 201);
    const member = memberResponse.body.user;
    const memberToken = memberResponse.body.token;
    assert.equal(member.organizationId, admin.organizationId);
    assert.equal(member.role, "member");

    const workspaceTeams = await request(baseUrl, "GET", "/api/teams", adminToken);
    assert.equal(workspaceTeams.status, 200);
    assert.equal(workspaceTeams.body.teams.length, 5);
    const technicalTeam = workspaceTeams.body.teams.find((team) => team.name === "Technical");
    assert.ok(technicalTeam.id);
    const updatedTeam = await request(
      baseUrl,
      "PUT",
      `/api/teams/${technicalTeam.id}`,
      adminToken,
      { memberIds: [member.id] }
    );
    assert.equal(updatedTeam.status, 200);
    assert.equal(updatedTeam.body.team.memberIds[0], member.id);
    assert.equal(
      (await request(baseUrl, "POST", "/api/teams", memberToken, { name: "Restricted team" })).status,
      403
    );
    const customTeam = await request(baseUrl, "POST", "/api/teams", adminToken, {
      name: "Quality",
      memberIds: [member.id],
    });
    assert.equal(customTeam.status, 201);
    assert.equal(
      (await request(baseUrl, "POST", "/api/teams", adminToken, { name: "Quality" })).status,
      409
    );
    assert.equal(
      (await request(baseUrl, "PUT", `/api/teams/${technicalTeam.id}`, adminToken, { memberIds: ["outside-user"] })).status,
      400
    );

    const betaResponse = await signup(baseUrl, "Beta Admin", "beta-admin@example.test", "Beta Workspace");
    assert.equal(betaResponse.status, 201);
    const betaAdmin = betaResponse.body.user;
    const betaToken = betaResponse.body.token;
    assert.notEqual(betaAdmin.organizationId, admin.organizationId);
    assert.equal((await request(baseUrl, "GET", "/api/dashboard/overview", betaToken)).body.totalTasks, 0);
    const betaTeams = await request(baseUrl, "GET", "/api/teams", betaToken);
    assert.equal(betaTeams.status, 200);
    assert.equal(betaTeams.body.teams.length, 5);
    assert.ok(betaTeams.body.teams.every((team) => team.organizationId === betaAdmin.organizationId));
    assert.equal(
      (await request(baseUrl, "GET", `/api/dashboard/team-performance?team=${technicalTeam.id}`, betaToken)).status,
      404
    );

    const noAuth = await request(baseUrl, "GET", "/api/dashboard/overview");
    assert.equal(noAuth.status, 401);
    for (const page of ["events.html", "announcements.html", "workspace.html", "team.html"]) {
      const pageResponse = await fetch(`${baseUrl}/${page}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(pageResponse.status, 200);
      assert.match(await pageResponse.text(), /<main/);
    }
    const emptyStats = await request(baseUrl, "GET", "/api/dashboard/overview", adminToken);
    assert.equal(emptyStats.body.completionPercentage, 0);
    assert.equal(emptyStats.body.totalTasks, 0);

    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 3);
    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 3);
    const createTask = (title, dueDate) => request(baseUrl, "POST", "/api/tasks", adminToken, {
      title,
      team: technicalTeam.id,
      assignee: member.id,
      contributionPoints: 5,
      project: "",
      priority: "Medium",
      dueDate: dueDate.toISOString().slice(0, 10),
      description: `${title} description`,
    });
    const pendingTask = await createTask("Upcoming task", future);
    const overdueTask = await createTask("Overdue task", past);
    assert.equal(pendingTask.status, 201);
    assert.equal(overdueTask.status, 201);
    assert.equal(pendingTask.body.task.organizationId, admin.organizationId);
    const statusUpdate = await request(
      baseUrl,
      "PATCH",
      `/api/tasks/${pendingTask.body.task.id}/status`,
      memberToken,
      { status: "Completed" }
    );
    assert.equal(statusUpdate.status, 200);
    assert.ok(statusUpdate.body.task.completedAt);
    assert.equal(
      (await request(baseUrl, "PATCH", `/api/tasks/${pendingTask.body.task.id}/status`, adminToken, { status: "Unknown" })).status,
      400
    );
    const deniedTaskUpdate = await request(
      baseUrl,
      "PATCH",
      `/api/tasks/${overdueTask.body.task.id}/status`,
      betaToken,
      { status: "Completed" }
    );
    assert.equal(deniedTaskUpdate.status, 404);
    const overview = await request(baseUrl, "GET", "/api/dashboard/overview", adminToken);
    assert.equal(overview.body.totalTasks, 2);
    assert.equal(overview.body.completedTasks, 1);
    assert.equal(overview.body.overdueTasks, 1);
    assert.equal(overview.body.completionPercentage, 50);
    const memberStats = await request(baseUrl, "GET", "/api/dashboard/member-performance", adminToken);
    assert.equal(memberStats.body.pagination.total, 2);
    assert.equal(memberStats.body.members.find((item) => item.memberId === admin.id).totalTasks, 0);
    const topPerformers = await request(baseUrl, "GET", "/api/dashboard/top-performers", adminToken);
    assert.equal(topPerformers.body.members[0].memberId, member.id);
    assert.equal(topPerformers.body.members[0].contributionPoints, 5);
    const teamStats = await request(baseUrl, "GET", "/api/dashboard/team-performance", adminToken);
    assert.ok(teamStats.body.teams.some((item) => item.teamName === "Design" && item.totalTasks === 0));
    const technicalStats = teamStats.body.teams.find((item) => item.teamId === technicalTeam.id);
    assert.equal(technicalStats.totalTasks, 2);
    assert.equal(technicalStats.memberCount, 1);
    assert.ok(teamStats.body.teams.some((item) => item.teamId === customTeam.body.team.id && item.totalTasks === 0));
    assert.equal(
      (await request(baseUrl, "GET", `/api/dashboard/team-performance?team=${technicalTeam.id}`, adminToken))
        .body.teams.length,
      1
    );
    assert.equal(
      (await request(baseUrl, "GET", `/api/tasks?team=${technicalTeam.id}`, adminToken))
        .body.pagination.total,
      2
    );
    assert.equal(
      (await request(baseUrl, "GET", `/api/dashboard/member-performance?team=${technicalTeam.id}`, adminToken))
        .body.members.length,
      1
    );
    assert.equal(
      (await request(baseUrl, "DELETE", `/api/teams/${technicalTeam.id}`, adminToken)).status,
      409
    );
    assert.equal(
      (await request(baseUrl, "DELETE", `/api/teams/${customTeam.body.team.id}`, adminToken)).status,
      200
    );

    const eventDate = future.toISOString().slice(0, 10);
    const eventResponse = await request(baseUrl, "POST", "/api/events", adminToken, {
      title: "Workspace demo",
      description: "Tenant-scoped event",
      eventDate,
      startTime: "10:00",
      endTime: "11:00",
      location: "Main room",
    });
    assert.equal(eventResponse.status, 201);
    const eventId = eventResponse.body.event.id;
    const updatedEvent = await request(
      baseUrl,
      "PUT",
      `/api/events/${eventId}`,
      adminToken,
      { description: "Updated workspace event." }
    );
    assert.equal(updatedEvent.status, 200);
    assert.equal(updatedEvent.body.event.description, "Updated workspace event.");
    assert.equal(
      (await request(baseUrl, "GET", `/api/events/${eventId}`, betaToken)).status,
      404
    );
    assert.equal(
      (await request(baseUrl, "POST", "/api/events", memberToken, { title: "Not allowed" })).status,
      403
    );
    const checklistResponse = await request(
      baseUrl,
      "POST",
      `/api/events/${eventId}/checklist`,
      adminToken,
      { title: "Prepare demo", assignedMember: member.id }
    );
    assert.equal(checklistResponse.status, 201);
    const checklistId = checklistResponse.body.item.id;
    const completedChecklist = await request(
      baseUrl,
      "PATCH",
      `/api/events/${eventId}/checklist/${checklistId}`,
      memberToken,
      { completed: true }
    );
    assert.equal(completedChecklist.status, 200);
    assert.ok(completedChecklist.body.item.completedAt);
    assert.equal(
      (await request(baseUrl, "GET", `/api/events/${eventId}/checklist`, adminToken))
        .body.completedChecklistItems,
      1
    );
    assert.equal((await request(baseUrl, "GET", "/api/events?status=upcoming", adminToken)).body.events.length, 1);

    const announcementResponse = await request(baseUrl, "POST", "/api/announcements", adminToken, {
      title: "Workspace update",
      message: "Only Alpha should see this.",
      priority: "Urgent",
    });
    assert.equal(announcementResponse.status, 201);
    const announcementId = announcementResponse.body.announcement.id;
    assert.equal((await request(baseUrl, "GET", "/api/announcements", betaToken)).body.pagination.total, 0);
    assert.equal((await request(baseUrl, "GET", `/api/announcements/${announcementId}`, betaToken)).status, 404);
    const filteredAnnouncements = await request(
      baseUrl,
      "GET",
      "/api/announcements?priority=Urgent",
      adminToken
    );
    assert.equal(filteredAnnouncements.body.announcements.length, 1);
    const updatedAnnouncement = await request(
      baseUrl,
      "PUT",
      `/api/announcements/${announcementId}`,
      adminToken,
      { priority: "Important" }
    );
    assert.equal(updatedAnnouncement.body.announcement.priority, "Important");
    assert.equal(
      (await request(baseUrl, "PUT", `/api/announcements/${announcementId}`, memberToken, { priority: "Important" })).status,
      403
    );
    assert.equal((await request(baseUrl, "DELETE", `/api/announcements/${announcementId}`, adminToken)).status, 200);
    assert.equal((await request(baseUrl, "DELETE", `/api/events/${eventId}`, adminToken)).status, 200);

    const rotateResponse = await request(
      baseUrl,
      "POST",
      "/api/organizations/me/invite-code",
      adminToken,
      {}
    );
    assert.equal(rotateResponse.status, 200);
    assert.equal(
      (await request(baseUrl, "POST", "/api/organizations/me/invite-code", memberToken, {})).status,
      403
    );
    assert.notEqual(rotateResponse.body.organization.inviteCode, alphaWorkspace.inviteCode);
    const oldInvite = await signup(baseUrl, "Old Invite", "old-invite@example.test", null, alphaWorkspace.inviteCode);
    assert.equal(oldInvite.status, 403);
    const newInvite = await signup(
      baseUrl,
      "New Invite",
      "new-invite@example.test",
      null,
      rotateResponse.body.organization.inviteCode
    );
    assert.equal(newInvite.status, 201);
  } finally {
    serverProcess.kill();
    await once(serverProcess, "exit").catch(() => {});
    await mongo.db(databaseName).dropDatabase();
    await mongo.close();
  }
});
