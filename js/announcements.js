(() => {
  "use strict";

  const form = document.querySelector("#announcement-form");
  const list = document.querySelector("#announcement-list");
  const feedback = document.querySelector("#announcement-feedback");
  const priorityFilter = document.querySelector("#priority-filter");
  const pageLabel = document.querySelector("#page-label");
  const previousButton = document.querySelector("#previous-page");
  const nextButton = document.querySelector("#next-page");
  const pageSize = 10;
  let currentUser = null;
  let page = 1;
  let total = 0;
  let editingId = null;

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
      headers: options.body
        ? { "Content-Type": "application/json", ...(options.headers || {}) }
        : options.headers,
    });
    const result = await response.json();
    if (response.status === 401) {
      window.location.replace("index.html");
      throw new Error("Your session has expired.");
    }
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
  }

  function canManage() {
    return currentUser && ["admin", "manager"].includes(currentUser.role);
  }

  function resetForm() {
    editingId = null;
    form.reset();
    document.querySelector("#announcement-form-heading").textContent = "Create announcement";
    form.querySelector('button[type="submit"]').textContent = "Publish announcement";
    document.querySelector("#cancel-announcement-edit").hidden = true;
  }

  function startEdit(announcement) {
    editingId = announcement.id;
    form.elements.namedItem("title").value = announcement.title;
    form.elements.namedItem("priority").value = announcement.priority;
    form.elements.namedItem("message").value = announcement.message;
    document.querySelector("#announcement-form-heading").textContent = "Edit announcement";
    form.querySelector('button[type="submit"]').textContent = "Save changes";
    document.querySelector("#cancel-announcement-edit").hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function removeAnnouncement(announcement) {
    if (!window.confirm("Delete “" + announcement.title + "”?")) return;
    try {
      await api("/api/announcements/" + encodeURIComponent(announcement.id), { method: "DELETE" });
      showFeedback("Announcement deleted.");
      await loadAnnouncements();
    } catch (error) {
      showFeedback(error.message, true);
    }
  }

  function renderAnnouncements(items) {
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "No announcements found.";
      list.append(empty);
      return;
    }
    items.forEach((announcement) => {
      const item = document.createElement("li");
      item.className = "announcement-card";
      const header = document.createElement("div");
      header.className = "record-main";
      const content = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = announcement.title;
      const priority = document.createElement("span");
      priority.className = "priority-badge priority-" + announcement.priority.toLowerCase();
      priority.textContent = announcement.priority;
      content.append(title, priority);
      header.append(content);
      if (canManage()) {
        const actions = document.createElement("div");
        actions.className = "record-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "button button-secondary";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => startEdit(announcement));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button button-danger";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => removeAnnouncement(announcement));
        actions.append(edit, remove);
        header.append(actions);
      }
      const message = document.createElement("p");
      message.textContent = announcement.message;
      const meta = document.createElement("span");
      meta.className = "record-meta";
      meta.textContent = "Posted " + new Date(announcement.createdAt).toLocaleString();
      item.append(header, message, meta);
      list.append(item);
    });
  }

  async function loadAnnouncements() {
    const query = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    if (priorityFilter.value) query.set("priority", priorityFilter.value);
    const result = await api("/api/announcements?" + query.toString());
    total = result.pagination.total;
    pageLabel.textContent = "Page " + page + " of " + Math.max(1, result.pagination.pages);
    previousButton.disabled = page <= 1;
    nextButton.disabled = page >= result.pagination.pages;
    renderAnnouncements(result.announcements);
  }

  async function submitForm(event) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      await api(
        editingId ? "/api/announcements/" + encodeURIComponent(editingId) : "/api/announcements",
        { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) }
      );
      showFeedback(editingId ? "Announcement updated." : "Announcement published.");
      resetForm();
      page = 1;
      await loadAnnouncements();
    } catch (error) {
      showFeedback(error.message, true);
    }
  }

  async function initialize() {
    try {
      const session = await api("/api/auth/session");
      currentUser = session.user;
      if (!currentUser) {
        window.location.replace("index.html");
        return;
      }
      if (!canManage()) document.querySelector("#announcement-form-card").hidden = true;
      form.addEventListener("submit", submitForm);
      document.querySelector("#cancel-announcement-edit").addEventListener("click", resetForm);
      priorityFilter.addEventListener("change", () => {
        page = 1;
        loadAnnouncements().catch((error) => showFeedback(error.message, true));
      });
      previousButton.addEventListener("click", () => {
        if (page > 1) {
          page -= 1;
          loadAnnouncements().catch((error) => showFeedback(error.message, true));
        }
      });
      nextButton.addEventListener("click", () => {
        if (page * pageSize < total) {
          page += 1;
          loadAnnouncements().catch((error) => showFeedback(error.message, true));
        }
      });
      await loadAnnouncements();
    } catch (error) {
      showFeedback(error.message || "Could not load announcements.", true);
    }
  }

  void initialize();
})();
