require("dotenv").config();

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const jwt = require("jsonwebtoken");
const path = require("path");
const { MongoClient } = require("mongodb");
const { promisify } = require("util");

const port = Number(process.env.PORT) || 3000;
const rootDirectory = __dirname;
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const mongoDbName = process.env.MONGODB_DB || "Orbit";
const jwtSecret =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === "production" ? null : "orbit-development-secret-change-in-production");
const maxRequestBytes = 16 * 1024;
const scrypt = promisify(crypto.scrypt);
const defaultTeamNames = ["Design", "Marketing", "Organising", "Technical", "Management"];

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let db;
let organizationsCollection;
let teamsCollection;
let usersCollection;
let tasksCollection;
let eventsCollection;
let announcementsCollection;

const completedTaskStatuses = ["completed", "complete", "approved", "done"];
const inProgressTaskStatuses = ["in progress", "inprogress", "working"];
const reviewTaskStatuses = ["pending review", "review", "submitted", "under review"];
const announcementPriorities = ["Normal", "Important", "Urgent"];
const taskStatuses = ["Assigned", "In Progress", "Pending review", "Completed", "Changes requested", "Rejected"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function ensureWorkspaceTeams(organizationId) {
  const organization = await organizationsCollection.findOne(
    { id: organizationId },
    { projection: { teamsInitialized: 1 } }
  );
  if (!organization || organization.teamsInitialized) return;
  const existingTeams = await teamsCollection.find(
    { organizationId },
    { projection: { name: 1 } }
  ).toArray();
  const existingNames = new Set(existingTeams.map((team) => team.name));
  for (const name of defaultTeamNames) {
    if (existingNames.has(name)) continue;
    const now = new Date().toISOString();
    try {
      await teamsCollection.insertOne({
        id: crypto.randomUUID(),
        organizationId,
        name,
        memberIds: [],
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (error.code !== 11000 || !(await teamsCollection.findOne({ organizationId, name }))) {
        throw error;
      }
    }
  }
  await organizationsCollection.updateOne({ id: organizationId }, { $set: { teamsInitialized: true } });
}

async function ensureAllWorkspaceTeams() {
  const organizations = await organizationsCollection.find({}, { projection: { id: 1 } }).toArray();
  for (const organization of organizations) {
    await ensureWorkspaceTeams(organization.id);
    const teams = await teamsCollection.find(
      { organizationId: organization.id },
      { projection: { id: 1, name: 1 } }
    ).toArray();
    for (const team of teams) {
      await tasksCollection.updateMany(
        {
          organizationId: organization.id,
          team: team.name,
          teamId: { $exists: false },
        },
        { $set: { teamId: team.id } }
      );
    }
  }
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function getFilePath(requestUrl) {
  const requestedPath = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  const relativePath = requestedPath === "/" ? "landing.html" : requestedPath.slice(1);
  const filePath = path.resolve(rootDirectory, relativePath);
  const rootRelativePath = path.relative(rootDirectory, filePath);
  const outsideRoot =
    rootRelativePath === ".." ||
    rootRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rootRelativePath);
  return outsideRoot ? null : filePath;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxRequestBytes) {
        settled = true;
        reject(new HttpError(413, "Request body is too large."));
        request.resume();
      }
    });

    request.on("end", () => {
      if (settled) return;
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        settled = true;
        reject(new HttpError(415, "Content-Type must be application/json."));
        return;
      }
      try {
        const value = JSON.parse(body);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new SyntaxError("Expected a JSON object.");
        }
        settled = true;
        resolve(value);
      } catch {
        settled = true;
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });

    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator > 0) {
      cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
    return cookies;
  }, new Map());
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "member",
    organizationId: user.organizationId || null,
  };
}

function createInviteCode() {
  return crypto.randomBytes(18).toString("base64url");
}

function organizationFilter(user) {
  if (!user || !user.organizationId) {
    throw new HttpError(403, "Your account is not associated with a workspace.");
  }
  return { organizationId: user.organizationId };
}

async function migrateUnassignedRecords() {
  const collections = [
    usersCollection,
    tasksCollection,
    teamsCollection,
    eventsCollection,
    announcementsCollection,
  ];
  const hasUnassignedRecords = await Promise.all(
    collections.map((collection) => collection.countDocuments({ organizationId: { $exists: false } }))
  );
  if (!hasUnassignedRecords.some(Boolean)) {
    await migrateLegacyTeamMembers();
    return;
  }

  let legacyOrganization = await organizationsCollection.findOne({ isLegacyWorkspace: true });
  if (!legacyOrganization) {
    legacyOrganization = {
      id: crypto.randomUUID(),
      name: "Legacy Workspace",
      inviteCode: createInviteCode(),
      isLegacyWorkspace: true,
      isBootstrap: (await organizationsCollection.countDocuments()) === 0,
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await organizationsCollection.insertOne(legacyOrganization);
    } catch (error) {
      if (error.code !== 11000) throw error;
      legacyOrganization = await organizationsCollection.findOne({ isLegacyWorkspace: true });
      if (!legacyOrganization) throw error;
    }
  }

  await Promise.all(collections.map((collection) =>
    collection.updateMany(
      { organizationId: { $exists: false } },
      { $set: { organizationId: legacyOrganization.id } }
    )
  ));
  await migrateLegacyTeamMembers();
  if (await usersCollection.countDocuments({
    organizationId: legacyOrganization.id,
    role: "admin",
  }) === 0) {
    await usersCollection.findOneAndUpdate(
      { organizationId: legacyOrganization.id },
      { $set: { role: "admin" } },
      { sort: { createdAt: 1 } }
    );
  }
}

async function migrateLegacyTeamMembers() {
  const teams = await teamsCollection.find(
    { memberIds: { $exists: false }, members: { $type: "array" } },
    { projection: { id: 1, organizationId: 1, members: 1 } }
  ).toArray();
  for (const team of teams) {
    const memberIds = team.members
      .map((member) => member && member.userId)
      .filter((id) => typeof id === "string");
    await teamsCollection.updateOne(
      { id: team.id, organizationId: team.organizationId },
      { $set: { memberIds } }
    );
  }
}

async function removeLegacyGlobalTeamNameIndex() {
  const indexes = await teamsCollection.listIndexes().toArray();
  const legacyIndex = indexes.find((index) =>
    index.unique &&
    Object.keys(index.key).length === 1 &&
    index.key.name === 1
  );
  if (!legacyIndex) return;
  try {
    await teamsCollection.dropIndex(legacyIndex.name);
  } catch (error) {
    if (error.code !== 27) throw error;
  }
}

function setAuthCookie(request, response, token, remember) {
  const maxAge = remember ? 30 * 24 * 60 * 60 : 12 * 60 * 60;
  const secure = request.socket.encrypted ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `orbit_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

function createToken(user, remember) {
  return jwt.sign(
    { sub: user.id, role: user.role || "member", email: user.email },
    jwtSecret,
    { expiresIn: remember ? "30d" : "12h" }
  );
}

async function authenticate(request) {
  const authorization = request.headers.authorization || "";
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
  const cookieToken = parseCookies(request.headers.cookie).get("orbit_token");
  const token = bearerToken || cookieToken;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, jwtSecret);
    const user = await usersCollection.findOne({ id: payload.sub });
    return user || null;
  } catch {
    return null;
  }
}

function requireAuth(handler) {
  return async (request, response, ...args) => {
    const user = await authenticate(request);
    if (!user) throw new HttpError(401, "Authentication required.");
    return handler(request, response, user, ...args);
  };
}

function requireRole(...roles) {
  return (handler) => requireAuth(async (request, response, user) => {
    if (!roles.includes(user.role || "member")) {
      throw new HttpError(403, "You do not have permission to perform this action.");
    }
    return handler(request, response, user);
  });
}

async function migrateLegacyStore() {
  const legacyPath = path.join(__dirname, ".orbit-data", "store.json");
  if (!fs.existsSync(legacyPath)) return;

  try {
    const legacy = JSON.parse(await fs.promises.readFile(legacyPath, "utf8"));
    if (!legacy || !Array.isArray(legacy.users)) return;

    if (await usersCollection.countDocuments() === 0 && legacy.users.length > 0) {
      await usersCollection.insertMany(
        legacy.users.map((user, index) => ({
          ...user,
          role: index === 0 ? "admin" : "member",
          passwordFormat: "scrypt",
          updatedAt: new Date().toISOString(),
        }))
      );
    }
    if (await tasksCollection.countDocuments() === 0 && Array.isArray(legacy.tasks) && legacy.tasks.length > 0) {
      await tasksCollection.insertMany(legacy.tasks);
    }
  } catch (error) {
    console.warn("Legacy store migration skipped:", error.message);
  }
}

async function createAccount(request, response) {
  const body = await readJsonBody(request);
  assertAllowedFields(body, ["name", "email", "password", "remember", "workspaceName", "inviteCode"]);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const workspaceName = typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";

  if (name.length < 2 || name.length > 80) {
    throw new HttpError(400, "Enter a name between 2 and 80 characters.");
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  if (password.length < 10 || password.length > 128) {
    throw new HttpError(400, "Password must be between 10 and 128 characters.");
  }
  if (await usersCollection.findOne({ email })) {
    throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  }

  let organization;
  let role = "member";
  const hasOrganizations = (await organizationsCollection.countDocuments()) > 0;
  if (inviteCode && workspaceName) {
    throw new HttpError(400, "Provide an invitation code or a new workspace name, not both.");
  }
  if (inviteCode) {
    organization = await organizationsCollection.findOne({ inviteCode });
    if (!organization) throw new HttpError(403, "The workspace invitation code is invalid.");
  } else {
    if (workspaceName.length < 2 || workspaceName.length > 100) {
      throw new HttpError(400, "Enter a workspace invitation code or a workspace name between 2 and 100 characters.");
    }
    organization = {
      id: crypto.randomUUID(),
      name: workspaceName,
      inviteCode: createInviteCode(),
      isBootstrap: !hasOrganizations,
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await organizationsCollection.insertOne(organization);
      role = "admin";
    } catch (error) {
      if (error.code !== 11000) throw error;
      if (organization.isBootstrap) {
        organization.isBootstrap = false;
        await organizationsCollection.insertOne(organization);
        role = "admin";
      } else {
        throw error;
      }
    }
    role = "admin";
  }

  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    passwordFormat: "bcrypt",
    role,
    organizationId: organization.id,
    createdAt: now,
    updatedAt: now,
  };
  if (role === "admin" && !organization.createdBy) {
    organization.createdBy = user.id;
    organization.updatedAt = now;
    await organizationsCollection.updateOne(
      { id: organization.id, createdBy: null },
      { $set: { createdBy: user.id, updatedAt: now } }
    );
  }
  await usersCollection.insertOne(user);
  await ensureWorkspaceTeams(organization.id);

  const remember = body.remember === true;
  setAuthCookie(request, response, createToken(user, remember), remember);
  sendJson(response, 201, { token: createToken(user, false), user: publicUser(user) });
}

async function getWorkspaceSignupStatus(request, response) {
  const exists = (await organizationsCollection.countDocuments()) > 0;
  sendJson(response, 200, { workspaceExists: exists });
}

async function getWorkspace(request, response, user) {
  const organization = await organizationsCollection.findOne(
    { id: user.organizationId },
    { projection: { _id: 0, id: 1, name: 1, createdAt: 1, createdBy: 1, inviteCode: 1 } }
  );
  if (!organization) throw new HttpError(403, "Your workspace could not be found.");
  if (!["admin", "manager"].includes(user.role || "member")) delete organization.inviteCode;
  sendJson(response, 200, { organization });
}

async function rotateWorkspaceInvite(request, response, user) {
  const organization = await organizationsCollection.findOneAndUpdate(
    { id: user.organizationId },
    {
      $set: {
        inviteCode: createInviteCode(),
        updatedAt: new Date().toISOString(),
      },
    },
    { returnDocument: "after", projection: { _id: 0, id: 1, name: 1, inviteCode: 1 } }
  );
  if (!organization) throw new HttpError(404, "Workspace not found.");
  sendJson(response, 200, { organization });
}

async function verifyLegacyPassword(password, user) {
  if (!user.salt || !user.passwordHash) return false;
  const candidateHash = await scrypt(password, Buffer.from(user.salt, "hex"), 64);
  const storedHash = Buffer.from(user.passwordHash, "hex");
  return candidateHash.length === storedHash.length &&
    crypto.timingSafeEqual(candidateHash, storedHash);
}

async function login(request, response) {
  const body = await readJsonBody(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length > 128) {
    throw new HttpError(401, "Email or password is incorrect.");
  }

  const user = await usersCollection.findOne({ email });
  let valid = false;
  if (user) {
    if (user.passwordFormat === "bcrypt" || (!user.salt && user.passwordHash)) {
      valid = await bcrypt.compare(password, user.passwordHash);
    } else {
      valid = await verifyLegacyPassword(password, user);
      if (valid) {
        const migratedHash = await bcrypt.hash(password, 12);
        await usersCollection.updateOne(
          { id: user.id },
          {
            $set: {
              passwordHash: migratedHash,
              passwordFormat: "bcrypt",
              updatedAt: new Date().toISOString(),
            },
            $unset: { salt: "" },
          }
        );
        user.passwordHash = migratedHash;
        user.passwordFormat = "bcrypt";
      }
    }
  }

  if (!valid) {
    throw new HttpError(401, "Email or password is incorrect. If you're new, create an account first.");
  }

  const remember = body.remember === true;
  setAuthCookie(request, response, createToken(user, remember), remember);
  sendJson(response, 200, { token: createToken(user, false), user: publicUser(user) });
}

async function getProfile(request, response, user) {
  const organization = user.organizationId
    ? await organizationsCollection.findOne(
      { id: user.organizationId },
      { projection: { _id: 0, id: 1, name: 1 } }
    )
    : null;
  sendJson(response, 200, { user: publicUser(user), organization });
}

async function updateProfile(request, response, user) {
  const body = await readJsonBody(request);
  const updates = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 80) {
      throw new HttpError(400, "Enter a name between 2 and 80 characters.");
    }
    updates.name = name;
  }
  if (body.password !== undefined) {
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 10 || password.length > 128) {
      throw new HttpError(400, "Password must be between 10 and 128 characters.");
    }
    updates.passwordHash = await bcrypt.hash(password, 12);
    updates.passwordFormat = "bcrypt";
  }
  if (Object.keys(updates).length === 0) {
    throw new HttpError(400, "Provide a name or password to update.");
  }
  updates.updatedAt = new Date().toISOString();

  const result = await usersCollection.findOneAndUpdate(
    { id: user.id },
    { $set: updates },
    { returnDocument: "after" }
  );
  sendJson(response, 200, { user: publicUser(result) });
}

async function listUsers(request, response, user) {
  const users = await usersCollection.find(
    organizationFilter(user),
    { projection: { _id: 0, passwordHash: 0, passwordFormat: 0, salt: 0 } }
  ).toArray();
  sendJson(response, 200, { users: users.map(publicUser) });
}

async function listWorkspaceMembers(request, response, user) {
  const members = await usersCollection.find(
    organizationFilter(user),
    { projection: { _id: 0, id: 1, name: 1, role: 1 } }
  ).sort({ name: 1 }).toArray();
  sendJson(response, 200, { members });
}

async function listTeams(request, response, user) {
  const teams = await teamsCollection.find(
    organizationFilter(user),
    { projection: { _id: 0 } }
  ).sort({ name: 1 }).toArray();
  const memberIds = [...new Set(teams.flatMap((team) => team.memberIds || []))];
  const members = memberIds.length
    ? await usersCollection.find(
      { organizationId: user.organizationId, id: { $in: memberIds } },
      { projection: { id: 1, name: 1 } }
    ).toArray()
    : [];
  const memberById = new Map(members.map((member) => [member.id, member]));
  sendJson(response, 200, {
    teams: teams.map((team) => ({
      ...team,
      members: (team.memberIds || []).map((id) => memberById.get(id)).filter(Boolean),
      memberCount: (team.memberIds || []).length,
    })),
  });
}

async function validateTeamMembers(memberIds, user) {
  if (!Array.isArray(memberIds) || memberIds.some((id) => typeof id !== "string")) {
    throw new HttpError(400, "memberIds must be an array of workspace member IDs.");
  }
  const uniqueIds = [...new Set(memberIds)];
  if (uniqueIds.length !== memberIds.length) throw new HttpError(400, "A team cannot contain duplicate members.");
  if (!uniqueIds.length) return [];
  const count = await usersCollection.countDocuments({
    organizationId: user.organizationId,
    id: { $in: uniqueIds },
  });
  if (count !== uniqueIds.length) throw new HttpError(400, "Every team member must belong to this workspace.");
  return uniqueIds;
}

async function createTeam(request, response, user) {
  const body = await readJsonBody(request);
  assertAllowedFields(body, ["name", "memberIds"]);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 100) {
    throw new HttpError(400, "Team name must be between 2 and 100 characters.");
  }
  const memberIds = body.memberIds === undefined ? [] : await validateTeamMembers(body.memberIds, user);
  const now = new Date().toISOString();
  const team = {
    id: crypto.randomUUID(),
    organizationId: user.organizationId,
    name,
    memberIds,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await teamsCollection.insertOne(team);
  } catch (error) {
    if (error.code === 11000) throw new HttpError(409, "A team with this name already exists in your workspace.");
    throw error;
  }
  sendJson(response, 201, { team });
}

async function getTeamOrThrow(id, user) {
  assertEntityId(id, "team");
  const team = await teamsCollection.findOne({ id, ...organizationFilter(user) });
  if (!team) throw new HttpError(404, "Team not found.");
  return team;
}

async function updateTeam(request, response, id, user) {
  const team = await getTeamOrThrow(id, user);
  const body = await readJsonBody(request);
  assertAllowedFields(body, ["name", "memberIds"]);
  const updates = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 100) {
      throw new HttpError(400, "Team name must be between 2 and 100 characters.");
    }
    updates.name = name;
  }
  if (body.memberIds !== undefined) updates.memberIds = await validateTeamMembers(body.memberIds, user);
  if (!Object.keys(updates).length) throw new HttpError(400, "Provide a team name or member list to update.");
  updates.updatedAt = new Date().toISOString();
  try {
    const result = await teamsCollection.findOneAndUpdate(
      { id: team.id, organizationId: user.organizationId },
      { $set: updates },
      { returnDocument: "after" }
    );
    sendJson(response, 200, { team: entityResult(result) });
  } catch (error) {
    if (error.code === 11000) throw new HttpError(409, "A team with this name already exists in your workspace.");
    throw error;
  }
}

async function deleteTeam(request, response, id, user) {
  const team = await getTeamOrThrow(id, user);
  if (await tasksCollection.countDocuments({ organizationId: user.organizationId, teamId: team.id })) {
    throw new HttpError(409, "A team with assigned tasks cannot be deleted.");
  }
  await teamsCollection.deleteOne({ id: team.id, organizationId: user.organizationId });
  sendJson(response, 200, { success: true });
}

async function updateUserRole(request, response, actor) {
  const body = await readJsonBody(request);
  const id = typeof body.id === "string" ? body.id : "";
  const role = typeof body.role === "string" ? body.role : "";
  if (!["member", "manager", "admin"].includes(role)) {
    throw new HttpError(400, "Role must be member, manager, or admin.");
  }
  const user = await usersCollection.findOneAndUpdate(
    { id, organizationId: actor.organizationId },
    { $set: { role, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!user) throw new HttpError(404, "User not found.");
  sendJson(response, 200, { user: publicUser(user) });
}

async function createTask(request, response, user) {
  const body = await readJsonBody(request);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const requestedTeam = typeof body.team === "string" ? body.team.trim() : "";
  const requestedAssignee = typeof body.assigneeId === "string"
    ? body.assigneeId.trim()
    : typeof body.assignee === "string" ? body.assignee.trim() : "";
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const priority = typeof body.priority === "string" ? body.priority : "";
  const dueDate = typeof body.dueDate === "string" ? body.dueDate : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const contributionPoints = Number(body.contributionPoints);

  if (!title || title.length > 100) throw new HttpError(400, "Task name is required.");
  const teamRecord = await teamsCollection.findOne({
    organizationId: user.organizationId,
    $or: [{ id: requestedTeam }, { name: requestedTeam }],
  });
  if (!teamRecord) throw new HttpError(400, "Choose a team from your workspace.");
  const assignedUser = await usersCollection.findOne(
    { id: requestedAssignee, organizationId: user.organizationId },
    { projection: { id: 1, name: 1 } }
  ) || await usersCollection.findOne(
    { name: requestedAssignee, organizationId: user.organizationId },
    { projection: { id: 1, name: 1 } }
  );
  if (!assignedUser) throw new HttpError(400, "Choose a member from your workspace.");
  if (!Number.isSafeInteger(contributionPoints) || contributionPoints < 1) throw new HttpError(400, "Contribution points must be positive.");
  if (project.length > 100) throw new HttpError(400, "Project name is too long.");
  if (!["Low", "Medium", "High", "Urgent"].includes(priority)) throw new HttpError(400, "Choose a valid priority.");
  if (!isValidDateOnly(dueDate)) throw new HttpError(400, "Choose a valid due date.");
  if (!description || description.length > 1000) throw new HttpError(400, "Description is required.");

  const task = {
    id: crypto.randomUUID(),
    title, team: teamRecord.name, teamId: teamRecord.id, assignee: assignedUser.name, assigneeId: assignedUser.id,
    contributionPoints, project, priority, dueDate, description,
    organizationId: user.organizationId,
    status: "Assigned",
    createdBy: user.id,
    createdAt: new Date().toISOString(),
  };
  await tasksCollection.insertOne(task);
  sendJson(response, 201, { task });
}

function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTime(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  return true;
}

function assertEntityId(id, label) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new HttpError(400, `Invalid ${label} ID.`);
  }
}

function assertAllowedFields(body, allowedFields) {
  const unexpected = Object.keys(body).find((key) => !allowedFields.includes(key));
  if (unexpected) throw new HttpError(400, `Unsupported field: ${unexpected}.`);
}

function paginationFromQuery(searchParams) {
  const parse = (key, fallback, maximum) => {
    const raw = searchParams.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) throw new HttpError(400, `${key} must be a positive integer.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new HttpError(400, `${key} must be between 1 and ${maximum}.`);
    }
    return value;
  };
  const page = parse("page", 1, 1000000);
  const limit = parse("limit", 50, 100);
  return { page, limit, skip: (page - 1) * limit };
}

function entityResult(document) {
  if (!document) return document;
  const { _id, ...result } = document;
  return result;
}

function completedStatusExpression() {
  return {
    $in: [
      { $toLower: { $ifNull: ["$status", ""] } },
      completedTaskStatuses,
    ],
  };
}

function taskMetricAccumulators(today) {
  const completed = completedStatusExpression();
  const status = { $toLower: { $ifNull: ["$status", ""] } };
  return {
    totalTasks: { $sum: 1 },
    completedTasks: { $sum: { $cond: [completed, 1, 0] } },
    inProgressTasks: {
      $sum: {
        $cond: [{ $in: [status, inProgressTaskStatuses] }, 1, 0],
      },
    },
    reviewTasks: {
      $sum: {
        $cond: [{ $in: [status, reviewTaskStatuses] }, 1, 0],
      },
    },
    overdueTasks: {
      $sum: {
        $cond: [
          {
            $and: [
              { $eq: [{ $type: "$dueDate" }, "string"] },
              { $lt: ["$dueDate", today] },
              { $not: [completed] },
            ],
          },
          1,
          0,
        ],
      },
    },
  };
}

function summarizeTaskMetrics(metrics = {}) {
  const totalTasks = metrics.totalTasks || 0;
  const completedTasks = metrics.completedTasks || 0;
  return {
    totalTasks,
    completedTasks,
    pendingTasks: totalTasks - completedTasks,
    inProgressTasks: metrics.inProgressTasks || 0,
    reviewTasks: metrics.reviewTasks || 0,
    overdueTasks: metrics.overdueTasks || 0,
    completionPercentage: totalTasks
      ? Number(((completedTasks / totalTasks) * 100).toFixed(2))
      : 0,
  };
}

function buildDashboardPeriods(dailyRows, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rowsByDate = new Map(dailyRows.map((row) => [row._id, row]));
  const days = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - offset);
    const dateString = date.toISOString().slice(0, 10);
    days.push({
      date: dateString,
      label: date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
      ...(rowsByDate.get(dateString) || {}),
    });
  }

  const toPeriod = (periodDays) => {
    const periodRows = days.slice(-periodDays);
    const totals = periodRows.reduce((result, row) => {
      result.total += row.totalTasks || 0;
      result.completed += row.completedTasks || 0;
      result.inProgress += row.inProgressTasks || 0;
      result.review += row.reviewTasks || 0;
      result.overdue += row.overdueTasks || 0;
      return result;
    }, { total: 0, completed: 0, inProgress: 0, review: 0, overdue: 0 });
    const chartRows = days.slice(-7);
    const daily = {
      labels: chartRows.map((row) => row.label),
      total: chartRows.map((row) => row.totalTasks || 0),
      completed: chartRows.map((row) => row.completedTasks || 0),
      inProgress: chartRows.map((row) => row.inProgressTasks || 0),
      review: chartRows.map((row) => row.reviewTasks || 0),
      overdue: chartRows.map((row) => row.overdueTasks || 0),
    };
    return { totals, daily };
  };

  return { week: toPeriod(7), month: toPeriod(30) };
}

async function dashboardOverview(request, response, user) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monthStart.setUTCDate(monthStart.getUTCDate() - 29);
  const startDate = monthStart.toISOString().slice(0, 10);
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    .toISOString()
    .slice(0, 10);

  const [result] = await tasksCollection.aggregate([
    { $match: organizationFilter(user) },
    {
      $facet: {
        summary: [{ $group: { _id: null, ...taskMetricAccumulators(today) } }],
        statusCounts: [
          { $group: { _id: { $ifNull: ["$status", "Unknown"] }, count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
        ],
        daily: [
          {
            $match: {
              createdAt: { $type: "string", $gte: startDate, $lt: tomorrow },
            },
          },
          {
            $group: {
              _id: { $substrBytes: ["$createdAt", 0, 10] },
              ...taskMetricAccumulators(today),
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]).toArray();
  const metrics = summarizeTaskMetrics((result.summary || [])[0]);
  sendJson(response, 200, {
    ...metrics,
    statusCounts: (result.statusCounts || []).map(({ _id, count }) => ({ status: _id, count })),
    periods: buildDashboardPeriods(result.daily || [], now),
  });
}

async function dashboardTaskStats(request, response, user) {
  const today = new Date().toISOString().slice(0, 10);
  const [result] = await tasksCollection.aggregate([
    { $match: organizationFilter(user) },
    {
      $facet: {
        summary: [{ $group: { _id: null, ...taskMetricAccumulators(today) } }],
        statusCounts: [
          { $group: { _id: { $ifNull: ["$status", "Unknown"] }, count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
        ],
      },
    },
  ]).toArray();
  sendJson(response, 200, {
    ...summarizeTaskMetrics((result.summary || [])[0]),
    statusCounts: (result.statusCounts || []).map(({ _id, count }) => ({ status: _id, count })),
  });
}

async function dashboardCompletion(request, response, user) {
  const today = new Date().toISOString().slice(0, 10);
  const [result] = await tasksCollection.aggregate([
    { $match: organizationFilter(user) },
    { $group: { _id: null, ...taskMetricAccumulators(today) } },
  ]).toArray();
  const metrics = summarizeTaskMetrics(result);
  sendJson(response, 200, {
    totalTasks: metrics.totalTasks,
    completedTasks: metrics.completedTasks,
    pendingTasks: metrics.pendingTasks,
    completionPercentage: metrics.completionPercentage,
  });
}

function performancePipeline(user, match = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    { $match: { ...organizationFilter(user), ...match } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { $ifNull: ["$assigneeId", { $concat: ["legacy:", "$assignee"] }] },
        memberName: { $first: "$assignee" },
        teamName: { $first: "$team" },
          contributionPoints: {
            $sum: {
              $cond: [
                completedStatusExpression(),
                { $cond: [{ $isNumber: "$contributionPoints" }, "$contributionPoints", 0] },
                0,
              ],
            },
          },
        ...taskMetricAccumulators(today),
      },
    },
  ];
}

function performanceResponse(row, organizationCompletedTasks) {
  const metrics = summarizeTaskMetrics(row);
  return {
    memberId: null,
    memberName: row._id,
    teamName: row.teamName || null,
    contributionPoints: row.contributionPoints || 0,
    totalTasks: metrics.totalTasks,
    completedTasks: metrics.completedTasks,
    pendingTasks: metrics.pendingTasks,
    overdueTasks: metrics.overdueTasks,
    completionPercentage: metrics.completionPercentage,
    contributionPercentage: organizationCompletedTasks
      ? Number(((metrics.completedTasks / organizationCompletedTasks) * 100).toFixed(2))
      : 0,
  };
}

async function getOrganizationCompletedTaskCount(user) {
  const [result] = await tasksCollection.aggregate([
    { $match: organizationFilter(user) },
    { $group: { _id: null, completedTasks: { $sum: { $cond: [completedStatusExpression(), 1, 0] } } } },
  ]).toArray();
  return result ? result.completedTasks : 0;
}

async function dashboardTeamPerformance(request, response, user) {
  const teamFilter = new URL(request.url, "http://localhost").searchParams.get("team");
  let selectedTeamId = null;
  if (teamFilter) {
    const selectedTeam = await teamsCollection.findOne({
      organizationId: user.organizationId,
      $or: [{ id: teamFilter }, { name: teamFilter }],
    });
    if (!selectedTeam) throw new HttpError(404, "Team not found.");
    selectedTeamId = selectedTeam.id;
  }
  const teamsInWorkspace = await teamsCollection.find(
    teamFilter ? { organizationId: user.organizationId, id: selectedTeamId } : organizationFilter(user),
    { projection: { _id: 0 } }
  ).sort({ name: 1 }).toArray();
  const rows = await tasksCollection.aggregate([
    { $match: { ...organizationFilter(user), ...(teamFilter ? { teamId: selectedTeamId } : {}) } },
    {
      $group: {
        _id: "$teamId",
        assignedMembers: { $addToSet: { $ifNull: ["$assigneeId", "$assignee"] } },
        ...taskMetricAccumulators(new Date().toISOString().slice(0, 10)),
      },
    },
  ]).toArray();
  const rowsByTeam = new Map(rows.map((row) => [row._id, row]));
  const organizationCompletedTasks = await getOrganizationCompletedTaskCount(user);
  const teams = teamsInWorkspace.map((team) => {
    const row = rowsByTeam.get(team.id) || { _id: team.id };
    const metrics = summarizeTaskMetrics(row);
    return {
      teamId: team.id,
      teamName: team.name,
      totalTasks: metrics.totalTasks,
      completedTasks: metrics.completedTasks,
      pendingTasks: metrics.pendingTasks,
      memberCount: (team.memberIds || []).length,
      assignedMemberCount: (row.assignedMembers || []).filter(Boolean).length,
      overdueTasks: metrics.overdueTasks,
      completionPercentage: metrics.completionPercentage,
      contributionPercentage: organizationCompletedTasks
        ? Number(((metrics.completedTasks / organizationCompletedTasks) * 100).toFixed(2))
        : 0,
    };
  });
  sendJson(response, 200, { teams });
}

async function dashboardMemberPerformance(request, response, user, topPerformers = false) {
  const searchParams = new URL(request.url, "http://localhost").searchParams;
  const pagination = paginationFromQuery(searchParams);
  const match = { assignee: { $type: "string", $ne: "" } };
  const teamFilter = searchParams.get("team");
  let selectedTeamId = null;
  let selectedTeam;
  if (teamFilter) {
    selectedTeam = await teamsCollection.findOne({
      organizationId: user.organizationId,
      $or: [{ id: teamFilter }, { name: teamFilter }],
    });
    if (!selectedTeam) throw new HttpError(404, "Team not found.");
    selectedTeamId = selectedTeam.id;
    match.teamId = selectedTeam.id;
  }

  const memberFilter = searchParams.get("member");
  let selectedAccounts;
  if (memberFilter) {
    const account = await usersCollection.findOne(
      { id: memberFilter, organizationId: user.organizationId },
      { projection: { id: 1, name: 1 } }
    );
    if (!account) throw new HttpError(404, "Workspace member not found.");
    selectedAccounts = [account];
    delete match.assignee;
    match.$or = [
      { assigneeId: account.id },
      { assignee: account.name, assigneeId: { $exists: false } },
    ];
  } else {
    const accountFilter = organizationFilter(user);
    if (selectedTeam) {
      const [assignedIds, legacyNames] = await Promise.all([
        tasksCollection.distinct("assigneeId", {
          organizationId: user.organizationId,
          teamId: selectedTeam.id,
          assigneeId: { $type: "string" },
        }),
        tasksCollection.distinct("assignee", {
          organizationId: user.organizationId,
          teamId: selectedTeam.id,
          assigneeId: { $exists: false },
        }),
      ]);
      const teamMemberIds = [...new Set([...(selectedTeam.memberIds || []), ...assignedIds])];
      accountFilter.$or = [
        { id: { $in: teamMemberIds } },
        { name: { $in: legacyNames } },
      ];
    }
    selectedAccounts = await usersCollection.find(
      accountFilter,
      { projection: { id: 1, name: 1 } }
    ).sort({ name: 1 }).toArray();
  }

  const rows = await tasksCollection.aggregate(performancePipeline(user, match)).toArray();
  const rowsById = new Map(rows.filter((row) => !String(row._id).startsWith("legacy:")).map((row) => [row._id, row]));
  const rowsByName = new Map(rows.filter((row) => String(row._id).startsWith("legacy:"))
    .map((row) => [String(row._id).slice("legacy:".length), row]));
  const organizationCompletedTasks = await getOrganizationCompletedTaskCount(user);
  const membershipQuery = {
    organizationId: user.organizationId,
    memberIds: { $in: selectedAccounts.map((account) => account.id) },
  };
  if (selectedTeamId) membershipQuery.id = selectedTeamId;
  const teamMemberships = await teamsCollection.find(
    membershipQuery,
    { projection: { id: 1, name: 1, memberIds: 1 } }
  ).toArray();
  const teamNamesByMember = new Map();
  for (const team of teamMemberships) {
    for (const memberId of team.memberIds || []) {
      const memberTeamNames = teamNamesByMember.get(memberId) || [];
      memberTeamNames.push(team.name);
      teamNamesByMember.set(memberId, memberTeamNames);
    }
  }
  const members = selectedAccounts.map((account) => {
    const row = rowsById.get(account.id) || rowsByName.get(account.name) || {
      _id: account.name,
      memberName: account.name,
      teamName: null,
      totalTasks: 0,
      completedTasks: 0,
      overdueTasks: 0,
    };
    const member = {
      ...performanceResponse({ ...row, _id: account.name }, organizationCompletedTasks),
      memberId: account.id,
    };
    member.teamNames = teamNamesByMember.get(account.id) || [];
    if (!member.teamName && member.teamNames.length) member.teamName = member.teamNames[0];
    return member;
  });
  for (const row of rows) {
    const account = !String(row._id).startsWith("legacy:")
      ? selectedAccounts.find((candidate) => candidate.id === row._id)
      : selectedAccounts.find((candidate) => candidate.name === String(row._id).slice("legacy:".length));
    if (!account) {
      members.push({
        ...performanceResponse({ ...row, _id: row.memberName || String(row._id).slice("legacy:".length) }, organizationCompletedTasks),
        memberId: null,
      });
    }
  }
  const filteredMembers = topPerformers
    ? members.filter((member) => member.totalTasks > 0)
    : members;
  filteredMembers.sort((left, right) =>
    topPerformers
      ? right.contributionPoints - left.contributionPoints ||
        right.completionPercentage - left.completionPercentage ||
        right.completedTasks - left.completedTasks ||
        left.memberName.localeCompare(right.memberName)
      : left.memberName.localeCompare(right.memberName)
  );
  const total = filteredMembers.length;
  const pagedMembers = filteredMembers.slice(pagination.skip, pagination.skip + pagination.limit);
  if (topPerformers) {
    sendJson(response, 200, {
      members: pagedMembers,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        pages: Math.ceil(total / pagination.limit),
      },
    });
    return;
  }

  sendJson(response, 200, {
    members: pagedMembers,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      pages: Math.ceil(total / pagination.limit),
    },
  });
}

function validateEventFields(body, partial = false) {
  const fields = ["title", "description", "eventDate", "startTime", "endTime", "location"];
  assertAllowedFields(body, fields);
  const result = {};
  for (const field of fields) {
    if (body[field] === undefined && partial) continue;
    if (field === "title") {
      const value = typeof body.title === "string" ? body.title.trim() : "";
      if (!value || value.length > 120) throw new HttpError(400, "Event title is required and must be at most 120 characters.");
      result.title = value;
    } else if (field === "eventDate") {
      if (!isValidDateOnly(body.eventDate)) throw new HttpError(400, "Event date must be a valid YYYY-MM-DD date.");
      result.eventDate = body.eventDate;
    } else if (field === "startTime" || field === "endTime") {
      const value = body[field] === undefined ? "" : body[field];
      if (value !== "" && value !== null && !isValidTime(value)) {
        throw new HttpError(400, `${field} must use 24-hour HH:MM format.`);
      }
      result[field] = value || null;
    } else {
      const value = body[field] === undefined || body[field] === null ? "" : body[field];
      if (typeof value !== "string" || value.length > (field === "description" ? 2000 : 200)) {
        throw new HttpError(400, `Event ${field} is too long or invalid.`);
      }
      result[field] = value.trim();
    }
  }
  const startTime = result.startTime === undefined ? body.startTime : result.startTime;
  const endTime = result.endTime === undefined ? body.endTime : result.endTime;
  if (startTime && endTime && startTime >= endTime) {
    throw new HttpError(400, "Event end time must be later than its start time.");
  }
  return result;
}

function eventChecklistCounts(event) {
  const checklist = Array.isArray(event.checklist) ? event.checklist : [];
  const completedItems = checklist.filter((item) => item.completed).length;
  return { completedChecklistItems: completedItems, pendingChecklistItems: checklist.length - completedItems };
}

async function getEventOrThrow(id, user) {
  assertEntityId(id, "event");
  const event = await eventsCollection.findOne({ id, ...organizationFilter(user) });
  if (!event) throw new HttpError(404, "Event not found.");
  return event;
}

async function listEvents(request, response, user) {
  const searchParams = new URL(request.url, "http://localhost").searchParams;
  const { page, limit, skip } = paginationFromQuery(searchParams);
  const filter = organizationFilter(user);
  const status = searchParams.get("status");
  if (status && !["upcoming", "past"].includes(status)) {
    throw new HttpError(400, "Event status must be upcoming or past.");
  }
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from && !isValidDateOnly(from)) throw new HttpError(400, "from must be a valid YYYY-MM-DD date.");
  if (to && !isValidDateOnly(to)) throw new HttpError(400, "to must be a valid YYYY-MM-DD date.");
  if (from && to && from > to) throw new HttpError(400, "from must not be later than to.");

  const today = new Date().toISOString().slice(0, 10);
  if (status === "upcoming") filter.eventDate = { $gte: today };
  if (status === "past") filter.eventDate = { $lt: today };
  if (from || to) {
    filter.eventDate = { ...(filter.eventDate || {}) };
    if (from) {
      filter.eventDate.$gte = filter.eventDate.$gte
        ? (from > filter.eventDate.$gte ? from : filter.eventDate.$gte)
        : from;
    }
    if (to) filter.eventDate.$lte = to;
  }

  const sort = status === "past" ? { eventDate: -1, startTime: -1 } : { eventDate: 1, startTime: 1 };
  const [events, total] = await Promise.all([
    eventsCollection.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
    eventsCollection.countDocuments(filter),
  ]);
  sendJson(response, 200, {
    events: events.map((event) => ({ ...entityResult(event), ...eventChecklistCounts(event) })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

async function getEvent(request, response, id, user) {
  const event = await getEventOrThrow(id, user);
  sendJson(response, 200, { event: { ...entityResult(event), ...eventChecklistCounts(event) } });
}

async function createEvent(request, response, user) {
  const body = await readJsonBody(request);
  const fields = validateEventFields(body);
  const now = new Date().toISOString();
  const event = {
    id: crypto.randomUUID(),
    ...fields,
    organizationId: user.organizationId,
    createdBy: user.id,
    checklist: [],
    createdAt: now,
    updatedAt: now,
  };
  await eventsCollection.insertOne(event);
  sendJson(response, 201, { event });
}

async function updateEvent(request, response, id, user) {
  const event = await getEventOrThrow(id, user);
  const body = await readJsonBody(request);
  const updates = validateEventFields(body, true);
  if (Object.keys(updates).length === 0) throw new HttpError(400, "Provide at least one event field to update.");
  const combined = { ...event, ...updates };
  if (combined.startTime && combined.endTime && combined.startTime >= combined.endTime) {
    throw new HttpError(400, "Event end time must be later than its start time.");
  }
  updates.updatedAt = new Date().toISOString();
  const result = await eventsCollection.findOneAndUpdate(
    { id, ...organizationFilter(user) },
    { $set: updates },
    { returnDocument: "after" }
  );
  sendJson(response, 200, { event: entityResult(result) });
}

async function deleteEvent(request, response, id, user) {
  await getEventOrThrow(id, user);
  await eventsCollection.deleteOne({ id, ...organizationFilter(user) });
  sendJson(response, 200, { success: true });
}

async function getEventChecklist(request, response, eventId, user) {
  const event = await getEventOrThrow(eventId, user);
  sendJson(response, 200, { checklist: event.checklist || [], ...eventChecklistCounts(event) });
}

async function addEventChecklistItem(request, response, user, eventId) {
  const event = await getEventOrThrow(eventId, user);
  const body = await readJsonBody(request);
  assertAllowedFields(body, ["title", "description", "assignedMember"]);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = body.description === undefined ? "" : body.description;
  if (!title || title.length > 160) throw new HttpError(400, "Checklist item title is required and must be at most 160 characters.");
  if (typeof description !== "string" || description.length > 1000) {
    throw new HttpError(400, "Checklist item description must be at most 1000 characters.");
  }
  let assignedMember = null;
  if (body.assignedMember !== undefined && body.assignedMember !== null && body.assignedMember !== "") {
    if (typeof body.assignedMember !== "string") throw new HttpError(400, "assignedMember must be a user ID.");
    const member = await usersCollection.findOne(
      { id: body.assignedMember, organizationId: user.organizationId },
      { projection: { id: 1 } }
    );
    if (!member) throw new HttpError(400, "Checklist assignee must be an existing workspace member.");
    assignedMember = member.id;
  }
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    title,
    description: description.trim(),
    assignedMember,
    completed: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: user.id,
  };
  await eventsCollection.updateOne(
    { id: event.id, ...organizationFilter(user) },
    { $push: { checklist: item }, $set: { updatedAt: now } }
  );
  sendJson(response, 201, { item });
}

async function updateEventChecklistItem(request, response, user, eventId, itemId) {
  const event = await getEventOrThrow(eventId, user);
  const body = await readJsonBody(request);
  assertAllowedFields(body, ["title", "description", "assignedMember", "completed"]);
  const checklist = event.checklist || [];
  const index = checklist.findIndex((item) => item.id === itemId);
  if (index < 0) throw new HttpError(404, "Checklist item not found.");

  const item = { ...checklist[index] };
  const isManager = ["admin", "manager"].includes(user.role || "member");
  const hasDetailChanges = ["title", "description", "assignedMember"].some((key) => body[key] !== undefined);
  if (hasDetailChanges && !isManager) {
    throw new HttpError(403, "Only managers and admins can edit checklist item details.");
  }
  if (!isManager && item.assignedMember !== user.id) {
    throw new HttpError(403, "Only the assigned member, a manager, or an admin can update this checklist item.");
  }

  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 160) throw new HttpError(400, "Checklist item title is required and must be at most 160 characters.");
    item.title = title;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > 1000) {
      throw new HttpError(400, "Checklist item description must be at most 1000 characters.");
    }
    item.description = body.description.trim();
  }
  if (body.assignedMember !== undefined) {
    if (body.assignedMember === null || body.assignedMember === "") {
      item.assignedMember = null;
    } else {
      if (typeof body.assignedMember !== "string") throw new HttpError(400, "assignedMember must be a user ID.");
      const member = await usersCollection.findOne(
        { id: body.assignedMember, organizationId: user.organizationId },
        { projection: { id: 1 } }
      );
      if (!member) throw new HttpError(400, "Checklist assignee must be an existing workspace member.");
      item.assignedMember = member.id;
    }
  }
  if (body.completed !== undefined) {
    if (typeof body.completed !== "boolean") throw new HttpError(400, "completed must be true or false.");
    item.completed = body.completed;
    item.completedAt = body.completed ? (item.completedAt || new Date().toISOString()) : null;
  }
  item.updatedAt = new Date().toISOString();
  checklist[index] = item;
  await eventsCollection.updateOne(
    { id: event.id, ...organizationFilter(user) },
    { $set: { "checklist.$[entry]": item, updatedAt: item.updatedAt } },
    { arrayFilters: [{ "entry.id": itemId }] }
  );
  sendJson(response, 200, { item });
}

async function deleteEventChecklistItem(request, response, eventId, itemId, user) {
  const event = await getEventOrThrow(eventId, user);
  const checklist = event.checklist || [];
  if (!checklist.some((item) => item.id === itemId)) throw new HttpError(404, "Checklist item not found.");
  const updatedAt = new Date().toISOString();
  await eventsCollection.updateOne(
    { id: event.id, ...organizationFilter(user) },
    { $pull: { checklist: { id: itemId } }, $set: { updatedAt } }
  );
  sendJson(response, 200, { success: true });
}

function validateAnnouncementFields(body, partial = false) {
  assertAllowedFields(body, ["title", "message", "priority"]);
  const updates = {};
  if (!partial || body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 160) throw new HttpError(400, "Announcement title is required and must be at most 160 characters.");
    updates.title = title;
  }
  if (!partial || body.message !== undefined) {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 10000) throw new HttpError(400, "Announcement message is required and must be at most 10000 characters.");
    updates.message = message;
  }
  if (!partial || body.priority !== undefined) {
    const priority = body.priority === undefined ? "Normal" : body.priority;
    if (!announcementPriorities.includes(priority)) {
      throw new HttpError(400, "Priority must be Normal, Important, or Urgent.");
    }
    updates.priority = priority;
  }
  return updates;
}

async function listAnnouncements(request, response, user) {
  const searchParams = new URL(request.url, "http://localhost").searchParams;
  const { page, limit, skip } = paginationFromQuery(searchParams);
  const filter = organizationFilter(user);
  const priority = searchParams.get("priority");
  if (priority) {
    if (!announcementPriorities.includes(priority)) throw new HttpError(400, "Invalid announcement priority.");
    filter.priority = priority;
  }
  const [announcements, total] = await Promise.all([
    announcementsCollection.find(filter).sort({ createdAt: -1, id: -1 }).skip(skip).limit(limit).toArray(),
    announcementsCollection.countDocuments(filter),
  ]);
  sendJson(response, 200, {
    announcements: announcements.map(entityResult),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

async function getAnnouncementOrThrow(id, user) {
  assertEntityId(id, "announcement");
  const announcement = await announcementsCollection.findOne({ id, ...organizationFilter(user) });
  if (!announcement) throw new HttpError(404, "Announcement not found.");
  return announcement;
}

async function getAnnouncement(request, response, id, user) {
  sendJson(response, 200, { announcement: entityResult(await getAnnouncementOrThrow(id, user)) });
}

async function createAnnouncement(request, response, user) {
  const body = await readJsonBody(request);
  const now = new Date().toISOString();
  const announcement = {
    id: crypto.randomUUID(),
    ...validateAnnouncementFields(body),
    organizationId: user.organizationId,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };
  await announcementsCollection.insertOne(announcement);
  sendJson(response, 201, { announcement });
}

async function updateAnnouncement(request, response, id, user) {
  await getAnnouncementOrThrow(id, user);
  const updates = validateAnnouncementFields(await readJsonBody(request), true);
  if (Object.keys(updates).length === 0) throw new HttpError(400, "Provide at least one announcement field to update.");
  updates.updatedAt = new Date().toISOString();
  const result = await announcementsCollection.findOneAndUpdate(
    { id, ...organizationFilter(user) },
    { $set: updates },
    { returnDocument: "after" }
  );
  sendJson(response, 200, { announcement: entityResult(result) });
}

async function deleteAnnouncement(request, response, id, user) {
  await getAnnouncementOrThrow(id, user);
  await announcementsCollection.deleteOne({ id, ...organizationFilter(user) });
  sendJson(response, 200, { success: true });
}

async function listTasks(request, response, user) {
  const searchParams = new URL(request.url, "http://localhost").searchParams;
  const { page, limit, skip } = paginationFromQuery(searchParams);
  const filter = organizationFilter(user);
  const due = searchParams.get("due");
  if (due && !["upcoming", "overdue", "past"].includes(due)) {
    throw new HttpError(400, "due must be upcoming, overdue, or past.");
  }
  const today = new Date().toISOString().slice(0, 10);
  if (due === "upcoming") {
    filter.dueDate = { $gte: today };
    filter.$expr = { $not: [completedStatusExpression()] };
  } else if (due === "overdue") {
    filter.dueDate = { $lt: today };
    filter.$expr = { $not: [completedStatusExpression()] };
  } else if (due === "past") {
    filter.dueDate = { $lt: today };
  }
  const team = searchParams.get("team") || searchParams.get("teamId");
  if (team) {
    const teamRecord = await teamsCollection.findOne({
      organizationId: user.organizationId,
      $or: [{ id: team }, { name: team }],
    });
    if (!teamRecord) throw new HttpError(404, "Team not found.");
    filter.teamId = teamRecord.id;
  }
  const [tasks, total] = await Promise.all([
    tasksCollection.find(filter).sort({ dueDate: 1, createdAt: -1 }).skip(skip).limit(limit).toArray(),
    tasksCollection.countDocuments(filter),
  ]);
  sendJson(response, 200, {
    tasks: tasks.map((task) => ({
      ...entityResult(task),
      canUpdateStatus: ["admin", "manager"].includes(user.role || "member") ||
        (task.assigneeId ? task.assigneeId === user.id : task.assignee === user.name),
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

async function updateTaskStatus(request, response, user, id) {
  assertEntityId(id, "task");
  const body = await readJsonBody(request);
  assertAllowedFields(body, ["status"]);
  if (!taskStatuses.includes(body.status)) {
    throw new HttpError(400, `Status must be one of: ${taskStatuses.join(", ")}.`);
  }
  const filter = { id, ...organizationFilter(user) };
  const task = await tasksCollection.findOne(filter, { projection: { assignee: 1, assigneeId: 1 } });
  if (!task) throw new HttpError(404, "Task not found.");
  const isAssignedMember = task.assigneeId
    ? task.assigneeId === user.id
    : task.assignee === user.name;
  if (!["admin", "manager"].includes(user.role || "member") && !isAssignedMember) {
    throw new HttpError(403, "You can update only tasks assigned to you.");
  }
  const updates = {
    status: body.status,
    updatedAt: new Date().toISOString(),
  };
  if (completedTaskStatuses.includes(body.status.toLowerCase())) {
    updates.completedAt = task.completedAt || updates.updatedAt;
  } else {
    updates.completedAt = null;
  }
  const updated = await tasksCollection.findOneAndUpdate(
    filter,
    { $set: updates },
    { returnDocument: "after" }
  );
  sendJson(response, 200, { task: entityResult(updated) });
}

async function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function handleApiRequest(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/organizations/bootstrap-status") {
    await getWorkspaceSignupStatus(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/auth/session") {
    const user = await authenticate(request);
    sendJson(response, 200, { user: user ? publicUser(user) : null });
    return;
  }
  if (request.method === "POST" && pathname === "/api/auth/signup") {
    await createAccount(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/auth/login") {
    await login(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const secure = request.socket.encrypted ? "; Secure" : "";
    response.setHeader("Set-Cookie", `orbit_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    sendJson(response, 200, { success: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/users/me") {
    await requireAuth(getProfile)(request, response);
    return;
  }
  if (request.method === "PATCH" && pathname === "/api/users/me") {
    await requireAuth(updateProfile)(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/users") {
    await requireRole("manager", "admin")(listUsers)(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/organizations/members") {
    await requireAuth(listWorkspaceMembers)(request, response);
    return;
  }
  if (pathname === "/api/teams") {
    if (request.method === "GET") {
      await requireAuth(listTeams)(request, response);
      return;
    }
    if (request.method === "POST") {
      await requireRole("manager", "admin")(createTeam)(request, response);
      return;
    }
  }
  const teamMatch = pathname.match(/^\/api\/teams\/([^/]+)$/);
  if (teamMatch) {
    if (request.method === "PUT") {
      await requireRole("manager", "admin")(
        (req, res, user) => updateTeam(req, res, teamMatch[1], user)
      )(request, response);
      return;
    }
    if (request.method === "DELETE") {
      await requireRole("admin")(
        (req, res, user) => deleteTeam(req, res, teamMatch[1], user)
      )(request, response);
      return;
    }
  }
  if (request.method === "PATCH" && pathname === "/api/users/role") {
    await requireRole("admin")(updateUserRole)(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/organizations/me") {
    await requireAuth(getWorkspace)(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/organizations/me/invite-code") {
    await requireRole("admin")(rotateWorkspaceInvite)(request, response);
    return;
  }

  if (request.method === "POST" && pathname === "/api/tasks") {
    await requireAuth(createTask)(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/tasks") {
    await requireAuth(listTasks)(request, response);
    return;
  }
  const taskStatusMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (request.method === "PATCH" && taskStatusMatch) {
    await requireAuth((req, res, user) => updateTaskStatus(req, res, user, taskStatusMatch[1]))(request, response);
    return;
  }

  if (request.method === "GET" && pathname === "/api/dashboard/overview") {
    await requireAuth(dashboardOverview)(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/dashboard/task-stats") {
    await requireAuth(dashboardTaskStats)(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/dashboard/completion") {
    await requireAuth(dashboardCompletion)(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/dashboard/team-performance") {
    await requireAuth(dashboardTeamPerformance)(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/dashboard/top-performers") {
    await requireAuth((req, res, user) => dashboardMemberPerformance(req, res, user, true))(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/dashboard/member-performance") {
    await requireAuth((req, res, user) => dashboardMemberPerformance(req, res, user))(request, response);
    return;
  }

  if (pathname === "/api/events") {
    if (request.method === "GET") {
      await requireAuth(listEvents)(request, response);
      return;
    }
    if (request.method === "POST") {
      await requireRole("manager", "admin")(createEvent)(request, response);
      return;
    }
  }
  const checklistMatch = pathname.match(/^\/api\/events\/([^/]+)\/checklist(?:\/([^/]+))?$/);
  if (checklistMatch) {
    const eventId = checklistMatch[1];
    const itemId = checklistMatch[2];
    if (request.method === "GET" && !itemId) {
      await requireAuth((req, res, user) => getEventChecklist(req, res, eventId, user))(request, response);
      return;
    }
    if (request.method === "POST" && !itemId) {
      await requireRole("manager", "admin")(
        (req, res, user) => addEventChecklistItem(req, res, user, eventId)
      )(request, response);
      return;
    }
    if (request.method === "PATCH" && itemId) {
      await requireAuth(
        (req, res, user) => updateEventChecklistItem(req, res, user, eventId, itemId)
      )(request, response);
      return;
    }
    if (request.method === "DELETE" && itemId) {
      await requireRole("manager", "admin")(
        (req, res, user) => deleteEventChecklistItem(req, res, eventId, itemId, user)
      )(request, response);
      return;
    }
  }
  const eventMatch = pathname.match(/^\/api\/events\/([^/]+)$/);
  if (eventMatch) {
    const eventId = eventMatch[1];
    if (request.method === "GET") {
      await requireAuth((req, res, user) => getEvent(req, res, eventId, user))(request, response);
      return;
    }
    if (request.method === "PUT") {
      await requireRole("manager", "admin")(
        (req, res, user) => updateEvent(req, res, eventId, user)
      )(request, response);
      return;
    }
    if (request.method === "DELETE") {
      await requireRole("manager", "admin")(
        (req, res, user) => deleteEvent(req, res, eventId, user)
      )(request, response);
      return;
    }
  }

  if (pathname === "/api/announcements") {
    if (request.method === "GET") {
      await requireAuth(listAnnouncements)(request, response);
      return;
    }
    if (request.method === "POST") {
      await requireRole("manager", "admin")(createAnnouncement)(request, response);
      return;
    }
  }
  const announcementMatch = pathname.match(/^\/api\/announcements\/([^/]+)$/);
  if (announcementMatch) {
    const announcementId = announcementMatch[1];
    if (request.method === "GET") {
      await requireAuth((req, res, user) => getAnnouncement(req, res, announcementId, user))(request, response);
      return;
    }
    if (request.method === "PUT") {
      await requireRole("manager", "admin")(
        (req, res, user) => updateAnnouncement(req, res, announcementId, user)
      )(request, response);
      return;
    }
    if (request.method === "DELETE") {
      await requireRole("manager", "admin")(
        (req, res, user) => deleteAnnouncement(req, res, announcementId, user)
      )(request, response);
      return;
    }
  }

  if (pathname.startsWith("/api/")) {
    sendError(response, 404, "API endpoint not found.");
    return;
  }
  return false;
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendError(response, 405, "Method Not Allowed");
    return;
  }

  let filePath;
  try {
    filePath = getFilePath(request.url);
  } catch {
    sendError(response, 400, "Bad Request");
    return;
  }
  if (!filePath) {
    sendError(response, 400, "Bad Request");
    return;
  }

  const protectedPages = new Set([
    "/create-task.html",
    "/dashboard.html",
    "/team.html",
    "/approvals.html",
    "/events.html",
    "/announcements.html",
    "/workspace.html",
  ]);
  if (protectedPages.has(pathname)) {
    if (!(await authenticate(request))) {
      response.writeHead(302, { Location: "/index.html", "Cache-Control": "no-store" });
      response.end();
      return;
    }
  }

  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Page Not Found");
      return;
    }
    throw error;
  }

  if (!stats.isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Page Not Found");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const fileStream = fs.createReadStream(filePath);
  fileStream.on("error", (error) => {
    console.error("Failed to stream static file:", error);
    if (!response.headersSent) sendError(response, 500, "Unable to read the requested file.");
    else response.destroy(error);
  });
  fileStream.pipe(response);
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, "http://localhost");
  const apiResult = await handleApiRequest(request, response, requestUrl.pathname);
  if (apiResult !== false) return;
  await serveStatic(request, response, requestUrl.pathname);
}

async function startServer() {
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required when NODE_ENV=production.");
  }

  const mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  db = mongoClient.db(mongoDbName);
  organizationsCollection = db.collection("organizations");
  teamsCollection = db.collection("teams");
  usersCollection = db.collection("users");
  tasksCollection = db.collection("tasks");
  eventsCollection = db.collection("events");
  announcementsCollection = db.collection("announcements");

  await removeLegacyGlobalTeamNameIndex();
  await organizationsCollection.createIndex({ id: 1 }, { unique: true });
  await organizationsCollection.createIndex({ inviteCode: 1 }, { unique: true });
  await organizationsCollection.createIndex(
    { isBootstrap: 1 },
    { unique: true, partialFilterExpression: { isBootstrap: true } }
  );
  await organizationsCollection.createIndex(
    { isLegacyWorkspace: 1 },
    { unique: true, partialFilterExpression: { isLegacyWorkspace: true } }
  );
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await usersCollection.createIndex({ id: 1 }, { unique: true });
  await usersCollection.createIndex({ organizationId: 1, name: 1 });
  await teamsCollection.createIndex({ id: 1 }, { unique: true });
  await teamsCollection.createIndex({ organizationId: 1, memberIds: 1 });
  await tasksCollection.createIndex({ id: 1 }, { unique: true });
  await tasksCollection.createIndex({ createdBy: 1 });
  await tasksCollection.createIndex({ organizationId: 1, status: 1, dueDate: 1 });
  await tasksCollection.createIndex({ organizationId: 1, team: 1, status: 1 });
  await tasksCollection.createIndex({ organizationId: 1, teamId: 1, status: 1 });
  await tasksCollection.createIndex({ organizationId: 1, assignee: 1, status: 1 });
  await tasksCollection.createIndex({ organizationId: 1, createdAt: 1 });
  await tasksCollection.createIndex({ status: 1, dueDate: 1 });
  await tasksCollection.createIndex({ team: 1, status: 1 });
  await tasksCollection.createIndex({ assignee: 1, status: 1 });
  await tasksCollection.createIndex({ createdAt: 1 });
  await eventsCollection.createIndex({ id: 1 }, { unique: true });
  await eventsCollection.createIndex({ organizationId: 1, eventDate: 1, startTime: 1 });
  await eventsCollection.createIndex({ organizationId: 1, "checklist.assignedMember": 1 });
  await eventsCollection.createIndex({ eventDate: 1, startTime: 1 });
  await eventsCollection.createIndex({ createdBy: 1 });
  await eventsCollection.createIndex({ "checklist.assignedMember": 1 });
  await announcementsCollection.createIndex({ id: 1 }, { unique: true });
  await announcementsCollection.createIndex({ organizationId: 1, createdAt: -1 });
  await announcementsCollection.createIndex({ organizationId: 1, priority: 1, createdAt: -1 });
  await announcementsCollection.createIndex({ createdAt: -1 });
  await announcementsCollection.createIndex({ priority: 1, createdAt: -1 });
  await migrateLegacyStore();
  await migrateUnassignedRecords();
  await teamsCollection.createIndex({ organizationId: 1, name: 1 }, { unique: true });
  await ensureAllWorkspaceTeams();

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message);
        return;
      }
      console.error("Request failed:", error);
      if (!response.headersSent) sendError(response, 500, "The request could not be completed.");
      else response.destroy(error);
    });
  });

  server.on("close", () => mongoClient.close());
  server.listen(port, () => {
    console.log(`Orbit is running at http://localhost:${port}`);
    console.log(`MongoDB database: ${mongoDbName}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Orbit could not start:", error);
    process.exitCode = 1;
  });
}
