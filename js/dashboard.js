(function () {
  "use strict";

  /* ── Greeting based on time of day ── */
  function setGreeting() {
    const hour = new Date().getHours();
    const greetingEl = document.getElementById("greeting-time");
    if (!greetingEl) return;

    let greeting = "Good evening";
    if (hour < 12) greeting = "Good morning";
    else if (hour < 17) greeting = "Good afternoon";

    greetingEl.textContent = greeting;
  }

  /* ── Load the signed-in user from the local server ── */
  async function setUserName() {
    const nameEl = document.getElementById("user-name");
    if (!nameEl) return;

    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin" });
      const result = await response.json();

      if (!response.ok || !result.user) {
        window.location.replace("index.html");
        return;
      }

      currentUser = result.user;
      nameEl.textContent = result.user.name || "Member";
      const workspace = await apiRequest("/api/organizations/me");
      const workspaceName = document.getElementById("workspace-name");
      if (workspaceName) workspaceName.textContent = workspace.organization.name;
      if (currentEvent) renderEventChecklist(currentEvent);
    } catch {
      window.location.replace("index.html");
    }
  }

  /* ── Organisation overview ── */
  const emptyPeriod = {
    totals: { total: 0, completed: 0, inProgress: 0, review: 0, overdue: 0 },
    daily: {
      labels: ["--", "--", "--", "--", "--", "--", "--"],
      total: [0, 0, 0, 0, 0, 0, 0],
      completed: [0, 0, 0, 0, 0, 0, 0],
      inProgress: [0, 0, 0, 0, 0, 0, 0],
      review: [0, 0, 0, 0, 0, 0, 0],
      overdue: [0, 0, 0, 0, 0, 0, 0],
    },
  };
  const overviewData = { month: emptyPeriod, week: emptyPeriod };

  const metricCopy = {
    total: { caption: "All tasks", kicker: "Overall health" },
    completed: { caption: "Completed", kicker: "Done this period" },
    inProgress: { caption: "In progress", kicker: "Active work" },
    review: { caption: "Pending review", kicker: "Waiting on leads" },
    overdue: { caption: "Overdue", kicker: "Needs attention" },
  };

  const chartColors = {
    full: ["#5d9a7a", "#6aabcc", "#a78bfa", "#e57373"],
    dim: ["rgba(93,154,122,0.22)", "rgba(106,171,204,0.22)", "rgba(167,139,250,0.22)", "rgba(229,115,115,0.22)"],
  };

  let overviewState = { range: "month", metric: "total", chart: null };
  let currentUser = null;
  let currentEvent = null;

  function animateCounterTo(el, target) {
    const duration = 700;
    const startValue = parseInt(el.textContent, 10) || 0;
    const start = performance.now();

    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(startValue + (target - startValue) * eased);
      if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }

  function animateCounters() {
    document.querySelectorAll(".stat-number").forEach(function (counter) {
      const target = parseInt(counter.getAttribute("data-target"), 10);
      animateCounterTo(counter, target);
    });
  }

  function setCenterLabel(value, caption) {
    const percentEl = document.getElementById("chart-percent");
    const captionEl = document.getElementById("chart-center-caption");
    if (percentEl) percentEl.textContent = value;
    if (captionEl) captionEl.textContent = caption;
  }

  function updatePipeline(totals, metric) {
    const pipeline = document.getElementById("task-pipeline");
    if (!pipeline) return;

    const keys = ["completed", "inProgress", "review", "overdue"];
    const sum = keys.reduce(function (acc, key) { return acc + totals[key]; }, 0) || 1;

    pipeline.classList.toggle("is-filtered", metric !== "total");
    keys.forEach(function (key) {
      const pipe = pipeline.querySelector('[data-key="' + key + '"]');
      if (!pipe) return;
      pipe.style.width = ((totals[key] / sum) * 100) + "%";
      pipe.classList.toggle("is-focus", metric === key);
    });
  }

  function updateWeekBars(range, metric) {
    const values = overviewData[range].daily[metric];
    const labels = overviewData[range].daily.labels || [];
    const max = Math.max.apply(null, values.concat([1]));
    const bars = document.querySelectorAll(".week-bar");
    const caption = document.getElementById("week-caption");
    const label = metricCopy[metric].caption.toLowerCase();

    bars.forEach(function (bar, index) {
      const value = values[index] || 0;
      const day = labels[index] || "--";
      const dayLabel = bar.querySelector("span");
      if (dayLabel) dayLabel.textContent = day;
      bar.setAttribute("data-day", day);
      bar.setAttribute("data-value", String(value));
      bar.setAttribute("data-tone", metric);
      bar.style.setProperty("--h", Math.max(10, Math.round((value / max) * 100)) + "%");
      bar.title = bar.getAttribute("data-day") + " · " + value + " " + label;
    });

    if (caption) caption.textContent = "Daily " + label + " · hover a bar";
  }

  function updateInsight(range, metric) {
    const totals = overviewData[range].totals;
    const rangeLabel = range === "week" ? "the last 7 days" : "the last 30 days";
    const spotlight = document.getElementById("org-spotlight");
    const kicker = document.getElementById("org-kicker");
    const insight = document.getElementById("org-insight");
    const copy = metricCopy[metric];
    const share = totals.total
      ? Math.round((totals[metric === "total" ? "completed" : metric] / totals.total) * 100)
      : 0;

    if (kicker) kicker.textContent = copy.kicker;

    if (spotlight) {
      if (metric === "total") {
        spotlight.textContent = share + "% of " + totals.total + " tasks are complete " + rangeLabel + ".";
      } else if (metric === "overdue") {
        spotlight.textContent = totals.overdue + " overdue tasks need a nudge " + rangeLabel + ".";
      } else {
        spotlight.textContent = totals[metric] + " " + copy.caption.toLowerCase() + " · " + share + "% of the pipeline.";
      }
    }

    if (insight) {
      insight.textContent = range === "week"
        ? "Last 7 days · tap a chip or chart slice to filter."
        : "Last 30 days · tap a chip or chart slice to filter.";
    }
  }

  function highlightChart(metric) {
    const chart = overviewState.chart;
    if (!chart) return;

    const colors = metric === "total"
      ? chartColors.full.slice()
      : chartColors.dim.slice();

    if (metric === "completed") colors[0] = chartColors.full[0];
    if (metric === "inProgress") colors[1] = chartColors.full[1];
    if (metric === "review") colors[2] = chartColors.full[2];
    if (metric === "overdue") colors[3] = chartColors.full[3];

    chart.data.datasets[0].backgroundColor = colors;
    chart.update();
  }

  function selectMetric(metric, announce) {
    overviewState.metric = metric;
    const totals = overviewData[overviewState.range].totals;
    const copy = metricCopy[metric];

    document.querySelectorAll(".metric-chip").forEach(function (chip) {
      chip.classList.toggle("is-active", chip.getAttribute("data-key") === metric);
    });

    if (metric === "total") {
      const percentage = totals.total ? Math.round((totals.completed / totals.total) * 100) : 0;
      setCenterLabel(percentage + "%", "Complete");
    } else {
      setCenterLabel(String(totals[metric]), copy.caption);
    }

    highlightChart(metric);
    updatePipeline(totals, metric);
    updateWeekBars(overviewState.range, metric);
    updateInsight(overviewState.range, metric);

    if (announce) {
      showToast((metric === "total" ? "All tasks" : copy.caption) + " · " + totals[metric]);
    }
  }

  function applyRange(range) {
    overviewState.range = range;
    const totals = overviewData[range].totals;

    document.querySelectorAll(".range-btn").forEach(function (btn) {
      const active = btn.getAttribute("data-range") === range;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll(".metric-chip").forEach(function (chip) {
      const key = chip.getAttribute("data-key");
      const number = chip.querySelector(".stat-number");
      if (number) {
        number.setAttribute("data-target", String(totals[key]));
        animateCounterTo(number, totals[key]);
      }
    });

    if (overviewState.chart) {
      overviewState.chart.data.datasets[0].data = [
        totals.completed,
        totals.inProgress,
        totals.review,
        totals.overdue,
      ];
      overviewState.chart.update();
    }

    selectMetric(overviewState.metric, false);
  }

  function initChart() {
    const canvas = document.getElementById("completion-chart");
    if (!canvas || typeof Chart === "undefined") {
      applyRange("month");
      return;
    }

    const totals = overviewData.month.totals;
    overviewState.chart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["Completed", "In Progress", "Pending Review", "Overdue"],
        datasets: [{
          data: [totals.completed, totals.inProgress, totals.review, totals.overdue],
          backgroundColor: chartColors.full.slice(),
          borderWidth: 0,
          hoverOffset: 10,
        }],
      },
      options: {
        cutout: "74%",
        responsive: true,
        maintainAspectRatio: true,
        animation: { animateRotate: true, duration: 1100, easing: "easeOutQuart" },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#1a2e24",
            titleFont: { family: "'Plus Jakarta Sans', sans-serif", weight: "700" },
            bodyFont: { family: "'Plus Jakarta Sans', sans-serif" },
            padding: 10,
            cornerRadius: 10,
          },
        },
        onClick: function (_event, elements) {
          const keys = ["completed", "inProgress", "review", "overdue"];
          if (!elements.length) {
            selectMetric("total", true);
            return;
          }
          selectMetric(keys[elements[0].index], true);
        },
      },
    });

    applyRange("month");
  }

  function initOverviewInteractions() {
    document.querySelectorAll(".range-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        applyRange(btn.getAttribute("data-range"));
      });
    });

    document.querySelectorAll(".metric-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        const key = chip.getAttribute("data-key");
        selectMetric(key === overviewState.metric ? "total" : key, true);
      });
    });

    document.querySelectorAll(".week-bar").forEach(function (bar) {
      bar.addEventListener("mouseenter", function () {
        bar.classList.add("is-hot");
        const caption = document.getElementById("week-caption");
        if (caption) {
          caption.textContent = bar.getAttribute("data-day") + " · " + bar.getAttribute("data-value") + " tasks";
        }
      });
      bar.addEventListener("mouseleave", function () {
        bar.classList.remove("is-hot");
        updateWeekBars(overviewState.range, overviewState.metric);
      });
      bar.addEventListener("click", function () {
        showToast(bar.getAttribute("data-day") + " · " + bar.getAttribute("data-value") + " tasks");
      });
    });
  }

  async function apiRequest(url, options) {
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

  function displayDate(value, options) {
    const date = new Date(value + "T00:00:00");
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, options || { day: "numeric", month: "short" }).format(date);
  }

  function setOverviewMetrics(data) {
    ["week", "month"].forEach(function (range) {
      const period = data.periods && data.periods[range];
      if (!period || !period.totals || !period.daily) {
        throw new Error("Dashboard statistics were returned in an invalid format.");
      }
      overviewData[range] = period;
    });
  }

  async function loadDashboardOverview() {
    try {
      const data = await apiRequest("/api/dashboard/overview");
      setOverviewMetrics(data);
      initChart();
      animateCounters();
    } catch (error) {
      const spotlight = document.getElementById("org-spotlight");
      if (spotlight) spotlight.textContent = "Task statistics are unavailable.";
      showToast(error instanceof Error ? error.message : "Task statistics are unavailable.");
      initChart();
    }
  }

  async function loadTeamPerformance() {
    const container = document.getElementById("team-cards-inner");
    if (!container) return;
    try {
      const result = await apiRequest("/api/dashboard/team-performance");
      container.replaceChildren();
      const teams = result.teams || [];
      if (!teams.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No teams are available in this workspace.";
        container.append(empty);
        return;
      }
      const visuals = [
        ["tech-visual", "◉"],
        ["design-visual", "◇"],
        ["marketing-visual", "↗"],
        ["ops-visual", "⌂"],
        ["content-visual", "✳"],
      ];
      teams.forEach(function (team, index) {
        const card = document.createElement("a");
        card.className = "team-card team-card-active";
        card.href = "team.html?team=" + encodeURIComponent(team.teamId);
        card.setAttribute("aria-label", "Open " + team.teamName + " team details");

        const visual = document.createElement("div");
        visual.className = "team-card-visual " + visuals[index % visuals.length][0];
        const icon = document.createElement("span");
        icon.className = "team-emoji";
        icon.textContent = visuals[index % visuals.length][1];
        visual.append(icon);

        const body = document.createElement("div");
        body.className = "team-card-body";
        const heading = document.createElement("h3");
        heading.textContent = team.teamName;
        const lead = document.createElement("p");
        lead.className = "team-lead";
        lead.textContent = "Members: ";
        const memberCount = document.createElement("strong");
        memberCount.textContent = String(team.memberCount || 0);
        lead.append(memberCount);

        const stats = document.createElement("div");
        stats.className = "team-stats-row";
        const members = document.createElement("span");
        members.textContent = "Members ";
        const membersValue = document.createElement("strong");
        membersValue.textContent = String(team.memberCount || 0);
        members.append(membersValue);
        const pending = document.createElement("span");
        pending.textContent = "Pending ";
        const pendingValue = document.createElement("strong");
        pendingValue.textContent = String(team.pendingTasks || 0);
        pending.append(pendingValue);
        stats.append(members, pending);

        const progressWrap = document.createElement("div");
        progressWrap.className = "progress-wrap";
        const progressLabel = document.createElement("div");
        progressLabel.className = "progress-label";
        const completionLabel = document.createElement("span");
        completionLabel.textContent = "Completion";
        const completionValue = document.createElement("span");
        completionValue.className = "progress-value";
        completionValue.textContent = team.completionPercentage + "%";
        progressLabel.append(completionLabel, completionValue);
        const progressBar = document.createElement("div");
        progressBar.className = "progress-bar";
        const fill = document.createElement("div");
        fill.className = "progress-fill";
        fill.style.width = team.completionPercentage + "%";
        progressBar.append(fill);
        progressWrap.append(progressLabel, progressBar);

        const overdue = document.createElement("p");
        overdue.className = "overdue-tag";
        overdue.textContent = team.overdueTasks + " overdue";
        body.append(heading, lead, stats, progressWrap, overdue);

        const arrow = document.createElement("span");
        arrow.className = "card-arrow";
        arrow.textContent = "→";
        card.append(visual, body, arrow);
        container.append(card);
      });
    } catch (error) {
      container.replaceChildren();
      const unavailable = document.createElement("p");
      unavailable.className = "empty-state";
      unavailable.textContent = "Team analytics are unavailable.";
      container.append(unavailable);
      showToast(error instanceof Error ? error.message : "Team analytics are unavailable.");
    }
  }

  function initialsFor(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(function (part) {
      return part[0].toUpperCase();
    }).join("");
  }

  async function loadTopPerformers() {
    const list = document.getElementById("performer-list");
    if (!list) return;
    try {
      const result = await apiRequest("/api/dashboard/top-performers?limit=3");
      list.replaceChildren();
      const performers = result.members || [];
      if (!performers.length) {
        const empty = document.createElement("li");
        empty.className = "performer-item";
        empty.textContent = "No task performance data yet.";
        list.append(empty);
        return;
      }
      performers.forEach(function (member, index) {
        const item = document.createElement("li");
        item.className = "performer-item rank-" + (index + 1);
        const medal = document.createElement("span");
        medal.className = "rank-medal";
        medal.textContent = ["🥇", "🥈", "🥉"][index] || String(index + 1);
        const avatar = document.createElement("span");
        avatar.className = "performer-avatar " + ["avatar-gold", "avatar-silver", "avatar-bronze"][index];
        avatar.textContent = initialsFor(member.memberName);
        const info = document.createElement("div");
        info.className = "performer-info";
        const name = document.createElement("strong");
        name.textContent = member.memberName;
        const team = document.createElement("span");
        team.textContent = member.teamName || "Workspace member";
        info.append(name, team);
        const completed = document.createElement("span");
        completed.className = "performer-points";
        completed.textContent = member.completedTasks + " completed · " + member.completionPercentage + "%";
        item.append(medal, avatar, info, completed);
        list.append(item);
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Top performers are unavailable.");
    }
  }

  async function loadUpcomingDeadlines() {
    const list = document.getElementById("deadline-list");
    if (!list) return;
    try {
      const result = await apiRequest("/api/tasks?due=upcoming&limit=4");
      list.replaceChildren();
      const tasks = result.tasks || [];
      if (!tasks.length) {
        const empty = document.createElement("li");
        empty.className = "deadline-item";
        empty.textContent = "No upcoming task deadlines.";
        list.append(empty);
        return;
      }
      tasks.forEach(function (task) {
        const item = document.createElement("li");
        const priority = String(task.priority || "medium").toLowerCase();
        const priorityClass = priority === "urgent" ? "high" : priority;
        item.className = "deadline-item priority-" + (["high", "medium", "low"].includes(priorityClass) ? priorityClass : "medium");
        const info = document.createElement("div");
        info.className = "deadline-info";
        const badge = document.createElement("span");
        badge.className = "priority-badge " + (["high", "medium", "low"].includes(priorityClass) ? priorityClass : "medium");
        badge.textContent = task.priority || "Medium";
        const title = document.createElement("strong");
        title.textContent = task.title;
        const meta = document.createElement("span");
        meta.className = "deadline-meta";
        meta.textContent = (task.team || "Workspace") + " · Due " + displayDate(task.dueDate);
        const assignee = document.createElement("span");
        assignee.className = "deadline-time";
        assignee.textContent = task.assignee || "";
        info.append(badge, title, meta);
        const actions = document.createElement("div");
        actions.className = "deadline-time";
        if (task.canUpdateStatus) {
          const status = document.createElement("select");
          status.setAttribute("aria-label", "Update status for " + task.title);
          ["Assigned", "In Progress", "Pending review", "Completed", "Changes requested", "Rejected"].forEach(function (value) {
            const option = new Option(value, value);
            option.selected = task.status === value;
            status.add(option);
          });
          status.addEventListener("change", function () {
            status.disabled = true;
            apiRequest("/api/tasks/" + encodeURIComponent(task.id) + "/status", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: status.value }),
            }).then(function () {
              showToast("Task status updated.");
              return Promise.all([
                loadDashboardOverview(),
                loadTeamPerformance(),
                loadTopPerformers(),
                loadUpcomingDeadlines(),
              ]);
            }).catch(function (error) {
              showToast(error instanceof Error ? error.message : "Task status update failed.");
              status.disabled = false;
              status.value = task.status;
            });
          });
          actions.append(status);
        } else {
          actions.textContent = task.status || "";
        }
        item.append(info, assignee, actions);
        list.append(item);
      });
    } catch (error) {
      list.replaceChildren();
      const item = document.createElement("li");
      item.className = "deadline-item";
      item.textContent = "Task deadlines are unavailable.";
      list.append(item);
      showToast(error instanceof Error ? error.message : "Task deadlines are unavailable.");
    }
  }

  function formatEventTime(value) {
    if (!value) return "";
    const parts = value.split(":").map(Number);
    const date = new Date();
    date.setHours(parts[0], parts[1], 0, 0);
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }

  function renderEventChecklist(event) {
    const checklist = document.getElementById("event-checklist");
    if (!checklist) return;
    checklist.dataset.eventId = event ? event.id : "";
    checklist.replaceChildren();
    const items = event && Array.isArray(event.checklist) ? event.checklist : [];
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "checklist-item";
      empty.textContent = event ? "No checklist items." : "No event checklist is available.";
      checklist.append(empty);
      return;
    }

    items.forEach(function (entry) {
      const item = document.createElement("li");
      item.className = "checklist-item" + (entry.completed ? " done" : "");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "check-btn" + (entry.completed ? " checked" : "");
      button.textContent = entry.completed ? "✓" : "○";
      button.setAttribute("aria-pressed", entry.completed ? "true" : "false");
      button.setAttribute("aria-label", entry.completed ? "Mark incomplete" : "Mark complete");
      button.dataset.itemId = entry.id;
      button.disabled = !currentUser || (
        !["admin", "manager"].includes(currentUser.role) && entry.assignedMember !== currentUser.id
      );
      const title = document.createElement("span");
      title.textContent = entry.title;
      item.append(button, title);
      checklist.append(item);
    });
  }

  async function loadUpcomingEvent() {
    const card = document.getElementById("upcoming-event-card");
    if (!card) return;
    try {
      const result = await apiRequest("/api/events?status=upcoming&limit=1");
      currentEvent = (result.events || [])[0] || null;
      const month = card.querySelector(".event-month");
      const day = card.querySelector(".event-day");
      const title = card.querySelector(".event-details strong");
      const description = card.querySelector(".event-details p");
      const time = card.querySelector(".event-time");
      if (!currentEvent) {
        month.textContent = "--";
        day.textContent = "--";
        title.textContent = "No upcoming events";
        description.textContent = "Create an event to share it with your workspace.";
        time.textContent = "";
      } else {
        const date = new Date(currentEvent.eventDate + "T00:00:00");
        month.textContent = new Intl.DateTimeFormat(undefined, { month: "short" }).format(date).toUpperCase();
        day.textContent = new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(date);
        title.textContent = currentEvent.title;
        description.textContent = [currentEvent.description, currentEvent.location].filter(Boolean).join(" · ");
        time.textContent = currentEvent.startTime
          ? "🕐 " + formatEventTime(currentEvent.startTime) + (currentEvent.endTime ? " – " + formatEventTime(currentEvent.endTime) : "")
          : displayDate(currentEvent.eventDate, { weekday: "short", day: "numeric", month: "short" });
      }
      renderEventChecklist(currentEvent);
    } catch (error) {
      const title = card.querySelector(".event-details strong");
      if (title) title.textContent = "Events are unavailable.";
      renderEventChecklist(null);
      showToast(error instanceof Error ? error.message : "Events are unavailable.");
    }
  }

  /* ── Toast notifications ── */
  let toastTimer;
  function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("show");
    }, 2800);
  }

  /* ── Event checklist ── */
  function initChecklist() {
    const checklist = document.getElementById("event-checklist");
    if (!checklist) return;

    checklist.addEventListener("click", function (event) {
      const btn = event.target.closest(".check-btn");
      if (!btn) return;
      const eventId = checklist.dataset.eventId;
      const itemId = btn.dataset.itemId;
      const item = currentEvent && currentEvent.checklist.find(function (entry) {
        return entry.id === itemId;
      });
      if (!eventId || !item) return;

      btn.disabled = true;
      apiRequest("/api/events/" + encodeURIComponent(eventId) + "/checklist/" + encodeURIComponent(itemId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: !item.completed }),
      }).then(function (result) {
        currentEvent.checklist = currentEvent.checklist.map(function (entry) {
          return entry.id === itemId ? result.item : entry;
        });
        renderEventChecklist(currentEvent);
      }).catch(function (error) {
        showToast(error instanceof Error ? error.message : "Checklist update failed.");
        btn.disabled = false;
      });
    });
  }

  /* ── Placeholder button handlers ── */
  function initButtons() {
    const addTeamButton = document.getElementById("add-team-btn");
    if (addTeamButton) {
      addTeamButton.addEventListener("click", function () {
        window.location.assign("team.html");
      });
    }

    const searchInput = document.querySelector(".search-bar input");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        const query = searchInput.value.trim().toLowerCase();
        document.querySelectorAll(".team-card").forEach(function (card) {
          const matches = !query || card.textContent.toLowerCase().includes(query);
          card.hidden = !matches;
        });
      });
    }

    document.querySelectorAll(".team-card[role='button']").forEach(function (card) {
      card.addEventListener("click", function () {
        selectTeamCard(card);
      });

      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectTeamCard(card);
        }
      });
    });
  }

  function selectTeamCard(card) {
    document.querySelectorAll(".team-card").forEach(function (item) {
      item.classList.remove("is-selected");
      item.setAttribute("aria-pressed", "false");
    });

    card.classList.add("is-selected");
    card.setAttribute("aria-pressed", "true");
    const team = card.getAttribute("data-team");
    const name = team ? team.charAt(0).toUpperCase() + team.slice(1) : "Team";
    showToast(name + " team selected");
  }

  /* ── Subtle parallax on team card hover ── */
  function initCardHoverEffects() {
    document.querySelectorAll(".team-card-active").forEach(function (card) {
      card.addEventListener("mousemove", function (event) {
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        card.style.transform = "translateY(-4px) perspective(400px) rotateY(" + (x * 4) + "deg) rotateX(" + (-y * 4) + "deg)";
      });

      card.addEventListener("mouseleave", function () {
        card.style.transform = "";
      });
    });
  }

  /* ── Init ── */
  document.addEventListener("DOMContentLoaded", function () {
    setGreeting();
    setUserName();
    initOverviewInteractions();
    initChecklist();
    initButtons();
    initCardHoverEffects();
    loadDashboardOverview();
    loadTeamPerformance();
    loadUpcomingDeadlines();
    loadTopPerformers();
    loadUpcomingEvent();
  });
})();
