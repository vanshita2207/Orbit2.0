(() => {
  "use strict";

  const feedback = document.querySelector("#workspace-feedback");
  const inviteCode = document.querySelector("#invite-code");
  const teamForm = document.querySelector("#team-form");
  let canRotate = false;
  let canManageTeams = false;
  let canDeleteTeams = false;
  let workspaceMembers = [];
  let workspaceTeams = [];
  let editingTeamId = null;

  function showFeedback(message, isError = false) {
    feedback.textContent = message;
    feedback.classList.toggle("is-visible", Boolean(message));
    feedback.classList.toggle("is-error", isError);
    feedback.setAttribute("role", isError ? "alert" : "status");
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

  function renderMembers(members) {
    const list = document.querySelector("#member-list");
    list.replaceChildren();
    document.querySelector("#member-count").textContent = members.length + " members";
    if (!members.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "This workspace has no members yet.";
      list.append(empty);
      return;
    }
    members.forEach((member) => {
      const item = document.createElement("li");
      item.className = "record-card member-row";
      const identity = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = member.name;
      const role = document.createElement("span");
      role.textContent = "Workspace member";
      identity.append(name, role);
      const badge = document.createElement("span");
      badge.className = "member-role";
      badge.textContent = member.role;
      item.append(identity, badge);
      list.append(item);
    });
  }

  function renderTeamMemberOptions(selectedIds = []) {
    const options = document.querySelector("#team-member-options");
    options.replaceChildren();
    if (!workspaceMembers.length) {
      const empty = document.createElement("p");
      empty.className = "role-note";
      empty.textContent = "Invite workspace members before adding them to a team.";
      options.append(empty);
      return;
    }
    workspaceMembers.forEach((member) => {
      const label = document.createElement("label");
      label.className = "team-member-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "memberIds";
      checkbox.value = member.id;
      checkbox.checked = selectedIds.includes(member.id);
      const name = document.createElement("span");
      name.textContent = member.name;
      label.append(checkbox, name);
      options.append(label);
    });
  }

  function renderTeams() {
    const list = document.querySelector("#team-list");
    list.replaceChildren();
    document.querySelector("#team-count").textContent = workspaceTeams.length + " teams";
    if (!workspaceTeams.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "No teams have been created yet.";
      list.append(empty);
      return;
    }
    workspaceTeams.forEach((team) => {
      const item = document.createElement("li");
      item.className = "record-card";
      const main = document.createElement("div");
      main.className = "record-main";
      const identity = document.createElement("div");
      const name = document.createElement("h3");
      name.textContent = team.name;
      const members = document.createElement("p");
      members.textContent = team.members.length
        ? team.members.map((member) => member.name).join(", ")
        : "No members assigned";
      identity.append(name, members);
      const actions = document.createElement("div");
      actions.className = "record-actions";
      if (canManageTeams) {
        const edit = document.createElement("button");
        edit.className = "button button-secondary";
        edit.type = "button";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => beginTeamEdit(team));
        actions.append(edit);
      }
      if (canDeleteTeams) {
        const remove = document.createElement("button");
        remove.className = "button button-danger";
        remove.type = "button";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => removeTeam(team));
        actions.append(remove);
      }
      main.append(identity, actions);
      item.append(main);
      list.append(item);
    });
  }

  function beginTeamEdit(team) {
    editingTeamId = team.id;
    teamForm.elements.name.value = team.name;
    renderTeamMemberOptions(team.memberIds);
    document.querySelector("#save-team").textContent = "Save team";
    document.querySelector("#cancel-team-edit").hidden = false;
    teamForm.elements.name.focus();
  }

  function resetTeamForm() {
    editingTeamId = null;
    teamForm.reset();
    renderTeamMemberOptions();
    document.querySelector("#save-team").textContent = "Create team";
    document.querySelector("#cancel-team-edit").hidden = true;
  }

  async function loadTeams() {
    const result = await api("/api/teams");
    workspaceTeams = result.teams;
    renderTeams();
  }

  async function removeTeam(team) {
    if (!window.confirm(`Delete the ${team.name} team?`)) return;
    try {
      await api(`/api/teams/${encodeURIComponent(team.id)}`, { method: "DELETE" });
      if (editingTeamId === team.id) resetTeamForm();
      await loadTeams();
      showFeedback(`${team.name} team deleted.`);
    } catch (error) {
      showFeedback(error.message, true);
    }
  }

  async function loadWorkspace() {
    const [workspaceResult, membersResult, session] = await Promise.all([
      api("/api/organizations/me"),
      api("/api/organizations/members"),
      api("/api/auth/session"),
    ]);
    workspaceMembers = membersResult.members;
    document.querySelector("#workspace-name").textContent = workspaceResult.organization.name;
    canRotate = session.user && session.user.role === "admin";
    canManageTeams = session.user && ["admin", "manager"].includes(session.user.role);
    canDeleteTeams = session.user && session.user.role === "admin";
    teamForm.hidden = !canManageTeams;
    document.querySelector("#team-permission-note").textContent = canManageTeams
      ? "Managers and admins can create and edit teams. Only admins can delete them."
      : "Ask a workspace manager or admin to manage teams.";
    renderTeamMemberOptions();
    const canViewInvite = session.user && ["admin", "manager"].includes(session.user.role);
    if (canViewInvite) {
      inviteCode.textContent = workspaceResult.organization.inviteCode;
      document.querySelector("#rotate-invite").hidden = !canRotate;
      document.querySelector("#invite-note").textContent = canRotate
        ? "Only workspace admins can rotate this code. Anyone with the current code can join."
        : "Anyone with the current code can join. Ask an admin to rotate it.";
    } else {
      inviteCode.textContent = "Ask a workspace admin for an invitation code.";
      document.querySelector("#copy-invite").hidden = true;
      document.querySelector("#invite-note").textContent =
        "Invitation codes are visible to admins only.";
    }
    renderMembers(membersResult.members);
    await loadTeams();
  }

  document.querySelector("#copy-invite").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteCode.textContent);
      showFeedback("Invitation code copied.");
    } catch {
      showFeedback("Clipboard access is unavailable. Select and copy the code manually.", true);
    }
  });

  document.querySelector("#rotate-invite").addEventListener("click", async () => {
    if (!canRotate || !window.confirm("Rotate the invitation code? The old code will stop working.")) return;
    const button = document.querySelector("#rotate-invite");
    button.disabled = true;
    try {
      const result = await api("/api/organizations/me/invite-code", { method: "POST" });
      inviteCode.textContent = result.organization.inviteCode;
      showFeedback("Invitation code rotated.");
    } catch (error) {
      showFeedback(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  teamForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canManageTeams || !teamForm.reportValidity()) return;
    const button = document.querySelector("#save-team");
    button.disabled = true;
    const payload = {
      name: teamForm.elements.name.value.trim(),
      memberIds: [...teamForm.querySelectorAll('input[name="memberIds"]:checked')].map((input) => input.value),
    };
    const wasEditing = Boolean(editingTeamId);
    try {
      await api(editingTeamId ? `/api/teams/${encodeURIComponent(editingTeamId)}` : "/api/teams", {
        method: editingTeamId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      resetTeamForm();
      await loadTeams();
      showFeedback(wasEditing ? "Team updated." : "Team created.");
    } catch (error) {
      showFeedback(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#cancel-team-edit").addEventListener("click", resetTeamForm);
  loadWorkspace().catch((error) => showFeedback(error.message || "Could not load workspace details.", true));
})();
