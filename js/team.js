"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  user: null,
  team: null,
  teams: [],
  members: [],
  workspaceMembers: [],
  tasks: [],
  events: [],
  currentEvent: null,
  checklist: [],
  activeFilter: "all",
  memberSearch: "",
  memberSort: "name",
  taskSort: "deadline",
  performerSort: "desc",
  toastTimer: null,
};

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
  });
  const result = await response.json();
  if (response.status === 401) {
    window.location.replace("index.html");
    throw new Error("Your session has expired.");
  }
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

async function fetchAllPages(path) {
  const rows = [];
  let page = 1;
  let pages = 1;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const result = await api(`${path}${separator}page=${page}&limit=100`);
    const key = path.startsWith("/api/tasks") ? "tasks" : "members";
    rows.push(...(result[key] || []));
    pages = result.pagination ? result.pagination.pages : 1;
    page += 1;
  } while (page <= pages);
  return rows;
}

function initials(name = "") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0].toUpperCase()).join("");
}

function avatarMarkup(name) {
  return `<span class="avatar">${escapeHTML(initials(name))}</span>`;
}

function displayDate(value) {
  if (!value) return "No date";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? "No date"
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function shortDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function taskProgress(task) {
  const progressByStatus = {
    Assigned: 0,
    "In Progress": 50,
    "Pending review": 85,
    Completed: 100,
    "Changes requested": 40,
    Rejected: 0,
  };
  return progressByStatus[task.status] || 0;
}

function selectedTeamId() {
  return new URLSearchParams(window.location.search).get("team");
}

async function initialize() {
  const session = await api("/api/auth/session");
  if (!session.user) {
    window.location.replace("index.html");
    return;
  }
  state.user = session.user;
  const [teamsResult, workspaceResult] = await Promise.all([
    api("/api/teams"),
    api("/api/organizations/members"),
  ]);
  state.teams = teamsResult.teams;
  state.workspaceMembers = workspaceResult.members;
  const queryTeamId = selectedTeamId();
  state.team = state.teams.find((team) => team.id === queryTeamId) || state.teams[0] || null;
  renderTeamSelector();
  if (!state.team) {
    renderEmptyTeamState();
    return;
  }
  await loadTeamData();
}

function renderTeamSelector() {
  const select = $("#teamSelect");
  select.replaceChildren();
  state.teams.forEach((team) => select.add(new Option(team.name, team.id)));
  if (state.team) select.value = state.team.id;
  select.addEventListener("change", async () => {
    const nextTeam = state.teams.find((team) => team.id === select.value);
    if (!nextTeam) return;
    state.team = nextTeam;
    state.activeFilter = "all";
    const url = new URL(window.location.href);
    url.searchParams.set("team", nextTeam.id);
    window.history.replaceState(null, "", url);
    await loadTeamData();
  });
}

function renderEmptyTeamState() {
  $("#teamName").textContent = "No teams yet";
  $("#breadcrumbTeam").textContent = "No teams";
  $("#teamDescription").textContent = "Create a workspace team to organize people and tasks.";
  $("#headName").textContent = "No members assigned";
  $("#lastUpdated").textContent = "—";
  $("#memberList").innerHTML = '<div class="empty-state">Create a team from Workspace settings.</div>';
  $("#taskGrid").innerHTML = '<div class="empty-state">Tasks will appear here after a team is created.</div>';
  $("#priorityEvents").innerHTML = '<div class="empty-state">No team selected.</div>';
  $("#checklist").innerHTML = '<div class="empty-state">Select a team to view event checklists.</div>';
}

async function loadTeamData() {
  if (!state.team) return;
  const teamId = encodeURIComponent(state.team.id);
  const [statsResult, memberRows, topPerformers, tasks, events] = await Promise.all([
    api(`/api/dashboard/team-performance?team=${teamId}`),
    fetchAllPages(`/api/dashboard/member-performance?team=${teamId}`),
    fetchAllPages(`/api/dashboard/top-performers?team=${teamId}`),
    fetchAllPages(`/api/tasks?team=${teamId}`),
    api("/api/events?status=upcoming&limit=100"),
  ]);
  state.teamStats = statsResult.teams[0] || null;
  state.members = memberRows;
  state.topPerformers = topPerformers;
  state.tasks = tasks;
  state.events = events.events || [];
  if (!state.currentEvent || !state.events.some((event) => event.id === state.currentEvent.id)) {
    state.currentEvent = state.events[0] || null;
  }
  state.checklist = [];
  if (state.currentEvent) {
    const checklistResult = await api(`/api/events/${encodeURIComponent(state.currentEvent.id)}/checklist`);
    state.checklist = checklistResult.checklist || [];
  }
  renderAll();
}

function renderAll() {
  renderHeader();
  renderSummary();
  renderMembers();
  renderEvents();
  renderChecklist();
  renderTasks();
  renderActivity();
  renderPriorityTasks();
  renderTopPerformers();
}

function renderHeader() {
  const heading = $("#teamName");
  heading.replaceChildren(document.createTextNode(state.team.name));
  const dot = document.createElement("span");
  dot.textContent = ".";
  heading.append(dot);
  $("#breadcrumbTeam").textContent = state.team.name;
  $("#teamDescription").textContent = "Workspace team · " + (state.team.memberCount || 0) + " assigned members.";
  const firstMember = state.team.members && state.team.members[0];
  $("#headName").textContent = firstMember ? firstMember.name : "No members assigned";
  $("#lastUpdated").textContent = shortDateTime(state.team.updatedAt || state.team.createdAt);
}

function renderSummary() {
  const members = state.members || [];
  const activeMembers = members.filter((member) => member.totalTasks > member.completedTasks).length;
  const activeTasks = state.tasks.filter((task) => task.status !== "Completed").length;
  $("#totalMembers").textContent = String(state.teamStats ? state.teamStats.memberCount : state.team.memberCount || 0);
  $("#activeMembers").textContent = String(activeMembers);
  $("#activeTasks").textContent = String(activeTasks);
  $("#memberCount").textContent = String(members.length);
  $("#allTaskCount").textContent = String(state.tasks.length);
}

function renderMembers() {
  let members = state.members.filter((member) =>
    `${member.memberName} ${member.teamNames.join(" ")}`.toLowerCase().includes(state.memberSearch)
  );
  if (state.memberSort === "progress") {
    members.sort((left, right) => right.completionPercentage - left.completionPercentage);
  } else if (state.memberSort === "activity") {
    members.sort((left, right) => right.totalTasks - left.totalTasks);
  } else {
    members.sort((left, right) => left.memberName.localeCompare(right.memberName));
  }
  const memberById = new Map(state.workspaceMembers.map((member) => [member.id, member]));
  $("#memberList").innerHTML = members.length ? members.map((member) => {
    const account = memberById.get(member.memberId);
    const progress = member.completionPercentage || 0;
    return `
      <article class="member-card">
        <div class="member-identity">
          ${avatarMarkup(member.memberName)}
          <div>
            <div class="member-name">${escapeHTML(member.memberName)}</div>
            <div class="member-role">${escapeHTML(account ? account.role : "Workspace member")} · ${member.totalTasks} tasks</div>
          </div>
        </div>
        <div class="member-skills">
          <div class="member-label">TEAMS</div>
          <div class="skills">${(member.teamNames.length ? member.teamNames : [state.team.name])
            .map((name) => `<span class="skill">${escapeHTML(name)}</span>`).join("")}</div>
        </div>
        <div class="member-progress">
          <div class="progress-label"><span>Completed tasks</span><strong>${progress}%</strong></div>
          <div class="progress-track"><span style="width:${progress}%"></span></div>
        </div>
        <div class="member-extra">
          <div class="extra-item"><small>Contribution points</small><strong>${member.contributionPoints || 0}</strong></div>
          <div class="extra-item"><small>Tasks completed</small><strong>${member.completedTasks}</strong></div>
          <div class="extra-item"><small>Overdue tasks</small><strong>${member.overdueTasks}</strong></div>
        </div>
      </article>
    `;
  }).join("") : '<div class="empty-state">No members or task assignees are assigned to this team yet.</div>';
}

function renderEvents() {
  const container = $("#priorityEvents");
  container.innerHTML = state.events.length ? state.events.slice(0, 4).map((event) => `
    <button class="event-row ${state.currentEvent && event.id === state.currentEvent.id ? "is-selected" : ""}"
            type="button" data-event="${escapeHTML(event.id)}">
      <span class="event-date">${escapeHTML(displayDate(event.eventDate))}</span>
      <span class="event-copy">
        <strong>${escapeHTML(event.title)}</strong>
        <small>${escapeHTML(event.startTime || "Time not set")} · ${escapeHTML(event.location || "Location not set")}</small>
      </span>
      <span class="event-priority">EVENT</span>
    </button>
  `).join("") : '<div class="empty-state">No upcoming workspace events.</div>';
}

async function selectEvent(eventId) {
  state.currentEvent = state.events.find((event) => event.id === eventId) || null;
  state.checklist = [];
  if (state.currentEvent) {
    const result = await api(`/api/events/${encodeURIComponent(eventId)}/checklist`);
    state.checklist = result.checklist || [];
  }
  renderEvents();
  renderChecklist();
}

function renderChecklist() {
  const items = state.checklist;
  const completed = items.filter((item) => item.completed).length;
  const percent = items.length ? Math.round((completed / items.length) * 100) : 0;
  $("#checklistPercent").textContent = percent + "%";
  $("#checklistBar").style.width = percent + "%";
  const canManage = ["admin", "manager"].includes(state.user.role);
  $("#addChecklistBtn").hidden = !canManage;
  $("#addChecklistBtn").disabled = !state.currentEvent;
  $("#checklist").innerHTML = items.length ? items.map((item) => `
    <div class="checklist-item ${item.completed ? "done" : ""}" data-check="${escapeHTML(item.id)}">
      <button class="checklist-check ${item.completed ? "checked" : ""}" type="button"
              aria-label="${item.completed ? "Mark incomplete" : "Mark complete"}" aria-pressed="${item.completed}">✓</button>
      <div>
        <strong>${escapeHTML(item.title)}</strong>
        <small>${escapeHTML(item.description || (item.completed ? "Completed" : "Pending"))}</small>
      </div>
      ${canManage ? '<button class="delete-check" type="button" aria-label="Delete checklist item">×</button>' : ""}
    </div>
  `).join("") : `<div class="empty-state">${state.currentEvent
    ? "No checklist items for " + escapeHTML(state.currentEvent.title) + "."
    : "Select an upcoming event to view its checklist."}</div>`;
}

function renderTasks() {
  const filtered = state.tasks.filter((task) =>
    state.activeFilter === "all" || task.status === state.activeFilter
  );
  const priorityRank = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  filtered.sort((left, right) => {
    if (state.taskSort === "priority") return priorityRank[left.priority] - priorityRank[right.priority];
    if (state.taskSort === "progress") return taskProgress(right) - taskProgress(left);
    return (left.dueDate || "").localeCompare(right.dueDate || "");
  });
  $$("#statusFilters [data-status]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.status === state.activeFilter);
    const count = button.dataset.status === "all"
      ? state.tasks.length
      : state.tasks.filter((task) => task.status === button.dataset.status).length;
    const value = button.querySelector("span");
    if (value) value.textContent = String(count);
  });
  $("#taskGrid").innerHTML = filtered.length ? filtered.map((task) => {
    const progress = taskProgress(task);
    const priority = String(task.priority || "Medium").toLowerCase();
    const overdue = task.status !== "Completed" && task.dueDate < new Date().toISOString().slice(0, 10);
    const statusControl = task.canUpdateStatus
      ? `<label class="progress-input">Status
          <select class="task-status-input" aria-label="Update status for ${escapeHTML(task.title)}">
            ${["Assigned", "In Progress", "Pending review", "Completed", "Changes requested", "Rejected"]
              .map((status) => `<option value="${status}" ${status === task.status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </label>`
      : `<span class="task-status">${escapeHTML(task.status)}</span>`;
    return `
      <article class="task-card" data-task="${escapeHTML(task.id)}">
        <div class="task-card-top">
          <span class="priority-label ${escapeHTML(priority)}">${escapeHTML(task.priority)} priority</span>
          <span class="task-status">${escapeHTML(task.status)}</span>
        </div>
        <h3>${escapeHTML(task.title)}</h3>
        <p class="task-description">${escapeHTML(task.description || "No description added.")}</p>
        <div class="task-progress-row">
          <div class="donut" style="--progress:${progress}"><strong>${progress}%</strong></div>
          <div class="task-progress-details">
            <div class="progress-label"><span>Task completion</span><strong>${progress}%</strong></div>
            <div class="progress-track"><span style="width:${progress}%"></span></div>
          </div>
        </div>
        <div class="task-card-bottom">
          <div class="task-assignee">${avatarMarkup(task.assignee)}
            <div><strong>${escapeHTML(task.assignee)}</strong><small>Task owner</small></div>
          </div>
          <div class="task-deadline ${overdue ? "overdue" : ""}">${overdue ? "Overdue · " : "Due "}${escapeHTML(displayDate(task.dueDate))}</div>
        </div>
        <div class="task-controls">${statusControl}</div>
      </article>
    `;
  }).join("") : '<div class="empty-state">No tasks found for this filter.</div>';
}

function renderActivity() {
  const recent = [...state.tasks]
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
    .slice(0, 5);
  $("#activityList").innerHTML = recent.length ? recent.map((task) => `
    <div class="activity-item">
      <span class="activity-icon">＋</span>
      <div class="activity-copy">
        <p><strong>${escapeHTML(task.assignee)}</strong> was assigned “${escapeHTML(task.title)}”</p>
        <small>${escapeHTML(state.team.name)} · ${escapeHTML(task.status)}</small>
      </div>
      <span class="activity-time">${escapeHTML(displayDate(task.createdAt && task.createdAt.slice(0, 10)))}</span>
    </div>
  `).join("") : '<div class="empty-state">No task activity yet.</div>';
}

function renderPriorityTasks() {
  const tasks = state.tasks.filter((task) => task.status !== "Completed")
    .sort((left, right) => {
      const priorityRank = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
      return priorityRank[left.priority] - priorityRank[right.priority] ||
        (left.dueDate || "").localeCompare(right.dueDate || "");
    }).slice(0, 4);
  $("#priorityTaskList").innerHTML = tasks.length ? tasks.map((task) => `
    <div class="priority-task">
      <div class="priority-task-top">
        <span class="priority-label ${escapeHTML(String(task.priority).toLowerCase())}">${escapeHTML(task.priority)} priority</span>
        <small>${escapeHTML(displayDate(task.dueDate))}</small>
      </div>
      <strong>${escapeHTML(task.title)}</strong>
      <small>${escapeHTML(task.assignee)}</small>
      <div class="progress-track"><span style="width:${taskProgress(task)}%"></span></div>
    </div>
  `).join("") : '<div class="empty-state">No open tasks need attention.</div>';
}

function renderTopPerformers() {
  const members = [...(state.topPerformers || [])].sort((left, right) =>
    state.performerSort === "asc"
      ? left.contributionPoints - right.contributionPoints
      : right.contributionPoints - left.contributionPoints
  );
  const maxPoints = Math.max(1, ...members.map((member) => member.contributionPoints || 0));
  $("#topPerformers").innerHTML = members.length ? members.map((member, index) => `
    <article class="performer-row">
      <span class="performer-rank" aria-label="Rank ${index + 1}">${index + 1}</span>
      ${avatarMarkup(member.memberName)}
      <div class="performer-details">
        <div class="performer-name">${escapeHTML(member.memberName)}</div>
        <div class="performer-role">${member.completedTasks} completed · ${member.completionPercentage}%</div>
        <div class="performer-points-track" aria-hidden="true">
          <span style="width:${(member.contributionPoints || 0) / maxPoints * 100}%"></span>
        </div>
      </div>
      <strong class="performer-points">${member.contributionPoints || 0}<small> pts</small></strong>
    </article>
  `).join("") : '<div class="empty-state">No team contributions to rank yet.</div>';
  const total = state.teamStats ? state.teamStats.totalTasks : 0;
  const completed = state.teamStats ? state.teamStats.completedTasks : 0;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  $("#overallProgress").textContent = progress + "%";
  $("#overallProgressBar").style.width = progress + "%";
}

function populateAssignees() {
  const select = $("#taskAssignee");
  select.replaceChildren();
  select.add(new Option("Select a workspace member", ""));
  state.workspaceMembers.forEach((member) => select.add(new Option(member.name, member.id)));
}

function openTaskDialog() {
  if (!state.workspaceMembers.length) {
    showToast("Invite a workspace member before assigning a task.");
    return;
  }
  $("#taskForm").reset();
  populateAssignees();
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 7);
  $("#taskDeadline").min = new Date().toISOString().slice(0, 10);
  $("#taskDeadline").value = [
    deadline.getFullYear(),
    String(deadline.getMonth() + 1).padStart(2, "0"),
    String(deadline.getDate()).padStart(2, "0"),
  ].join("-");
  $("#taskDialog").showModal();
}

async function submitTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const body = Object.fromEntries(new FormData(form).entries());
  body.team = state.team.id;
  body.assigneeId = body.assignee;
  delete body.assignee;
  body.contributionPoints = Number(body.contributionPoints);
  try {
    const result = await api("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    $("#taskDialog").close();
    await loadTeamData();
    showToast(`Task assigned to ${result.task.assignee}.`);
  } catch (error) {
    showToast(error.message || "The task could not be created.");
  }
}

async function updateTaskStatus(taskId, status) {
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadTeamData();
    showToast("Task status updated.");
  } catch (error) {
    showToast(error.message || "Task status could not be updated.");
  }
}

async function updateChecklistItem(itemId, changes) {
  if (!state.currentEvent) return;
  try {
    await api(`/api/events/${encodeURIComponent(state.currentEvent.id)}/checklist/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    const result = await api(`/api/events/${encodeURIComponent(state.currentEvent.id)}/checklist`);
    state.checklist = result.checklist || [];
    renderChecklist();
    showToast("Checklist updated.");
  } catch (error) {
    showToast(error.message || "Checklist could not be updated.");
  }
}

async function submitChecklistItem(event) {
  event.preventDefault();
  if (!state.currentEvent) return;
  const title = String(new FormData(event.currentTarget).get("text") || "").trim();
  if (!title) return;
  try {
    await api(`/api/events/${encodeURIComponent(state.currentEvent.id)}/checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    $("#checklistDialog").close();
    const result = await api(`/api/events/${encodeURIComponent(state.currentEvent.id)}/checklist`);
    state.checklist = result.checklist || [];
    renderChecklist();
    showToast("Checklist item added.");
  } catch (error) {
    showToast(error.message || "Checklist item could not be added.");
  }
}

$("#memberSearch").addEventListener("input", (event) => {
  state.memberSearch = event.target.value.trim().toLowerCase();
  renderMembers();
});
$("#memberSort").addEventListener("change", (event) => {
  state.memberSort = event.target.value;
  renderMembers();
});
$("#taskSort").addEventListener("change", (event) => {
  state.taskSort = event.target.value;
  renderTasks();
});
$("#performerSort").addEventListener("change", (event) => {
  state.performerSort = event.target.value;
  renderTopPerformers();
});
$("#statusFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-status]");
  if (!button) return;
  state.activeFilter = button.dataset.status;
  renderTasks();
});
$("#taskGrid").addEventListener("change", (event) => {
  const control = event.target.closest(".task-status-input");
  const task = event.target.closest("[data-task]");
  if (control && task) updateTaskStatus(task.dataset.task, control.value);
});
$("#priorityEvents").addEventListener("click", (event) => {
  const row = event.target.closest("[data-event]");
  if (row) selectEvent(row.dataset.event).catch((error) => showToast(error.message));
});
$("#checklist").addEventListener("click", (event) => {
  const row = event.target.closest("[data-check]");
  if (!row) return;
  const item = state.checklist.find((entry) => entry.id === row.dataset.check);
  if (!item) return;
  if (event.target.closest(".delete-check")) {
    api(`/api/events/${encodeURIComponent(state.currentEvent.id)}/checklist/${encodeURIComponent(item.id)}`, {
      method: "DELETE",
    }).then(async () => {
      const result = await api(`/api/events/${encodeURIComponent(state.currentEvent.id)}/checklist`);
      state.checklist = result.checklist || [];
      renderChecklist();
      showToast("Checklist item deleted.");
    }).catch((error) => showToast(error.message));
    return;
  }
  if (event.target.closest(".checklist-check")) {
    updateChecklistItem(item.id, { completed: !item.completed });
  }
});
$("#addTaskBtn").addEventListener("click", openTaskDialog);
$("#taskForm").addEventListener("submit", submitTask);
$("#addChecklistBtn").addEventListener("click", () => {
  if (!state.currentEvent) {
    showToast("Select an upcoming event first.");
    return;
  }
  $("#checklistForm").reset();
  $("#checklistDialog").showModal();
});
$("#checklistForm").addEventListener("submit", submitChecklistItem);
$("#createTeamBtn").addEventListener("click", () => window.location.assign("workspace.html"));
$$("[data-close]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.close);
    if (dialog) dialog.close();
  });
});

initialize().catch((error) => {
  showToast(error.message || "Could not load team details.");
  $("#teamList")?.replaceChildren();
});
