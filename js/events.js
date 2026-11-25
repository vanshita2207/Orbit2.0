(() => {
  "use strict";

  const eventForm = document.querySelector("#event-form");
  const eventList = document.querySelector("#event-list");
  const checklistForm = document.querySelector("#checklist-form");
  const checklistList = document.querySelector("#checklist-list");
  const feedback = document.querySelector("#event-feedback");
  const eventFilter = document.querySelector("#event-filter");
  let currentUser = null;
  let members = [];
  let events = [];
  let selectedEvent = null;
  let editingEventId = null;
  let editingItemId = null;

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

  function isManager() {
    return currentUser && ["admin", "manager"].includes(currentUser.role);
  }

  function formatDate(value) {
    const date = new Date(value + "T00:00:00");
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date);
  }

  function resetEventForm() {
    editingEventId = null;
    eventForm.reset();
    document.querySelector("#event-form-heading").textContent = "Create event";
    eventForm.querySelector('button[type="submit"]').textContent = "Create event";
    document.querySelector("#cancel-event-edit").hidden = true;
  }

  function selectEvent(event) {
    selectedEvent = event;
    document.querySelector("#selected-event-label").textContent =
      event.title + " · " + formatDate(event.eventDate);
    document.querySelector("#checklist-heading").textContent = "Event checklist";
    checklistForm.hidden = !isManager();
    resetItemForm();
    renderChecklist();
    renderEvents();
  }

  function renderEvents() {
    eventList.replaceChildren();
    if (!events.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "No events found.";
      eventList.append(empty);
      return;
    }

    events.forEach((event) => {
      const row = document.createElement("li");
      row.className = "record-card" + (selectedEvent && selectedEvent.id === event.id ? " is-selected" : "");
      const main = document.createElement("div");
      main.className = "record-main";
      const info = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = event.title;
      const date = document.createElement("p");
      date.textContent = [formatDate(event.eventDate), event.location].filter(Boolean).join(" · ");
      const description = document.createElement("p");
      description.textContent = event.description || "";
      const checklistCount = document.createElement("span");
      checklistCount.className = "record-meta";
      checklistCount.textContent = event.completedChecklistItems + " / " +
        (event.completedChecklistItems + event.pendingChecklistItems) + " checklist items complete";
      info.append(title, date, description, checklistCount);
      main.append(info);
      row.append(main);

      const actions = document.createElement("div");
      actions.className = "record-actions";
      const select = document.createElement("button");
      select.type = "button";
      select.className = "button button-secondary";
      select.textContent = "Checklist";
      select.addEventListener("click", () => selectEvent(event));
      actions.append(select);
      if (isManager()) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "button button-secondary";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => editEvent(event));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button button-danger";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteEvent(event));
        actions.append(edit, remove);
      }
      row.append(actions);
      eventList.append(row);
    });
  }

  function editEvent(event) {
    editingEventId = event.id;
    for (const [key, value] of Object.entries(event)) {
      const input = eventForm.elements.namedItem(key);
      if (input) input.value = value || "";
    }
    document.querySelector("#event-form-heading").textContent = "Edit event";
    eventForm.querySelector('button[type="submit"]').textContent = "Save changes";
    document.querySelector("#cancel-event-edit").hidden = false;
    eventForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deleteEvent(event) {
    if (!window.confirm("Delete “" + event.title + "” and its checklist?")) return;
    try {
      await api("/api/events/" + encodeURIComponent(event.id), { method: "DELETE" });
      if (selectedEvent && selectedEvent.id === event.id) {
        selectedEvent = null;
        checklistForm.hidden = true;
        checklistList.replaceChildren();
        document.querySelector("#selected-event-label").textContent = "Select an event to manage its checklist.";
      }
      showFeedback("Event deleted.");
      await loadEvents();
    } catch (error) {
      showFeedback(error.message, true);
    }
  }

  async function loadEvents() {
    const status = eventFilter.value;
    const query = status ? "?status=" + encodeURIComponent(status) + "&limit=100" : "?limit=100";
    const result = await api("/api/events" + query);
    events = result.events;
    if (selectedEvent) {
      selectedEvent = events.find((event) => event.id === selectedEvent.id) || null;
    }
    if (selectedEvent) {
      selectEvent(selectedEvent);
    } else {
      renderEvents();
      if (!checklistForm.hidden) checklistForm.hidden = true;
      if (!events.length) {
        checklistList.replaceChildren();
        const empty = document.createElement("li");
        empty.className = "empty-state";
        empty.textContent = "No event selected.";
        checklistList.append(empty);
      }
    }
  }

  function resetItemForm() {
    editingItemId = null;
    checklistForm.reset();
    document.querySelector("#checklist-form-heading").textContent = "Add checklist item";
    checklistForm.querySelector('button[type="submit"]').textContent = "Add item";
    document.querySelector("#cancel-item-edit").hidden = true;
  }

  function editChecklistItem(item) {
    editingItemId = item.id;
    checklistForm.elements.namedItem("title").value = item.title;
    checklistForm.elements.namedItem("description").value = item.description || "";
    checklistForm.elements.namedItem("assignedMember").value = item.assignedMember || "";
    document.querySelector("#checklist-form-heading").textContent = "Edit checklist item";
    checklistForm.querySelector('button[type="submit"]').textContent = "Save item";
    document.querySelector("#cancel-item-edit").hidden = false;
    checklistForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderChecklist() {
    checklistList.replaceChildren();
    if (!selectedEvent || !selectedEvent.checklist.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = selectedEvent ? "No checklist items yet." : "No event selected.";
      checklistList.append(empty);
      return;
    }

    selectedEvent.checklist.forEach((entry) => {
      const row = document.createElement("li");
      row.className = "checklist-entry" + (entry.completed ? " is-done" : "");
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = entry.completed;
      checkbox.disabled = !isManager() && entry.assignedMember !== currentUser.id;
      checkbox.addEventListener("change", () => toggleChecklistItem(entry, checkbox));
      const copy = document.createElement("span");
      copy.className = "checklist-copy";
      copy.append(document.createTextNode(entry.title));
      const details = document.createElement("small");
      const assigned = members.find((member) => member.id === entry.assignedMember);
      details.textContent = [
        entry.description,
        assigned ? "Assigned to " + assigned.name : "Unassigned",
        entry.completedAt ? "Completed " + new Date(entry.completedAt).toLocaleString() : "",
      ].filter(Boolean).join(" · ");
      copy.append(details);
      label.append(checkbox, copy);
      row.append(label);
      if (isManager()) {
        const actions = document.createElement("div");
        actions.className = "record-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "button button-secondary";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => editChecklistItem(entry));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button button-danger";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => removeChecklistItem(entry));
        actions.append(edit, remove);
        row.append(actions);
      }
      checklistList.append(row);
    });
  }

  async function toggleChecklistItem(entry, checkbox) {
    checkbox.disabled = true;
    try {
      const result = await api(
        "/api/events/" + encodeURIComponent(selectedEvent.id) + "/checklist/" + encodeURIComponent(entry.id),
        { method: "PATCH", body: JSON.stringify({ completed: checkbox.checked }) }
      );
      selectedEvent.checklist = selectedEvent.checklist.map((item) => item.id === entry.id ? result.item : item);
      showFeedback("Checklist updated.");
      renderChecklist();
      await loadEvents();
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      checkbox.disabled = false;
      showFeedback(error.message, true);
    }
  }

  async function removeChecklistItem(entry) {
    try {
      await api(
        "/api/events/" + encodeURIComponent(selectedEvent.id) + "/checklist/" + encodeURIComponent(entry.id),
        { method: "DELETE" }
      );
      selectedEvent.checklist = selectedEvent.checklist.filter((item) => item.id !== entry.id);
      resetItemForm();
      showFeedback("Checklist item removed.");
      renderChecklist();
      await loadEvents();
    } catch (error) {
      showFeedback(error.message, true);
    }
  }

  async function submitEvent(event) {
    event.preventDefault();
    if (!eventForm.reportValidity()) return;
    const payload = Object.fromEntries(new FormData(eventForm).entries());
    try {
      const result = await api(
        editingEventId ? "/api/events/" + encodeURIComponent(editingEventId) : "/api/events",
        { method: editingEventId ? "PUT" : "POST", body: JSON.stringify(payload) }
      );
      const eventRecord = result.event;
      showFeedback(editingEventId ? "Event updated." : "Event created.");
      resetEventForm();
      await loadEvents();
      const matchingEvent = events.find((item) => item.id === eventRecord.id);
      if (matchingEvent) selectEvent(matchingEvent);
    } catch (error) {
      showFeedback(error.message, true);
    }
  }

  async function submitChecklistItem(event) {
    event.preventDefault();
    if (!selectedEvent || !checklistForm.reportValidity()) return;
    const payload = Object.fromEntries(new FormData(checklistForm).entries());
    if (!payload.assignedMember) payload.assignedMember = null;
    const url = "/api/events/" + encodeURIComponent(selectedEvent.id) + "/checklist" +
      (editingItemId ? "/" + encodeURIComponent(editingItemId) : "");
    try {
      await api(url, {
        method: editingItemId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      showFeedback(editingItemId ? "Checklist item updated." : "Checklist item added.");
      resetItemForm();
      await loadEvents();
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
      const directory = await api("/api/organizations/members");
      members = directory.members;
      for (const member of members) {
        document.querySelector("#checklist-assignee").add(new Option(member.name, member.id));
      }
      if (!isManager()) document.querySelector("#event-form-card").hidden = true;
      eventForm.addEventListener("submit", submitEvent);
      checklistForm.addEventListener("submit", submitChecklistItem);
      eventFilter.addEventListener("change", () => loadEvents().catch((error) => showFeedback(error.message, true)));
      document.querySelector("#new-event-button").addEventListener("click", () => {
        resetEventForm();
        eventForm.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      document.querySelector("#cancel-event-edit").addEventListener("click", resetEventForm);
      document.querySelector("#cancel-item-edit").addEventListener("click", resetItemForm);
      await loadEvents();
    } catch (error) {
      showFeedback(error.message || "Could not load events.", true);
    }
  }

  void initialize();
})();
