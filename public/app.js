/**
 * Municipal Citizen Services & Smart Complaint Management System
 * Single-page frontend.
 *
 * Every screen reads and writes through the documented API contracts under
 * /api. No statistics or records are fabricated on the client: what is shown is
 * exactly what the server returns for the signed-in user's permissions.
 */
(function () {
  "use strict";

  /* =========================================================================
   * 1. Constants and shared state
   * ========================================================================= */
  const STORAGE = { token: "mc_token", user: "mc_user" };

  const STATUSES = [
    "Submitted",
    "Under Review",
    "Assigned",
    "In Progress",
    "Resolved",
    "Rejected",
    "Reopened",
    "Closed"
  ];
  const OPEN_STATUSES = ["Submitted", "Under Review", "Assigned", "In Progress", "Reopened"];
  const REOPENABLE_STATUSES = ["Resolved", "Closed", "Rejected"];
  const PRIORITIES = ["low", "medium", "high", "critical"];
  const APPLICATION_STATUSES = [
    "Submitted",
    "Under Review",
    "Referred",
    "Approved",
    "Rejected",
    "Closed"
  ];
  // Mirrors lib/civic.js so the UI only offers transitions the server accepts.
  const STATUS_TRANSITIONS = {
    Submitted: ["Under Review", "Assigned", "Rejected", "Closed"],
    "Under Review": ["Assigned", "In Progress", "Rejected", "Closed"],
    Assigned: ["In Progress", "Under Review", "Rejected", "Closed"],
    "In Progress": ["Resolved", "Assigned", "Rejected", "Closed"],
    Reopened: ["Under Review", "Assigned", "In Progress", "Rejected", "Closed"],
    Resolved: ["Reopened", "Closed"],
    Rejected: ["Closed", "Under Review"],
    Closed: ["Reopened"]
  };

  const ROUTES = [
    "home",
    "complaints",
    "services",
    "transparency",
    "track",
    "login",
    "register",
    "dashboard",
    "staff",
    "admin",
    "contact"
  ];

  const state = {
    token: null,
    user: null,
    taxonomy: null,
    wards: [],
    departments: [],
    staffUsers: [],
    charts: {},
    objectUrls: [],
    map: null,
    marker: null,
    appMap: null,
    appMarker: null,
    detailMap: null,
    transparency: null,
    serviceFocus: null,
    pendingService: null,
    myComplaints: { page: 1, limit: 10, total: 0, totalPages: 1 },
    myApps: { page: 1, limit: 10, total: 0, totalPages: 1 },
    myPayments: { page: 1, limit: 10, total: 0, totalPages: 1 },
    staffFilters: {
      status: "",
      category_id: "",
      subcategory_id: "",
      ward_id: "",
      department_id: "",
      priority: "",
      search: "",
      from: "",
      to: "",
      window: "",
      unassigned: false
    },
    staffQueue: { page: 1, limit: 15, total: 0, totalPages: 1 },
    adminFilters: {
      status: "",
      category_id: "",
      department_id: "",
      assigned_to: "",
      ward_id: "",
      priority: "",
      search: "",
      from: "",
      to: "",
      unassigned: false
    },
    adminComplaints: { page: 1, limit: 15, total: 0, totalPages: 1 },
    adminEmail: { page: 1, limit: 25, direction: "", status: "" },
    dashboardTab: "complaints",
    staffTab: "queue",
    adminTab: "complaints",
    loginTab: "citizen",
    loginDefaults: null
  };

  /* =========================================================================
   * 2. Small utilities
   * ========================================================================= */
  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) =>
    Array.prototype.slice.call((root || document).querySelectorAll(selector));

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  function slug(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function fmtDateTime(value) {
    if (!value) return "Not available";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function fmtDate(value) {
    if (!value) return "Not available";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
  }

  function humanHours(hours) {
    if (hours === null || hours === undefined || Number.isNaN(Number(hours))) return "Not available";
    const value = Number(hours);
    if (value < 48) return `${value.toFixed(1)} hours`;
    return `${(value / 24).toFixed(1)} days`;
  }

  function statusTag(status) {
    if (!status) return "";
    return `<span class="status-tag status-${slug(status)}">${esc(status)}</span>`;
  }

  function priorityTag(priority) {
    if (!priority) return "";
    return `<span class="priority-tag priority-${slug(priority)}">${esc(priority)}</span>`;
  }

  function typeBadge(itemType) {
    const map = {
      information: ["Information", "type-information"],
      application: ["Online application", "type-application"],
      complaint: ["Report an issue", "type-complaint"]
    };
    const entry = map[itemType] || ["Service", "type-information"];
    return `<span class="type-badge ${entry[1]}">${entry[0]}</span>`;
  }

  function toast(message, tone) {
    const region = $("#toast-region");
    if (!region) return;
    const node = document.createElement("div");
    node.className = `toast toast-${tone || "info"}`;
    node.textContent = message;
    region.appendChild(node);
    setTimeout(() => {
      node.classList.add("toast-out");
      setTimeout(() => node.remove(), 300);
    }, 4200);
  }

  function paginationHtml(page, totalPages, action) {
    if (!totalPages || totalPages <= 1) return "";
    return `
      <div class="pagination">
        <button type="button" class="secondary small" data-action="${action}" data-page="${
      page - 1
    }" ${page <= 1 ? "disabled" : ""}>Previous</button>
        <span class="muted">Page ${page} of ${totalPages}</span>
        <button type="button" class="secondary small" data-action="${action}" data-page="${
      page + 1
    }" ${page >= totalPages ? "disabled" : ""}>Next</button>
      </div>`;
  }

  function emptyState(message) {
    return `<p class="empty-state">${esc(message)}</p>`;
  }

  function isStaff() {
    return !!state.user && (state.user.role === "staff" || state.user.role === "admin");
  }

  function isAdmin() {
    return !!state.user && state.user.role === "admin";
  }

  function optionsFrom(items, valueKey, labelKey, placeholder, selected) {
    const rows = items
      .map(
        (item) =>
          `<option value="${esc(item[valueKey])}" ${
            String(selected) === String(item[valueKey]) ? "selected" : ""
          }>${esc(item[labelKey])}</option>`
      )
      .join("");
    return `<option value="">${esc(placeholder)}</option>${rows}`;
  }

  /* =========================================================================
   * 3. HTTP layer
   * ========================================================================= */
  class ApiError extends Error {
    constructor(message, status, errors) {
      super(message);
      this.status = status;
      this.errors = errors || [];
    }
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    let body;
    if (opts.form) {
      body = opts.form;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const response = await fetch(path, { method: opts.method || "GET", headers, body });

    if (opts.raw) {
      if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
          const parsed = await response.json();
          if (parsed && parsed.error) message = parsed.error;
        } catch (e) {
          /* keep the generic message */
        }
        throw new ApiError(message, response.status);
      }
      return response;
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = null;
      }
    }
    if (!response.ok) {
      const message = (data && data.error) || `Request failed (${response.status})`;
      throw new ApiError(message, response.status, data && data.errors);
    }
    return data;
  }

  /** Loads a private file through the authorised endpoint and returns a blob URL. */
  async function loadPrivateFile(url) {
    const response = await api(url, { raw: true });
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    state.objectUrls.push(objectUrl);
    return objectUrl;
  }

  function revokeObjectUrls() {
    for (const url of state.objectUrls) URL.revokeObjectURL(url);
    state.objectUrls = [];
  }

  /* =========================================================================
   * 4. Session handling
   * ========================================================================= */
  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(STORAGE.token, token);
    localStorage.setItem(STORAGE.user, JSON.stringify(user));
    updateAuthUI();
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.user);
    updateAuthUI();
  }

  function updateAuthUI() {
    const loggedIn = !!state.user;
    $$("[data-auth]").forEach((el) => {
      const scope = el.getAttribute("data-auth");
      let show = false;
      if (scope === "guest") show = !loggedIn;
      else if (scope === "user") show = loggedIn;
      else if (scope === "staff") show = isStaff();
      else if (scope === "admin") show = isAdmin();
      el.hidden = !show;
    });
    if (loggedIn) refreshNotificationCount();
  }

  async function refreshNotificationCount() {
    const badge = $("#notification-count");
    if (!badge || !state.user) return;
    try {
      const data = await api("/api/notifications?limit=1");
      const count = data && data.unread ? data.unread : 0;
      badge.textContent = String(count);
      badge.hidden = count === 0;
    } catch (e) {
      badge.hidden = true;
    }
  }

  function requireLogin(returnRoute) {
    toast("Please sign in to continue.", "warning");
    navigate(returnRoute || "login");
  }

  /* =========================================================================
   * 5. Reference data loaders (cached)
   * ========================================================================= */
  async function loadTaxonomy(force) {
    if (state.taxonomy && !force) return state.taxonomy;
    const data = await api("/api/services/categories");
    const categories = (data && data.categories) || [];
    const byId = new Map();
    const subById = new Map();
    for (const category of categories) {
      byId.set(category.id, category);
      for (const sub of category.subcategories || []) {
        sub.category_id = category.id;
        sub.category_name = category.name;
        subById.set(sub.id, sub);
      }
    }
    state.taxonomy = { categories, byId, subById };
    return state.taxonomy;
  }

  async function loadWards(force) {
    if (state.wards.length && !force) return state.wards;
    const data = await api("/api/services/wards");
    state.wards = (data && data.wards) || [];
    return state.wards;
  }

  async function loadDepartments(force) {
    if (state.departments.length && !force) return state.departments;
    const data = await api("/api/staff/departments");
    state.departments = (data && data.departments) || [];
    return state.departments;
  }

  async function loadStaffUsers(force) {
    if (state.staffUsers.length && !force) return state.staffUsers;
    const data = await api("/api/staff/staff-users");
    state.staffUsers = data || [];
    return state.staffUsers;
  }

  function fillWardSelect(select, placeholder, selected) {
    if (!select) return;
    select.innerHTML = optionsFrom(state.wards, "id", "name", placeholder, selected);
  }

  function fillDepartmentSelect(select, placeholder, selected) {
    if (!select) return;
    select.innerHTML = optionsFrom(state.departments, "id", "name", placeholder, selected);
  }

  /* =========================================================================
   * 6. Router
   * ========================================================================= */
  function currentRoute() {
    const raw = String(location.hash || "").replace(/^#\/?/, "");
    const key = raw.split("/")[0] || "home";
    return ROUTES.indexOf(key) === -1 ? "home" : key;
  }

  function navigate(route, options) {
    const opts = options || {};
    const target = `#/${route}`;
    if (opts.replace) {
      history.replaceState(null, "", target);
      renderRoute();
    } else if (location.hash === target) {
      renderRoute();
    } else {
      location.hash = target;
    }
  }

  function guardRoute(route) {
    if (route === "dashboard" && !state.user) {
      toast("Please sign in to open your dashboard.", "warning");
      return "login";
    }
    if (route === "staff" && !isStaff()) {
      toast("The service desk is only available to municipal staff.", "warning");
      return state.user ? "dashboard" : "login";
    }
    if (route === "admin" && !isAdmin()) {
      toast("Administration is only available to administrators.", "warning");
      return state.user ? "dashboard" : "login";
    }
    if ((route === "login" || route === "register") && state.user) return "dashboard";
    return route;
  }

  async function renderRoute() {
    const requested = currentRoute();
    const route = guardRoute(requested);
    if (route !== requested) {
      navigate(route, { replace: true });
      return;
    }

    $$(".view").forEach((section) => section.classList.remove("visible"));
    const section = $(`#view-${route}`);
    if (section) section.classList.add("visible");

    $$(".nav-link[data-route]").forEach((button) => {
      button.classList.toggle("active", button.getAttribute("data-route") === route);
    });

    window.scrollTo(0, 0);

    try {
      if (route === "home") await renderHome();
      else if (route === "complaints") await renderComplaints();
      else if (route === "services") await renderServices();
      else if (route === "transparency") await renderTransparency();
      else if (route === "track") await renderTrack();
      else if (route === "login") await renderLogin();
      else if (route === "register") await renderRegister();
      else if (route === "dashboard") await renderDashboard();
      else if (route === "staff") await renderStaff();
      else if (route === "admin") await renderAdmin();
      else if (route === "contact") await renderContact();
    } catch (error) {
      console.error(error);
      toast(error.message || "Unable to load this page.", "error");
    }
  }

  /* =========================================================================
   * 7. Modal helpers
   * ========================================================================= */
  function openModal(options) {
    const root = $("#modal-root");
    // Whatever was open is about to be replaced: release any Leaflet map attached
    // to the outgoing DOM so it cannot leak into the next modal.
    destroyMap("application");
    root.innerHTML = `
      <div class="modal-overlay" role="dialog" aria-modal="true">
        <div class="modal ${options.wide ? "modal-wide" : ""}">
          <div class="modal-header">
            <h3>${options.title || ""}</h3>
            <button type="button" class="icon-button" data-action="close-modal" aria-label="Close">&times;</button>
          </div>
          <div class="modal-body">${options.bodyHtml || ""}</div>
          ${options.footerHtml ? `<div class="modal-footer">${options.footerHtml}</div>` : ""}
        </div>
      </div>`;
    const overlay = $(".modal-overlay", root);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeModal();
    });
    return $(".modal", root);
  }

  function closeModal() {
    revokeObjectUrls();
    if (state.detailMap) {
      state.detailMap.remove();
      state.detailMap = null;
    }
    destroyMap("application");
    const root = $("#modal-root");
    if (root) root.innerHTML = "";
  }

  /* =========================================================================
   * 8. Charts and shared fragments
   * ========================================================================= */
  const CHART_COLORS = [
    "#0b3d91", "#f4b41a", "#138808", "#ff9933", "#6d28d9", "#0e7490", "#b91c1c",
    "#4b5563", "#1d4ed8", "#a16207", "#be185d", "#047857", "#7c2d12", "#374151"
  ];

  function destroyChart(key) {
    if (state.charts[key]) {
      state.charts[key].destroy();
      delete state.charts[key];
    }
  }

  function renderBarChart(canvasId, key, labels, values) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === "undefined") return;
    destroyChart(key);
    state.charts[key] = new Chart(canvas, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{ label: "Complaints", data: values, backgroundColor: "#0b3d91" }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
  }

  function renderDoughnutChart(canvasId, key, labels, values) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === "undefined") return;
    destroyChart(key);
    state.charts[key] = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: labels,
        datasets: [{ data: values, backgroundColor: CHART_COLORS, borderWidth: 1 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } }
      }
    });
  }

  function statCard(label, value, note) {
    return `<div class="stat-card">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
      ${note ? `<div class="stat-note">${esc(note)}</div>` : ""}
    </div>`;
  }

  function detailField(label, value) {
    return `<div class="detail-field"><span class="detail-label">${esc(label)}:</span> ${value}</div>`;
  }

  async function renderAnnouncements(container, limit) {
    if (!container) return;
    try {
      const data = await api(`/api/services/announcements?limit=${limit || 5}`);
      const rows = (data && data.announcements) || [];
      container.innerHTML = rows.length
        ? rows
            .map(
              (row) => `<li>
                <div class="notice-title">${esc(row.title)}</div>
                <div class="muted small">${esc(fmtDate(row.published_at))}</div>
                ${row.body ? `<p class="muted">${esc(row.body)}</p>` : ""}
              </li>`
            )
            .join("")
        : `<li class="empty-state">There are no public notices at the moment.</li>`;
    } catch (error) {
      container.innerHTML = `<li class="empty-state">${esc(error.message)}</li>`;
    }
  }

  async function loadTransparency(force) {
    if (state.transparency && !force) return state.transparency;
    state.transparency = await api("/api/public/transparency");
    return state.transparency;
  }

  /* =========================================================================
   * 9. Home
   * ========================================================================= */
  async function renderHome() {
    const overview = await api("/api/public/overview");
    const stats = $("#home-stats");
    if (stats) {
      stats.innerHTML = [
        statCard("Total complaints", overview.total),
        statCard("Resolved", overview.resolved),
        statCard("Open", overview.open),
        statCard("Past target date", overview.overdue)
      ].join("");
    }

    const taxonomy = await loadTaxonomy();
    const categories = $("#home-categories");
    if (categories) {
      categories.innerHTML = taxonomy.categories
        .map(
          (cat) => `<div class="category-tile">
            <h3>${esc(cat.name)}</h3>
            <p class="muted">${esc(cat.description || "")}</p>
            <p class="muted small">${(cat.subcategories || []).length} listed service(s)</p>
            <button type="button" class="secondary small" data-action="browse-category" data-category="${cat.id}">
              View services
            </button>
          </div>`
        )
        .join("");
    }

    let transparency = null;
    try {
      transparency = await loadTransparency(true);
    } catch (error) {
      console.error(error);
    }
    const resolved = $("#home-resolved");
    if (resolved) {
      const rows = transparency ? transparency.recently_resolved || [] : [];
      resolved.innerHTML = rows.length
        ? rows
            .map(
              (row) => `<li>
                <span class="mono">${esc(row.reference_no)}</span>
                <span class="muted">${esc(row.category_name || "Uncategorised")} &middot; ${esc(
                  fmtDate(row.resolved_at)
                )}</span>
              </li>`
            )
            .join("")
        : `<li class="empty-state">No complaints have been resolved yet.</li>`;
    }
    const updated = $("#home-resolved-updated");
    if (updated && transparency) updated.textContent = `Updated ${fmtDateTime(transparency.generated_at)}`;

    await renderAnnouncements($("#home-announcements"), 4);

    renderBarChart(
      "home-trend-chart",
      "homeTrend",
      (overview.by_month || []).map((row) => row.month),
      (overview.by_month || []).map((row) => row.count)
    );
  }

  /* =========================================================================
   * 10. Complaint submission
   * ========================================================================= */
  function newClientToken() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function renderStatusFlow() {
    const list = $("#status-flow");
    if (!list) return;
    const flow = ["Submitted", "Under Review", "Assigned", "In Progress", "Resolved"];
    list.innerHTML = flow.map((step) => `<li>${esc(step)}</li>`).join("");
  }

  async function renderComplaints() {
    renderStatusFlow();
    await loadTaxonomy();
    await loadWards();
    populateComplaintCategories();
    populateSubcategories(false);
    applyPendingComplaint();

    const wardSelect = $("#complaint-ward");
    fillWardSelect(wardSelect, "Not sure", wardSelect ? wardSelect.value : "");

    const form = $("#complaint-form");
    if (form && !form.dataset.clientToken) form.dataset.clientToken = newClientToken();

    if (!state.user) {
      const list = $("#my-complaints-list");
      if (list) {
        list.innerHTML = `<p class="empty-state">Sign in to see your complaints and track their progress.</p>`;
      }
      const confirmation = $("#complaint-confirmation");
      if (confirmation) confirmation.hidden = true;
    } else {
      await loadMyComplaints();
    }

    ensureMap("complaint");
  }

  function populateComplaintCategories() {
    const taxonomy = state.taxonomy;
    if (!taxonomy) return;
    const select = $("#complaint-category");
    if (select) {
      const current = select.value;
      select.innerHTML = optionsFrom(
        taxonomy.categories,
        "id",
        "name",
        "Select a category",
        current
      );
    }
    const filter = $("#my-filter-category");
    if (filter) {
      filter.innerHTML = optionsFrom(
        taxonomy.categories,
        "id",
        "name",
        "All categories",
        filter.value
      );
    }
    const statusFilter = $("#my-filter-status");
    if (statusFilter) {
      statusFilter.innerHTML = optionsFrom(
        STATUSES.map((value) => ({ value: value, label: value })),
        "value",
        "label",
        "All statuses",
        statusFilter.value
      );
    }
  }

  function populateSubcategories(preserve) {
    const taxonomy = state.taxonomy;
    const categorySelect = $("#complaint-category");
    const subSelect = $("#complaint-subcategory");
    if (!taxonomy || !categorySelect || !subSelect) return;

    const previous = preserve ? subSelect.value : "";
    const category = taxonomy.byId.get(Number(categorySelect.value));
    if (!category) {
      subSelect.disabled = true;
      subSelect.innerHTML = `<option value="">Select a category first</option>`;
    } else {
      // Everyday complaint types come first; the remaining entries are services a
      // citizen can also raise a problem about ("my certificate application has
      // been stuck for three weeks"). They are labelled so the distinction is
      // obvious in the dropdown.
      const subs = (category.subcategories || []).slice().sort((a, b) => {
        const rank = (row) => (row.item_type === "complaint" ? 0 : 1);
        return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
      });
      if (!subs.length) {
        subSelect.disabled = true;
        subSelect.innerHTML = `<option value="">No issue types are configured for this category</option>`;
      } else {
        subSelect.disabled = false;
        subSelect.innerHTML = optionsFrom(
          subs.map((s) => ({
            id: s.id,
            label: s.item_type === "complaint" ? s.name : `${s.name} — service`
          })),
          "id",
          "label",
          "Select the issue type",
          previous
        );
      }
    }
    updateSubcategoryHelp();
  }

  function updateSubcategoryHelp() {
    const help = $("#subcategory-help");
    const subSelect = $("#complaint-subcategory");
    if (!help || !subSelect) return;
    const sub = state.taxonomy ? state.taxonomy.subById.get(Number(subSelect.value)) : null;
    if (!sub) {
      help.textContent = "";
      return;
    }
    const parts = [];
    if (sub.item_type && sub.item_type !== "complaint") {
      parts.push("You are reporting a problem with this municipal service.");
    }
    if (sub.summary) parts.push(sub.summary);
    if (sub.processing_time) parts.push(`Typical handling time: ${sub.processing_time}`);
    if (sub.checklist && sub.checklist.length) {
      parts.push(`Please have ready: ${sub.checklist.join(", ")}`);
    }
    help.textContent = parts.join(" ");
  }

  /**
   * Consumes an intent recorded elsewhere in the portal (for example a citizen
   * choosing a service in the Citizen Services section) so the complaint form
   * opens on the right category and issue type.
   */
  function applyPendingComplaint() {
    const pending = state.pendingService;
    if (!pending || !state.taxonomy) return;
    state.pendingService = null;
    const categorySelect = $("#complaint-category");
    const subSelect = $("#complaint-subcategory");
    if (pending.categoryId && categorySelect && state.taxonomy.byId.has(Number(pending.categoryId))) {
      categorySelect.value = String(pending.categoryId);
      populateSubcategories(false);
    }
    if (pending.subcategoryId && subSelect) {
      const option = $$("option", subSelect).find(
        (node) => String(node.value) === String(pending.subcategoryId)
      );
      if (option) {
        subSelect.value = String(pending.subcategoryId);
        updateSubcategoryHelp();
      }
    }
  }

  // Two forms carry a location pin: the complaint form on the Complaints page and
  // the Citizen Services application form (which opens in a modal). Both behave
  // identically, so the pin logic is written once against a target descriptor.
  const PIN_TARGETS = {
    complaint: {
      container: "#complaint-map",
      latitude: "#complaint-latitude",
      longitude: "#complaint-longitude",
      readout: "#pin-readout",
      mapKey: "map",
      markerKey: "marker"
    },
    application: {
      container: "#application-map",
      latitude: "#application-latitude",
      longitude: "#application-longitude",
      readout: "#application-pin-readout",
      mapKey: "appMap",
      markerKey: "appMarker"
    }
  };

  // Tiles are proxied through the portal itself. Requesting them straight from
  // the public OpenStreetMap server made the map look "access blocked" while
  // zooming: OSM answers a burst of tile requests with HTTP 200 but a blank
  // placeholder image. The proxy fetches at a fixed low concurrency and caches
  // every tile, so a zoom gesture never floods the upstream server.
  const TILE_URL = "/api/map/tiles/{z}/{x}/{y}";
  const TILE_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; <a href="https://carto.com/attributions">CARTO</a>';

  // Keeping a few tiles either side of the viewport means panning and stepping
  // through zoom levels reuses tiles that are already cached in the browser.
  const TILE_LAYER_OPTIONS = {
    maxZoom: 19,
    attribution: TILE_ATTRIBUTION,
    updateWhenZooming: false,
    keepBuffer: 2,
    detectRetina: false
  };

  function ensureMap(targetKey) {
    const target = PIN_TARGETS[targetKey];
    const element = $(target.container);
    if (!element || typeof L === "undefined") return;
    const existing = state[target.mapKey];
    if (existing) {
      setTimeout(() => existing.invalidateSize(), 60);
      return;
    }
    const map = L.map(element, { center: [22.9734, 78.6569], zoom: 5 });
    L.tileLayer(TILE_URL, TILE_LAYER_OPTIONS).addTo(map);
    map.on("click", (event) => setPin(targetKey, event.latlng.lat, event.latlng.lng));
    state[target.mapKey] = map;
    setTimeout(() => map.invalidateSize(), 60);
  }

  function setPin(targetKey, lat, lng) {
    const target = PIN_TARGETS[targetKey];
    const map = state[target.mapKey];
    if (map && typeof L !== "undefined") {
      if (state[target.markerKey]) state[target.markerKey].setLatLng([lat, lng]);
      else state[target.markerKey] = L.marker([lat, lng]).addTo(map);
      map.setView([lat, lng], Math.max(map.getZoom(), 15));
    }
    const latField = $(target.latitude);
    const lngField = $(target.longitude);
    if (latField) latField.value = String(lat);
    if (lngField) lngField.value = String(lng);
    const readout = $(target.readout);
    if (readout) readout.textContent = `Pin placed at ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  function clearPin(targetKey) {
    const target = PIN_TARGETS[targetKey];
    const map = state[target.mapKey];
    if (map && state[target.markerKey]) {
      map.removeLayer(state[target.markerKey]);
      state[target.markerKey] = null;
    }
    const latField = $(target.latitude);
    const lngField = $(target.longitude);
    if (latField) latField.value = "";
    if (lngField) lngField.value = "";
    const readout = $(target.readout);
    if (readout) readout.textContent = "No pin placed.";
  }

  function useMyLocation(targetKey) {
    const target = PIN_TARGETS[targetKey];
    const readout = $(target.readout);
    if (!navigator.geolocation) {
      toast("This device does not provide location information.", "warning");
      return;
    }
    if (readout) readout.textContent = "Requesting your location…";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const map = state[target.mapKey];
        if (map) map.setView([lat, lng], 16);
        setPin(targetKey, lat, lng);
      },
      () => {
        if (readout) readout.textContent = "No pin placed.";
        toast("Your location could not be read. You can place the pin on the map instead.", "warning");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // Leaflet keeps DOM listeners and tile handlers alive; a modal map must be
  // torn down when the modal closes or the next open attaches to a dead node.
  function destroyMap(targetKey) {
    const target = PIN_TARGETS[targetKey];
    const map = state[target.mapKey];
    if (!map) return;command:workbench.trust.manage
    map.remove();
    state[target.mapKey] = null;
    state[target.markerKey] = null;
  }

  function resetComplaintForm() {
    const form = $("#complaint-form");
    if (form) form.reset();
    const subSelect = $("#complaint-subcategory");
    if (subSelect) {
      subSelect.disabled = true;
      subSelect.innerHTML = `<option value="">Select a category first</option>`;
    }
    updateSubcategoryHelp();
    clearPin("complaint");
    $$(".field-error", form || document).forEach((el) => {
      el.textContent = "";
    });
    const error = $("#complaint-form-error");
    if (error) error.textContent = "";
    const warning = $("#duplicate-warning");
    if (warning) {
      warning.hidden = true;
      warning.innerHTML = "";
    }
    const confirmation = $("#complaint-confirmation");
    if (confirmation) confirmation.hidden = true;
    if (form) form.dataset.clientToken = newClientToken();
  }

  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

  function validateComplaintForm() {
    const errors = {};
    const title = $("#complaint-title");
    const category = $("#complaint-category");
    const subcategory = $("#complaint-subcategory");
    const description = $("#complaint-description");
    const location = $("#complaint-location");

    if (!title || title.value.trim().length < 5) {
      errors.title = "Enter a title of at least 5 characters.";
    }
    if (!category || !category.value) errors.category_id = "Choose a service category.";
    if (!subcategory || !subcategory.value) errors.subcategory_id = "Choose the issue type.";
    if (!description || description.value.trim().length < 15) {
      errors.description = "Describe the issue in at least 15 characters.";
    }
    if (!location || location.value.trim().length < 3) {
      errors.location_text = "Provide a landmark, street or locality.";
    }

    const images = $("#complaint-images");
    if (images && images.files.length > 3) errors.image = "Attach at most 3 photos.";
    if (images) {
      for (const file of images.files) {
        if (file.size > MAX_IMAGE_BYTES) {
          errors.image = `"${file.name}" is larger than 8 MB.`;
          break;
        }
      }
    }
    const videos = $("#complaint-videos");
    if (videos && videos.files.length > 2) errors.video = "Attach at most 2 videos.";
    if (videos) {
      for (const file of videos.files) {
        if (file.size > MAX_VIDEO_BYTES) {
          errors.video = `"${file.name}" is larger than 25 MB.`;
          break;
        }
      }
    }
    return errors;
  }

  function showComplaintErrors(errors) {
    $$(".field-error").forEach((el) => {
      el.textContent = "";
    });
    for (const field of Object.keys(errors)) {
      const node = $(`.field-error[data-error-for="${field}"]`);
      if (node) node.textContent = errors[field];
    }
  }

  function collectComplaintPayload() {
    const form = $("#complaint-form");
    const formData = new FormData();
    formData.append("client_token", (form && form.dataset.clientToken) || newClientToken());
    formData.append("title", $("#complaint-title").value.trim());
    formData.append("subcategory_id", $("#complaint-subcategory").value);
    formData.append("description", $("#complaint-description").value.trim());
    formData.append("location_text", $("#complaint-location").value.trim());

    const priority = $("#complaint-priority").value;
    if (priority) formData.append("priority", priority);

    const ward = $("#complaint-ward").value;
    if (ward) formData.append("ward_id", ward);

    const lat = $("#complaint-latitude").value;
    const lng = $("#complaint-longitude").value;
    if (lat && lng) {
      formData.append("latitude", lat);
      formData.append("longitude", lng);
    }

    const contactName = $("#complaint-contact-name").value.trim();
    const contactPhone = $("#complaint-contact-phone").value.trim();
    const contactEmail = $("#complaint-contact-email").value.trim();
    if (contactName) formData.append("contact_name", contactName);
    if (contactPhone) formData.append("contact_phone", contactPhone);
    if (contactEmail) formData.append("contact_email", contactEmail);

    const images = $("#complaint-images");
    if (images) for (const file of images.files) formData.append("image", file);
    const videos = $("#complaint-videos");
    if (videos) for (const file of videos.files) formData.append("video", file);

    return formData;
  }

  async function submitComplaint() {
    if (!state.user) {
      requireLogin("complaints");
      return;
    }
    const button = $("#complaint-submit");
    const general = $("#complaint-form-error");
    const errors = validateComplaintForm();
    showComplaintErrors(errors);
    if (Object.keys(errors).length) {
      if (general) general.textContent = "Please correct the highlighted fields before submitting.";
      return;
    }
    if (general) general.textContent = "";
    if (button) {
      button.disabled = true;
      button.textContent = "Submitting…";
    }
    try {
      const data = await api("/api/complaints", {
        method: "POST",
        form: collectComplaintPayload()
      });
      handleComplaintSubmitted(data);
    } catch (error) {
      if (error.errors && error.errors.length) {
        const map = {};
        for (const item of error.errors) {
          if (!map[item.field]) map[item.field] = item.message;
        }
        showComplaintErrors(map);
      }
      if (general) general.textContent = error.message;
      toast(error.message, "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Submit complaint";
      }
    }
  }

  function handleComplaintSubmitted(data) {
    const card = $("#complaint-confirmation");
    const reference = $("#confirmation-reference");
    const body = $("#complaint-confirmation-body");
    const complaint = data.complaint || {};

    if (card) card.hidden = false;
    if (reference) reference.textContent = complaint.reference_no || "";

    if (body) {
      const duplicates = data.possible_duplicates || [];
      const duplicateBlock = duplicates.length
        ? `<div class="duplicate-warning">
             <strong>Similar complaints already exist.</strong>
             <p class="muted small">Your complaint has been kept. Municipal staff will link duplicates so the work is not repeated.</p>
             <ul class="plain-list">${duplicates
               .map(
                 (row) =>
                   `<li><span class="mono">${esc(row.reference_no)}</span> ${esc(
                     row.subcategory_name || ""
                   )} <span class="muted small">${esc((row.reasons || []).join(" · "))}</span></li>`
               )
               .join("")}</ul>
           </div>`
        : "";

      body.innerHTML = `
        <p>${esc(data.message || "Your complaint has been registered.")}</p>
        ${detailField("Status", statusTag(complaint.status))}
        ${detailField("Priority", priorityTag(complaint.priority))}
        ${detailField("Target date", esc(fmtDateTime(complaint.due_at)))}
        ${
          complaint.routed_to_review_queue
            ? `<p class="muted small">This complaint has been placed in the municipal review queue so the correct department can be confirmed.</p>`
            : ""
        }
        ${duplicateBlock}
        <div class="form-actions">
          <button type="button" class="secondary small" data-action="open-complaint" data-id="${
            complaint.id
          }">Open this complaint</button>
          <button type="button" class="secondary small" data-action="refresh-my-complaints">Refresh my complaints</button>
        </div>`;
    }

    toast(data.message || "Complaint registered.", "success");
    resetComplaintForm();
    if (state.user) {
      state.myComplaints.page = 1;
      loadMyComplaints();
      refreshNotificationCount();
    }
  }

  async function checkDuplicates() {
    if (!state.user) {
      requireLogin("complaints");
      return;
    }
    const warning = $("#duplicate-warning");
    const description = $("#complaint-description").value.trim();
    const subcategoryId = $("#complaint-subcategory").value;
    if (description.length < 15 || !subcategoryId) {
      toast("Choose the issue type and describe the problem first.", "warning");
      return;
    }
    if (warning) {
      warning.hidden = false;
      warning.innerHTML = `<p class="muted small">Checking for similar complaints…</p>`;
    }
    try {
      const data = await api("/api/complaints/duplicate-check", {
        method: "POST",
        body: {
          subcategory_id: Number(subcategoryId),
          description: description,
          latitude: $("#complaint-latitude").value || null,
          longitude: $("#complaint-longitude").value || null
        }
      });
      const matches = (data && data.matches) || [];
      if (!warning) return;
      if (!matches.length) {
        warning.innerHTML = `<p class="muted small">No similar open complaints were found nearby.</p>`;
        return;
      }
      warning.innerHTML = `<strong>Possible duplicates found (${matches.length})</strong>
        <p class="muted small">${esc(data.note || "You can still submit your complaint.")}</p>
        <ul class="plain-list">${matches
          .map(
            (row) =>
              `<li><span class="mono">${esc(row.reference_no)}</span> ${esc(row.subcategory_name || "")}
                <span class="muted small">${esc((row.reasons || []).join(" · "))}</span>
              </li>`
          )
          .join("")}</ul>`;
    } catch (error) {
      if (warning) warning.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  /* =========================================================================
   * 11. Complaint lists
   * ========================================================================= */
  function complaintRow(item) {
    const location = [item.ward_name, item.zone ? `Zone ${item.zone}` : null]
      .filter(Boolean)
      .join(" · ");
    return `<li class="record-row">
      <div class="record-main">
        <div class="record-title">${esc(item.title)}</div>
        <div class="record-meta">
          <span class="mono">${esc(item.reference_no)}</span>
          ${statusTag(item.status)}
          ${priorityTag(item.priority)}
          <span class="muted">${esc(item.category_name || "Uncategorised")}${
            item.subcategory_name ? ` &rsaquo; ${esc(item.subcategory_name)}` : ""
          }</span>
        </div>
        <div class="record-meta muted small">
          Filed ${esc(fmtDateTime(item.created_at))}
          ${item.due_at ? ` &middot; Target ${esc(fmtDateTime(item.due_at))}` : ""}
          ${location ? ` &middot; ${esc(location)}` : ""}
          ${item.is_overdue ? ' <span class="overdue-flag">Past target date</span>' : ""}
        </div>
      </div>
      <div class="record-actions">
        <button type="button" class="secondary small" data-action="open-complaint" data-id="${
          item.id
        }">View details</button>
      </div>
    </li>`;
  }

  function complaintListHtml(items) {
    if (!items || !items.length) return emptyState("No complaints found.");
    return `<ul class="record-list">${items.map(complaintRow).join("")}</ul>`;
  }

  async function loadMyComplaints() {
    const container = $("#my-complaints-list");
    if (!container) return;
    if (!state.user) {
      container.innerHTML = `<p class="empty-state">Sign in to see your complaints.</p>`;
      return;
    }
    container.innerHTML = `<p class="loading-text">Loading your complaints…</p>`;
    const params = new URLSearchParams();
    params.set("page", String(state.myComplaints.page));
    params.set("limit", String(state.myComplaints.limit));
    const status = $("#my-filter-status");
    const category = $("#my-filter-category");
    const search = $("#my-filter-search");
    if (status && status.value) params.set("status", status.value);
    if (category && category.value) params.set("category_id", category.value);
    if (search && search.value.trim()) params.set("search", search.value.trim());
    try {
      const data = await api(`/api/complaints?${params.toString()}`);
      state.myComplaints.total = data.total;
      state.myComplaints.totalPages = data.total_pages;
      container.innerHTML =
        complaintListHtml(data.items) +
        paginationHtml(data.page, data.total_pages, "my-complaints-page");
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  function applyMyFilters() {
    state.myComplaints.page = 1;
    loadMyComplaints();
  }

  /* =========================================================================
   * 12. Complaint detail (citizens and staff)
   * ========================================================================= */
  async function openComplaintDetail(id) {
    if (!state.user) {
      requireLogin();
      return;
    }
    let data;
    try {
      data = await api(`/api/complaints/${id}`);
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    renderComplaintDetail(data);
  }

  function renderComplaintDetail(data) {
    const complaint = data.complaint;
    const permissions = data.permissions || {};
    const contact = [complaint.contact_name, complaint.contact_phone, complaint.contact_email]
      .filter(Boolean)
      .join(" · ");

    const bodyHtml = `
      <div class="detail-grid">
        <div>
          <h4 class="subsection-title">${esc(complaint.title)}</h4>
          <div class="record-meta">
            <span class="mono">${esc(complaint.reference_no)}</span>
            ${statusTag(complaint.status)}
            ${priorityTag(complaint.priority)}
            ${complaint.is_public ? "" : '<span class="type-badge type-internal">Not public</span>'}
          </div>
          <p class="description-text">${esc(complaint.description)}</p>
          ${detailField("Category", esc(complaint.category_name || "Uncategorised"))}
          ${detailField("Issue type", esc(complaint.subcategory_name || "Not specified"))}
          ${detailField("Location", esc(complaint.location_text))}
          ${detailField(
            "Ward",
            complaint.ward_name
              ? `${esc(complaint.ward_name)}${complaint.zone ? ` (Zone ${esc(complaint.zone)})` : ""}`
              : "Not recorded"
          )}
          ${detailField("Department", esc(complaint.department_name || "Awaiting routing"))}
          ${detailField("Officer", esc(complaint.assigned_user_name || "Not assigned"))}
          ${detailField("Filed", esc(fmtDateTime(complaint.created_at)))}
          ${detailField(
            "Target date",
            `${esc(fmtDateTime(complaint.due_at))}${
              complaint.is_overdue ? ' <span class="overdue-flag">Past target date</span>' : ""
            }`
          )}
          ${complaint.resolved_at ? detailField("Resolved", esc(fmtDateTime(complaint.resolved_at))) : ""}
          ${complaint.closed_at ? detailField("Closed", esc(fmtDateTime(complaint.closed_at))) : ""}
          ${complaint.reopen_count ? detailField("Reopened", `${esc(complaint.reopen_count)} time(s)`) : ""}
          ${contact ? detailField("Contact", esc(contact)) : ""}
          ${complaint.citizen ? detailField("Citizen", esc(complaint.citizen.name || complaint.citizen.email || "")) : ""}
          ${complaint.admin_remarks ? detailField("Administrative remarks", esc(complaint.admin_remarks)) : ""}
          ${
            complaint.rejection_reason
              ? `<div class="alert alert-warning"><strong>Rejection reason:</strong> ${esc(
                  complaint.rejection_reason
                )}</div>`
              : ""
          }
          ${
            complaint.resolution_notes
              ? `<div class="alert alert-success"><strong>Resolution notes:</strong> ${esc(
                  complaint.resolution_notes
                )}</div>`
              : ""
          }
          ${
            complaint.latitude && complaint.longitude
              ? `<div class="map-wrapper small-map"><div id="complaint-detail-map"></div></div>
                 <p class="map-help mono">Pin: ${esc(complaint.latitude)}, ${esc(complaint.longitude)}</p>`
              : ""
          }
        </div>
        <div>
          <h4 class="subsection-title">Progress</h4>
          ${renderTimeline(data.timeline)}
          <h4 class="subsection-title">Updates</h4>
          ${renderNotes(data.notes)}
          <h4 class="subsection-title">Evidence</h4>
          <div class="evidence-grid" id="complaint-evidence">
            <p class="muted small">Loading files…</p>
          </div>
          ${renderFeedbackBlock(data)}
          ${renderReopenBlock(data)}
          ${renderDuplicateBlock(data)}
          ${isStaff() ? renderStaffActions(data) : ""}
        </div>
      </div>`;

    openModal({
      title: `Complaint ${complaint.reference_no}`,
      bodyHtml: bodyHtml,
      footerHtml: `<button type="button" class="secondary" data-action="close-modal">Close</button>`,
      wide: true
    });

    if (permissions.can_manage) populateStaffActionSelects(data);
    if (complaint.latitude && complaint.longitude) {
      initDetailMap(Number(complaint.latitude), Number(complaint.longitude));
    }
    loadComplaintEvidence(data.evidence);
  }

  function renderTimeline(timeline) {
    if (!timeline || !timeline.length) return emptyState("No status changes recorded yet.");
    return `<ol class="timeline">${timeline
      .map(
        (row) => `<li>
          <div class="timeline-time">${esc(fmtDateTime(row.changed_at))}</div>
          <div>${
            row.old_status ? `${esc(row.old_status)} &rarr; ` : ""
          }<strong>${esc(row.new_status)}</strong>${
            row.changed_by ? ` <span class="muted small">by ${esc(row.changed_by)}</span>` : ""
          }</div>
          ${row.remarks ? `<div class="muted small">${esc(row.remarks)}</div>` : ""}
        </li>`
      )
      .join("")}</ol>`;
  }

  function renderNotes(notes) {
    if (!notes || !notes.length) return emptyState("No updates have been posted yet.");
    return `<ul class="note-list">${notes
      .map(
        (note) => `<li class="note-${esc(note.visibility)}">
          <div class="record-meta">
            <strong>${esc(note.author_name || "Municipal staff")}</strong>
            <span class="muted small">${esc(fmtDateTime(note.created_at))}</span>
            ${
              note.visibility === "internal"
                ? '<span class="type-badge type-internal">Internal only</span>'
                : ""
            }
          </div>
          <div>${esc(note.note)}</div>
        </li>`
      )
      .join("")}</ul>`;
  }

  function renderFeedbackBlock(data) {
    const complaint = data.complaint;
    if (data.feedback) {
      return `<h4 class="subsection-title">Citizen feedback</h4>
        <div class="detail-field">Rating: <strong>${esc(data.feedback.rating)} / 5</strong>
          ${
            data.feedback.was_resolved
              ? '<span class="status-tag status-resolved">Citizen confirms resolved</span>'
              : '<span class="priority-tag priority-high">Citizen says not resolved</span>'
          }
        </div>
        ${data.feedback.comments ? `<p>${esc(data.feedback.comments)}</p>` : ""}
        <p class="muted small">Recorded ${esc(fmtDateTime(data.feedback.created_at))}</p>`;
    }
    if (data.permissions && data.permissions.can_submit_feedback) {
      return `<h4 class="subsection-title">Share your feedback</h4>
        <form id="feedback-form" data-complaint="${complaint.id}" class="action-panel">
          <div class="form-group">
            <label for="feedback-rating">How satisfied are you? (1 = very poor, 5 = excellent)</label>
            <select id="feedback-rating" name="rating">
              <option value="5">5 — Excellent</option>
              <option value="4">4 — Good</option>
              <option value="3">3 — Acceptable</option>
              <option value="2">2 — Poor</option>
              <option value="1">1 — Very poor</option>
            </select>
          </div>
          <div class="form-group">
            <label class="inline-check">
              <input type="checkbox" id="feedback-resolved" name="was_resolved" checked />
              The issue was actually resolved
            </label>
          </div>
          <div class="form-group">
            <label for="feedback-comments">Comments (optional)</label>
            <textarea id="feedback-comments" name="comments" rows="3" maxlength="1000"></textarea>
          </div>
          <button type="submit" class="primary small">Submit feedback</button>
        </form>`;
    }
    return "";
  }

  function renderReopenBlock(data) {
    const requests = data.reopen_requests || [];
    const list = requests.length
      ? `<ul class="plain-list">${requests
          .map(
            (row) => `<li>
              <span class="status-tag status-${esc(slug(row.status))}">${esc(row.status)}</span>
              ${esc(row.reason)}
              <span class="muted small">${esc(fmtDateTime(row.created_at))}</span>
              ${row.review_notes ? `<div class="muted small">Review note: ${esc(row.review_notes)}</div>` : ""}
            </li>`
          )
          .join("")}</ul>`
      : "";

    const pending = requests.find((row) => row.status === "pending");

    if (isStaff() && pending) {
      return `<h4 class="subsection-title">Reopening requests</h4>
        ${list}
        <form id="reopen-review-form" data-complaint="${data.complaint.id}" data-request="${pending.id}" class="action-panel">
          <div class="form-group">
            <label for="reopen-decision">Decision on the pending request</label>
            <select id="reopen-decision" name="decision">
              <option value="approve">Approve reopening</option>
              <option value="reject">Decline reopening</option>
            </select>
          </div>
          <div class="form-group">
            <label for="reopen-notes">Notes for the citizen</label>
            <input id="reopen-notes" name="notes" maxlength="1000" />
          </div>
          <button type="submit" class="primary small">Record decision</button>
        </form>`;
    }

    const canRequest = data.permissions && data.permissions.can_request_reopen;
    return `<h4 class="subsection-title">Reopening</h4>
      ${list || `<p class="muted small">No reopening requests have been made.</p>`}
      ${
        canRequest
          ? `<form id="reopen-request-form" data-complaint="${data.complaint.id}" class="action-panel">
              <div class="form-group">
                <label for="reopen-reason">Not satisfied? Request a reopening (minimum 10 characters)</label>
                <textarea id="reopen-reason" name="reason" rows="3" maxlength="1000"></textarea>
              </div>
              <button type="submit" class="secondary small">Send reopening request</button>
            </form>`
          : ""
      }`;
  }

  function renderDuplicateBlock(data) {
    const rows = data.duplicates || [];
    if (!rows.length) return "";
    return `<h4 class="subsection-title">Linked complaints</h4>
      <ul class="plain-list">${rows
        .map(
          (row) => `<li>
            <span class="mono">${esc(row.duplicate_reference)}</span>
            <span class="muted small">(${esc(row.status)}${
              row.similarity ? `, ${Math.round(row.similarity * 100)}% similar` : ""
            })</span>
            ${row.reason ? ` — ${esc(row.reason)}` : ""}
          </li>`
        )
        .join("")}</ul>`;
  }

  function renderStaffActions(data) {
    const complaint = data.complaint;
    const allowed = STATUS_TRANSITIONS[complaint.status] || [];
    const escalations = data.escalations || [];

    return `
      <h4 class="subsection-title">Staff actions</h4>
      ${
        allowed.length
          ? `<form id="staff-status-form" data-complaint="${complaint.id}" class="action-panel">
              <div class="form-row two">
                <div class="form-group">
                  <label for="staff-status">Move to status</label>
                  <select id="staff-status" name="status">
                    ${allowed.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
                  </select>
                </div>
                <div class="form-group">
                  <label for="staff-remarks">Remarks (optional)</label>
                  <input id="staff-remarks" name="remarks" maxlength="1000" />
                </div>
              </div>
              <div class="form-group">
                <label for="staff-resolution-notes">Resolution notes (required before resolving, minimum 15 characters)</label>
                <textarea id="staff-resolution-notes" name="resolution_notes" rows="2" maxlength="3000"></textarea>
              </div>
              <div class="form-group">
                <label for="staff-rejection-reason">Rejection reason (required before rejecting, minimum 10 characters)</label>
                <input id="staff-rejection-reason" name="rejection_reason" maxlength="1000" />
              </div>
              <button type="submit" class="primary small">Update status</button>
            </form>`
          : `<p class="muted small">No further status changes are available from "${esc(complaint.status)}".</p>`
      }

      <form id="staff-assign-form" data-complaint="${complaint.id}" class="action-panel">
        <div class="form-row two">
          <div class="form-group">
            <label for="staff-assign-department">Department</label>
            <select id="staff-assign-department" name="department_id"></select>
          </div>
          <div class="form-group">
            <label for="staff-assign-officer">Officer</label>
            <select id="staff-assign-officer" name="assigned_user_id"></select>
          </div>
        </div>
        <div class="form-group">
          <label for="staff-assign-note">Assignment note (optional)</label>
          <input id="staff-assign-note" name="note" maxlength="500" />
        </div>
        <button type="submit" class="primary small">Assign complaint</button>
      </form>

      <form id="staff-priority-form" data-complaint="${complaint.id}" class="action-panel">
        <div class="form-row two">
          <div class="form-group">
            <label for="staff-priority">Priority (server validated)</label>
            <select id="staff-priority" name="priority">
              ${PRIORITIES.map(
                (p) => `<option value="${p}" ${p === complaint.priority ? "selected" : ""}>${esc(p)}</option>`
              ).join("")}
            </select>
          </div>
          <div class="form-group">
            <label>&nbsp;</label>
            <button type="submit" class="secondary small">Save priority</button>
          </div>
        </div>
      </form>

      <form id="staff-note-form" data-complaint="${complaint.id}" class="action-panel">
        <div class="form-group">
          <label for="staff-note">Add an update</label>
          <textarea id="staff-note" name="note" rows="2" maxlength="2000"></textarea>
        </div>
        <div class="form-row two">
          <div class="form-group">
            <label for="staff-note-visibility">Visibility</label>
            <select id="staff-note-visibility" name="visibility">
              <option value="citizen">Visible to the citizen</option>
              <option value="internal">Internal note (staff only)</option>
            </select>
          </div>
          <div class="form-group">
            <label>&nbsp;</label>
            <button type="submit" class="secondary small">Add update</button>
          </div>
        </div>
      </form>

      <form id="staff-evidence-form" data-complaint="${complaint.id}" class="action-panel">
        <div class="form-group">
          <label for="staff-evidence">Upload resolution evidence (photos or video)</label>
          <input id="staff-evidence" name="image" type="file" multiple
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" />
        </div>
        <button type="submit" class="secondary small">Upload evidence</button>
      </form>

      <form id="staff-duplicate-form" data-complaint="${complaint.id}" class="action-panel">
        <div class="form-group">
          <label for="staff-duplicate-reference">Link as a duplicate of (reference number)</label>
          <input id="staff-duplicate-reference" name="reference" placeholder="CMP-2026-000123" />
        </div>
        <div class="form-group">
          <label for="staff-duplicate-reason">Reason (optional)</label>
          <input id="staff-duplicate-reason" name="reason" maxlength="500" />
        </div>
        <button type="submit" class="secondary small">Link duplicate</button>
      </form>

      ${
        escalations.length
          ? `<h4 class="subsection-title">Escalations</h4>
             <ul class="plain-list">${escalations
               .map(
                 (row) => `<li>Level ${esc(row.level)} — ${esc(row.reason || "")}
                   <span class="muted small">${esc(fmtDateTime(row.created_at))}${
                     row.acknowledged_at ? " · acknowledged" : ""
                   }</span></li>`
               )
               .join("")}</ul>`
          : ""
      }
      <div id="modal-action-error" class="error-message" role="alert"></div>`;
  }

  async function populateStaffActionSelects(data) {
    const complaint = data.complaint;
    const departmentSelect = $("#staff-assign-department");
    try {
      await loadStaffUsers();
    } catch (error) {
      console.error(error);
    }
    if (departmentSelect) {
      departmentSelect.innerHTML = staffDepartmentOptions("Keep the current department", complaint.department_id);
      departmentSelect.addEventListener("change", () => refreshOfficerOptions(null));
    }
    refreshOfficerOptions(complaint.assigned_user_id);
  }

  function staffDepartmentOptions(placeholder, selected) {
    const seen = new Map();
    for (const user of state.staffUsers) {
      if (user.department_id && user.department_name) seen.set(user.department_id, user.department_name);
    }
    const items = [];
    seen.forEach((name, id) => items.push({ id: id, name: name }));
    return optionsFrom(items, "id", "name", placeholder, selected);
  }

  function refreshOfficerOptions(selected) {
    const departmentSelect = $("#staff-assign-department");
    const officerSelect = $("#staff-assign-officer");
    if (!officerSelect) return;
    const departmentId = departmentSelect && departmentSelect.value ? Number(departmentSelect.value) : null;
    const rows = state.staffUsers.filter((user) => user.role === "staff" || user.role === "admin");
    const filtered = departmentId
      ? rows.filter((user) => !user.department_id || user.department_id === departmentId)
      : rows;
    officerSelect.innerHTML = `<option value="">Unassigned</option>${filtered
      .map(
        (user) => `<option value="${user.id}" ${
          String(selected) === String(user.id) ? "selected" : ""
        }>${esc(user.name)}${user.department_name ? ` — ${esc(user.department_name)}` : ""}</option>`
      )
      .join("")}`;
  }

  // Read-only pin for a stored record. Both the complaint and the application
  // detail views use it, so the container is selectable.
  function initDetailMap(lat, lng, containerSelector) {
    const element = $(containerSelector || "#complaint-detail-map");
    if (!element || typeof L === "undefined") return;
    if (state.detailMap) {
      state.detailMap.remove();
      state.detailMap = null;
    }
    const map = L.map(element, { center: [lat, lng], zoom: 15, scrollWheelZoom: false });
    L.tileLayer(TILE_URL, TILE_LAYER_OPTIONS).addTo(map);
    L.marker([lat, lng]).addTo(map);
    state.detailMap = map;
    setTimeout(() => map.invalidateSize(), 80);
  }

  async function loadComplaintEvidence(evidence) {
    const container = $("#complaint-evidence");
    if (!container) return;
    if (!evidence || !evidence.length) {
      container.innerHTML = `<p class="muted small">No files are attached to this complaint.</p>`;
      return;
    }
    container.innerHTML = evidence
      .map(
        (file) => `<div class="evidence-item">
          <div class="evidence-name">${esc(file.name || "Attachment")}
            <span class="muted small">${esc(file.kind)}${
              file.size_bytes ? ` · ${Math.max(1, Math.round(file.size_bytes / 1024))} KB` : ""
            }</span>
          </div>
          <div class="evidence-body" data-evidence="${esc(file.url)}" data-mime="${esc(
          file.mime_type || ""
        )}"></div>
        </div>`
      )
      .join("");

    for (const node of $$("[data-evidence]", container)) {
      const url = node.getAttribute("data-evidence");
      const mime = node.getAttribute("data-mime") || "";
      try {
        const objectUrl = await loadPrivateFile(url);
        if (mime.indexOf("image/") === 0) {
          node.innerHTML = `<img src="${objectUrl}" alt="Complaint evidence" loading="lazy" />`;
        } else if (mime.indexOf("video/") === 0) {
          node.innerHTML = `<video src="${objectUrl}" controls preload="metadata"></video>`;
        } else {
          const link = document.createElement("a");
          link.href = objectUrl;
          link.target = "_blank";
          link.rel = "noopener";
          link.className = "link-button";
          link.textContent = "Open file";
          node.appendChild(link);
        }
      } catch (error) {
        node.innerHTML = `<span class="muted small">File unavailable</span>`;
      }
    }
  }

  function refreshCurrentView() {
    const route = currentRoute();
    if (route === "staff") renderStaff();
    else if (route === "dashboard") renderDashboard();
    else if (route === "complaints") loadMyComplaints();
  }

  function modalError(message) {
    const node = $("#modal-action-error");
    if (node) node.textContent = message;
    toast(message, "error");
  }

  /* =========================================================================
   * 13. Track a record by reference number
   * ========================================================================= */
  async function renderTrack() {
    const result = $("#track-result");
    if (result) result.innerHTML = "";
    const input = $("#track-reference");
    if (input) {
      input.value = "";
      input.focus();
    }
  }

  async function trackReference() {
    const input = $("#track-reference");
    const container = $("#track-result");
    if (!container) return;
    const reference = input ? input.value.trim() : "";
    if (!reference) {
      toast("Enter a reference number to look it up.", "warning");
      return;
    }
    if (!state.user) {
      container.innerHTML = `<p class="empty-state">
          Tracking is limited to records filed from your own account. Please sign in to look up
          your complaint or application.
        </p>
        <button type="button" class="primary small" data-route="login">Sign in</button>`;
      return;
    }

    container.innerHTML = `<p class="loading-text">Looking up ${esc(reference)}…</p>`;
    const wanted = reference.toUpperCase();

    try {
      const complaints = await api(
        `/api/complaints?search=${encodeURIComponent(reference)}&limit=10`
      );
      const rows = (complaints && complaints.items) || [];
      const match =
        rows.find((row) => String(row.reference_no).toUpperCase() === wanted) || rows[0] || null;
      if (match) {
        container.innerHTML = trackComplaintCard(match);
        return;
      }

      const applications = await api(
        `/api/services/applications?search=${encodeURIComponent(reference)}&limit=10`
      );
      const appRows = (applications && applications.items) || [];
      const appMatch =
        appRows.find((row) => String(row.reference_no).toUpperCase() === wanted) ||
        appRows[0] ||
        null;
      if (appMatch) {
        container.innerHTML = trackApplicationCard(appMatch);
        return;
      }

      container.innerHTML = `<p class="empty-state">
          No record with reference ${esc(reference)} was found in your account. Check the number
          printed on your acknowledgement, or open your dashboard to see all of your records.
        </p>
        <button type="button" class="secondary small" data-route="dashboard">Open my dashboard</button>`;
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  function trackComplaintCard(row) {
    return `<div class="track-card">
      <div class="record-meta">
        <span class="mono">${esc(row.reference_no)}</span>
        ${statusTag(row.status)}
        ${priorityTag(row.priority)}
      </div>
      <h4 class="subsection-title">${esc(row.title)}</h4>
      ${detailField("Category", esc(row.category_name || "Uncategorised"))}
      ${detailField("Issue type", esc(row.subcategory_name || "Not specified"))}
      ${detailField("Department", esc(row.department_name || "Awaiting routing"))}
      ${detailField("Officer", esc(row.assigned_user_name || "Not assigned"))}
      ${detailField("Filed", esc(fmtDateTime(row.created_at)))}
      ${detailField(
        "Target date",
        `${esc(fmtDateTime(row.due_at))}${
          row.is_overdue ? ' <span class="overdue-flag">Past target date</span>' : ""
        }`
      )}
      ${row.resolved_at ? detailField("Resolved", esc(fmtDateTime(row.resolved_at))) : ""}
      <div class="record-actions">
        <button type="button" class="primary small" data-action="open-complaint" data-id="${
          row.id
        }">Open full details</button>
      </div>
    </div>`;
  }

  function trackApplicationCard(row) {
    return `<div class="track-card">
      <div class="record-meta">
        <span class="mono">${esc(row.reference_no)}</span>
        ${statusTag(row.status)}
      </div>
      <h4 class="subsection-title">${esc(row.subcategory_name || "Service application")}</h4>
      ${detailField("Applicant", esc(row.applicant_name || ""))}
      ${detailField("Department", esc(row.department_name || "Awaiting routing"))}
      ${detailField("Submitted", esc(fmtDateTime(row.created_at)))}
      ${row.reviewer_note ? detailField("Department note", esc(row.reviewer_note)) : ""}
      <div class="record-actions">
        <button type="button" class="primary small" data-action="open-application" data-id="${
          row.id
        }">Open full details</button>
      </div>
    </div>`;
  }

  /* =========================================================================
   * 14. Authentication
   * ========================================================================= */
  // Three ways in. The portal authenticates everyone through the same endpoint —
  // the tabs exist so an officer or administrator is not left wondering which
  // door to use, and so their landing page matches the account they picked.
  const LOGIN_TABS = [
    {
      key: "citizen",
      label: "Citizen",
      heading: "Citizen sign in",
      hint: "Sign in with the email address you registered to file complaints and follow their progress."
    },
    {
      key: "officer",
      label: "Officer",
      heading: "Service desk sign in",
      hint: "For municipal officers. You land on the service desk, where complaints are assigned, progressed and resolved."
    },
    {
      key: "admin",
      label: "Administrator",
      heading: "Administrator sign in",
      hint: "For administrators. You land on the administration console: every complaint, task assignment, staff accounts, email alerts and the audit trail."
    }
  ];

  function loginLanding(user) {
    if (!user) return "dashboard";
    if (user.role === "admin") return "admin";
    if (user.role === "staff") return "staff";
    return "dashboard";
  }

  async function renderLogin() {
    const error = $("#login-error");
    if (error) error.textContent = "";
    const button = $("#login-submit");
    if (button) {
      button.disabled = false;
      button.textContent = "Sign in";
    }

    const tab = LOGIN_TABS.find((row) => row.key === state.loginTab) || LOGIN_TABS[0];
    renderTabBar($("#login-tabs"), LOGIN_TABS, tab.key, "login-tab");
    const heading = $("#login-heading");
    if (heading) heading.textContent = tab.heading;
    const hint = $("#login-hint");
    if (hint) hint.textContent = tab.hint;

    await renderLoginDefaults();
  }

  /**
   * Lists the accounts the portal seeds on first start, so nobody has to read the
   * source to find a way in. Passwords are only published while they are still the
   * configured defaults; the server withholds them once they are changed, and the
   * whole card is hidden in production.
   */
  async function renderLoginDefaults() {
    const card = $("#login-defaults-card");
    const container = $("#login-defaults");
    if (!card || !container) return;

    try {
      state.loginDefaults = await api("/api/auth/default-accounts");
    } catch (error) {
      state.loginDefaults = { enabled: false, accounts: [] };
    }

    const accounts = (state.loginDefaults && state.loginDefaults.accounts) || [];
    if (!state.loginDefaults || !state.loginDefaults.enabled || !accounts.length) {
      card.hidden = true;
      container.innerHTML = "";
      return;
    }

    card.hidden = false;
    container.innerHTML = accounts
      .map(
        (account) => `<div class="default-account">
          <div class="default-account-head">
            <strong>${esc(account.label)}</strong>
            <span class="pill">${esc(account.role)}</span>
          </div>
          <dl class="default-account-fields">
            <dt>Email</dt>
            <dd class="mono">${esc(account.email)}</dd>
            <dt>Password</dt>
            <dd class="mono">${
              account.password ? esc(account.password) : '<span class="muted">no longer the default</span>'
            }</dd>
          </dl>
          ${
            account.password
              ? `<button type="button" class="secondary small" data-action="login-fill" data-id="${esc(
                  account.email
                )}">Use these credentials</button>`
              : `<p class="muted small">The password for this account has been changed, so it is not published here.</p>`
          }
        </div>`
      )
      .join("");
  }

  function fillLoginCredentials(email, password) {
    const emailField = $("#login-email");
    const passwordField = $("#login-password");
    if (emailField) emailField.value = email;
    if (passwordField) passwordField.value = password;
    const errorNode = $("#login-error");
    if (errorNode) errorNode.textContent = "";
    if (passwordField) passwordField.focus();
  }

  async function handleLogin(event) {
    event.preventDefault();
    const emailField = $("#login-email");
    const passwordField = $("#login-password");
    const errorNode = $("#login-error");
    const button = $("#login-submit");
    const email = emailField ? emailField.value.trim() : "";
    const password = passwordField ? passwordField.value : "";

    if (errorNode) errorNode.textContent = "";
    if (!email || !password) {
      if (errorNode) errorNode.textContent = "Enter your email address and password.";
      return;
    }
    if (button) {
      button.disabled = true;
      button.textContent = "Signing in…";
    }

    try {
      const data = await api("/api/auth/login", { method: "POST", body: { email, password } });
      setSession(data.token, data.user);
      toast(`Signed in as ${data.user.name}.`, "success");
      navigate(loginLanding(data.user));
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Sign in";
      }
    }
  }

  async function renderRegister() {
    const error = $("#register-error");
    if (error) error.textContent = "";
    const button = $("#register-submit");
    if (button) {
      button.disabled = false;
      button.textContent = "Create account";
    }
    try {
      await loadWards();
    } catch (err) {
      console.error(err);
    }
    fillWardSelect($("#register-ward"), "Not sure", "");
  }

  async function handleRegister(event) {
    event.preventDefault();
    const errorNode = $("#register-error");
    const button = $("#register-submit");
    const payload = {
      name: $("#register-name") ? $("#register-name").value.trim() : "",
      email: $("#register-email") ? $("#register-email").value.trim() : "",
      phone: $("#register-phone") ? $("#register-phone").value.trim() : "",
      ward_id: $("#register-ward") && $("#register-ward").value ? Number($("#register-ward").value) : null,
      password: $("#register-password") ? $("#register-password").value : ""
    };

    if (errorNode) errorNode.textContent = "";
    if (payload.name.length < 3) {
      if (errorNode) errorNode.textContent = "Enter your full name (at least 3 characters).";
      return;
    }
    if (!payload.email) {
      if (errorNode) errorNode.textContent = "Enter your email address.";
      return;
    }
    if (payload.password.length < 6) {
      if (errorNode) errorNode.textContent = "Choose a password of at least 6 characters.";
      return;
    }
    if (!payload.phone) delete payload.phone;
    if (!payload.ward_id) delete payload.ward_id;

    if (button) {
      button.disabled = true;
      button.textContent = "Creating account…";
    }

    try {
      const data = await api("/api/auth/register", { method: "POST", body: payload });
      setSession(data.token, data.user);
      toast("Your citizen account has been created.", "success");
      const form = $("#register-form");
      if (form) form.reset();
      navigate("dashboard");
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Create account";
      }
    }
  }

  function handleLogout() {
    clearSession();
    closeModal();
    toast("You have been signed out.", "info");
    navigate("home");
  }

  /* =========================================================================
   * 15. Citizen services portal
   * ========================================================================= */
  async function renderServices() {
    await loadTaxonomy();
    try {
      await loadWards();
    } catch (error) {
      console.error(error);
    }
    await renderServiceList();
    await renderOffices($("#services-offices"));
    await renderAnnouncements($("#services-announcements"), 6);
  }

  async function renderServiceList() {
    const container = $("#services-list");
    if (!container) return;
    const taxonomy = state.taxonomy;
    if (!taxonomy) return;

    const kindSelect = $("#service-filter-kind");
    const searchInput = $("#service-search");
    const kind = kindSelect ? kindSelect.value : "";
    const term = searchInput ? searchInput.value.trim().toLowerCase() : "";

    const groups = [];
    for (const category of taxonomy.categories) {
      const subs = (category.subcategories || []).filter((sub) => {
        if (kind && sub.item_type !== kind) return false;
        if (!term) return true;
        const haystack = [sub.name, sub.summary, sub.processing_time, sub.department_name]
          .concat(sub.checklist || [])
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.indexOf(term) !== -1;
      });
      if (subs.length) groups.push({ category: category, subs: subs });
    }

    if (!groups.length) {
      container.innerHTML = emptyState("No services match the selected filter.");
      return;
    }

    container.innerHTML = groups.map(serviceGroupHtml).join("");

    if (state.serviceFocus) {
      const id = state.serviceFocus;
      state.serviceFocus = null;
      const node = document.getElementById(`service-group-${id}`);
      if (node) {
        node.classList.add("focused");
        node.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }

  function serviceGroupHtml(group) {
    const category = group.category;
    return `<section class="service-group" id="service-group-${category.id}">
      <div class="section-heading compact">
        <h3>${esc(category.name)}</h3>
        ${category.description ? `<p class="muted small">${esc(category.description)}</p>` : ""}
      </div>
      <div class="service-grid">${group.subs.map(serviceCardHtml).join("")}</div>
    </section>`;
  }

  function serviceActionHtml(sub, tone) {
    const classes = tone === "primary" ? "primary small" : "secondary small";
    if (sub.item_type === "application") {
      return `<button type="button" class="${classes}" data-action="start-application" data-sub="${sub.id}">Start application</button>`;
    }
    if (sub.item_type === "complaint") {
      return `<button type="button" class="${classes}" data-action="start-complaint" data-sub="${sub.id}" data-category="${sub.category_id}">Report an issue</button>`;
    }
    return `<button type="button" class="${classes}" data-action="open-service" data-sub="${sub.id}">View guidance</button>`;
  }

  function serviceCardHtml(sub) {
    return `<article class="service-card">
      <div class="service-card-head">
        <h4>${esc(sub.name)}</h4>
        ${typeBadge(sub.item_type)}
      </div>
      ${sub.summary ? `<p class="muted">${esc(sub.summary)}</p>` : ""}
      <div class="record-meta muted small">
        ${
          sub.department_name
            ? `<span>${esc(sub.department_name)}</span>`
            : '<span>Department to be confirmed</span>'
        }
        ${sub.processing_time ? `<span>&middot; ${esc(sub.processing_time)}</span>` : ""}
      </div>
      <div class="record-actions">
        ${serviceActionHtml(sub, "secondary")}
        <button type="button" class="link-button" data-action="open-service" data-sub="${
          sub.id
        }">Service details</button>
      </div>
    </article>`;
  }

  function openServiceDetail(subId) {
    const sub = state.taxonomy ? state.taxonomy.subById.get(Number(subId)) : null;
    if (!sub) {
      toast("Service details are not available right now.", "warning");
      return;
    }
    const checklist = (sub.checklist || []).length
      ? `<h4 class="subsection-title">Please have ready</h4>
         <ul class="checklist">${sub.checklist.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
      : "";
    const guidance =
      sub.item_type === "information"
        ? `<div class="alert alert-info">
             This is an information service. It cannot be filed online through this portal. Follow the
             guidance below or use the authorised official link.
           </div>
           ${
             sub.official_url
               ? `<p><a class="link-button" href="${esc(sub.official_url)}" target="_blank" rel="noopener">
                    Open the official page
                  </a></p>
                  <p class="map-help">External links open the department's own official page. This portal
                  does not issue certificates or approvals.</p>`
               : `<p class="map-help">No online facility is available for this service. Please visit the
                  municipal office listed in the Contact section.</p>`
           }`
        : "";

    openModal({
      title: sub.name,
      bodyHtml: `<div class="record-meta">${typeBadge(sub.item_type)}
          ${
            sub.department_name
              ? `<span class="muted small">Handled by ${esc(sub.department_name)}</span>`
              : ""
          }
        </div>
        ${sub.summary ? `<p>${esc(sub.summary)}</p>` : ""}
        ${detailField("Handling time", esc(sub.processing_time || "Not published"))}
        ${detailField("Category", esc(sub.category_name || ""))}
        ${sub.item_type === "complaint" ? detailField("Priority if reported", esc(sub.default_priority || "medium")) : ""}
        ${checklist}
        ${guidance}
        <div id="modal-action-error" class="error-message" role="alert"></div>`,
      footerHtml: `${serviceActionHtml(sub, "primary")}
        <button type="button" class="secondary" data-action="close-modal">Close</button>`,
      wide: true
    });
  }

  function openApplicationForm(subId) {
    const sub = state.taxonomy ? state.taxonomy.subById.get(Number(subId)) : null;
    if (!sub) {
      toast("Service details are not available right now.", "warning");
      return;
    }
    if (!state.user) {
      requireLogin("services");
      return;
    }
    const user = state.user;
    const wardOptions = optionsFrom(state.wards, "id", "name", "Not sure", user.ward_id || "");

    openModal({
      title: `Apply: ${esc(sub.name)}`,
      bodyHtml: `<p class="muted small">
          Submit your application here. A reference number (APP-…) is issued immediately and you can
          track the status in your dashboard.
        </p>
        <form id="application-form" data-sub="${sub.id}">
          <div class="form-group">
            <label for="application-name">Applicant name *</label>
            <input id="application-name" name="applicant_name" required maxlength="120" value="${esc(
              user.name || ""
            )}" />
          </div>
          <div class="form-row two">
            <div class="form-group">
              <label for="application-email">Email</label>
              <input id="application-email" name="contact_email" type="email" maxlength="160" value="${esc(
                user.email || ""
              )}" />
            </div>
            <div class="form-group">
              <label for="application-phone">Phone</label>
              <input id="application-phone" name="contact_phone" maxlength="20" value="${esc(
                user.phone || ""
              )}" />
            </div>
          </div>
          <div class="form-row two">
            <div class="form-group">
              <label for="application-address">Address</label>
              <input id="application-address" name="address_text" maxlength="400" value="${esc(
                user.address || ""
              )}" />
            </div>
            <div class="form-group">
              <label for="application-ward">Ward</label>
              <select id="application-ward" name="ward_id">${wardOptions}</select>
            </div>
          </div>
          <fieldset class="fieldset">
            <legend>Location pin (optional)</legend>
            <p class="map-help">
              Click the map to place a pin for the address concerned, or use your device location.
            </p>
            <div class="map-wrapper">
              <div id="application-map" role="application" aria-label="Application location map"></div>
            </div>
            <div class="map-controls">
              <button type="button" class="secondary small" data-action="use-my-location"
                data-map-target="application">Use my current location</button>
              <button type="button" class="secondary small" data-action="clear-pin"
                data-map-target="application">Clear pin</button>
              <span class="map-help mono" id="application-pin-readout">No pin placed.</span>
            </div>
            <input type="hidden" id="application-latitude" name="latitude" />
            <input type="hidden" id="application-longitude" name="longitude" />
          </fieldset>
          <div class="form-group">
            <label for="application-details">Details of your request * (minimum 15 characters)</label>
            <textarea id="application-details" name="details" rows="4" maxlength="4000" required></textarea>
          </div>
          <div class="form-group">
            <label for="application-documents">Supporting documents (optional, up to 5 files, 10 MB each)</label>
            <input id="application-documents" name="documents" type="file" multiple
              accept="image/jpeg,image/png,image/webp,application/pdf" />
          </div>
          <div id="application-error" class="error-message" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="primary">Submit application</button>
            <button type="button" class="secondary" data-action="close-modal">Cancel</button>
          </div>
        </form>`,
      wide: true
    });
    // The modal is in the DOM now, so Leaflet has a measurable container.
    ensureMap("application");
  }

  async function submitApplication(form) {
    const errorNode = $("#application-error");
    const button = $("button[type='submit']", form);
    const name = $("#application-name").value.trim();
    const details = $("#application-details").value.trim();

    if (errorNode) errorNode.textContent = "";
    if (name.length < 3) {
      if (errorNode) errorNode.textContent = "Enter the applicant name.";
      return;
    }
    if (details.length < 15) {
      if (errorNode) errorNode.textContent = "Describe your request in at least 15 characters.";
      return;
    }

    const payload = new FormData();
    payload.append("subcategory_id", form.getAttribute("data-sub"));
    payload.append("applicant_name", name);
    payload.append("details", details);
    const email = $("#application-email").value.trim();
    const phone = $("#application-phone").value.trim();
    const address = $("#application-address").value.trim();
    const ward = $("#application-ward").value;
    if (email) payload.append("contact_email", email);
    if (phone) payload.append("contact_phone", phone);
    if (address) payload.append("address_text", address);
    if (ward) payload.append("ward_id", ward);
    const latField = $("#application-latitude");
    const lngField = $("#application-longitude");
    if (latField && latField.value) payload.append("latitude", latField.value);
    if (lngField && lngField.value) payload.append("longitude", lngField.value);
    const documents = $("#application-documents");
    if (documents) for (const file of documents.files) payload.append("documents", file);

    if (button) {
      button.disabled = true;
      button.textContent = "Submitting…";
    }

    try {
      const data = await api("/api/services/applications", { method: "POST", form: payload });
      const application = data.application || {};
      openModal({
        title: "Application submitted",
        bodyHtml: `<p>${esc(data.message || "Your application has been received.")}</p>
          <p class="reference-block">Reference number
            <strong class="mono">${esc(application.reference_no || "")}</strong>
          </p>
          ${detailField("Service", esc(application.subcategory_name || ""))}
          ${detailField("Category", esc(application.category_name || ""))}
          ${detailField("Status", statusTag(application.status))}`,
        footerHtml: `<button type="button" class="secondary" data-action="close-modal">Close</button>
          <button type="button" class="primary" data-route="dashboard">Open my dashboard</button>`
      });
      toast("Application submitted successfully.", "success");
      refreshNotificationCount();
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
      toast(error.message, "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Submit application";
      }
    }
  }

  async function openApplicationDetail(id) {
    if (!state.user) {
      requireLogin();
      return;
    }
    let data;
    try {
      data = await api(`/api/services/applications/${id}`);
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    renderApplicationDetail(data);
  }

  function renderApplicationDetail(data) {
    const application = data.application || {};
    const documents = data.documents || [];
    const history = data.history || [];

    const documentList = documents.length
      ? `<ul class="document-list">${documents
          .map(
            (doc) => `<li class="document-row">
              <div>
                <div>${esc(doc.name || "Document")}</div>
                <div class="muted small">${esc(fmtDateTime(doc.created_at))}</div>
              </div>
              <button type="button" class="link-button" data-action="open-document" data-url="${esc(
                doc.url
              )}" data-mime="${esc(doc.mime_type || "")}">Open</button>
            </li>`
          )
          .join("")}</ul>`
      : `<p class="muted small">No supporting documents were attached.</p>`;

    const historyHtml = history.length
      ? `<ol class="timeline">${history
          .map(
            (row) => `<li>
              <div class="timeline-time">${esc(fmtDateTime(row.changed_at))}</div>
              <div>${row.old_status ? `${esc(row.old_status)} &rarr; ` : ""}<strong>${esc(
                row.new_status
              )}</strong>${
                row.changed_by ? ` <span class="muted small">by ${esc(row.changed_by)}</span>` : ""
              }</div>
            </li>`
          )
          .join("")}</ol>`
      : emptyState("No status changes recorded yet.");

    const staffForm = isStaff()
      ? `<h4 class="subsection-title">Department review</h4>
         <form id="application-status-form" data-id="${application.id}" class="action-panel">
           <div class="form-row two">
             <div class="form-group">
               <label for="application-status">Move to status</label>
               <select id="application-status" name="status">
                 ${APPLICATION_STATUSES.map(
                   (status) =>
                     `<option value="${status}" ${
                       status === application.status ? "selected" : ""
                     }>${status}</option>`
                 ).join("")}
               </select>
             </div>
             <div class="form-group">
               <label for="application-reviewer-note">Reviewer note (required when rejecting)</label>
               <input id="application-reviewer-note" name="reviewer_note" maxlength="2000" />
             </div>
           </div>
           <button type="submit" class="primary small">Update application</button>
         </form>`
      : "";

    openModal({
      title: `Application ${application.reference_no || ""}`,
      bodyHtml: `<div class="detail-grid">
        <div>
          <div class="record-meta">
            <span class="mono">${esc(application.reference_no || "")}</span>
            ${statusTag(application.status)}
          </div>
          ${detailField("Service", esc(application.subcategory_name || ""))}
          ${detailField("Category", esc(application.category_name || ""))}
          ${detailField("Applicant", esc(application.applicant_name || ""))}
          ${detailField("Submitted", esc(fmtDateTime(application.created_at)))}
          ${detailField("Last updated", esc(fmtDateTime(application.updated_at)))}
          ${
            isStaff()
              ? detailField("Contact", esc([application.contact_email, application.contact_phone].filter(Boolean).join(" · ") || "Not provided"))
              : ""
          }
          ${application.address_text ? detailField("Address", esc(application.address_text)) : ""}
          ${
            application.latitude && application.longitude
              ? `<h4 class="subsection-title">Location pin</h4>
                 <div class="map-wrapper small-map"><div id="application-detail-map"></div></div>`
              : ""
          }
          ${
            application.reviewer_note
              ? `<div class="alert alert-info"><strong>Department note:</strong> ${esc(
                  application.reviewer_note
                )}</div>`
              : ""
          }
          <h4 class="subsection-title">Request details</h4>
          <p class="description-text">${esc(application.details || "")}</p>
        </div>
        <div>
          <h4 class="subsection-title">Progress</h4>
          ${historyHtml}
          <h4 class="subsection-title">Attached documents</h4>
          ${documentList}
          ${staffForm}
          <div id="modal-action-error" class="error-message" role="alert"></div>
        </div>
      </div>`,
      footerHtml: `<button type="button" class="secondary" data-action="close-modal">Close</button>`,
      wide: true
    });
    if (application.latitude && application.longitude) {
      initDetailMap(
        Number(application.latitude),
        Number(application.longitude),
        "#application-detail-map"
      );
    }
  }

  async function updateApplicationStatus(form) {
    const id = form.getAttribute("data-id");
    const status = $("#application-status").value;
    const reviewerNote = $("#application-reviewer-note").value.trim();
    const payload = { status: status };
    if (reviewerNote) payload.reviewer_note = reviewerNote;

    try {
      const data = await api(`/api/services/applications/${id}/status`, {
        method: "PATCH",
        body: payload
      });
      toast(data.message || "Application updated.", "success");
      closeModal();
      refreshStaffTab();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function openPrivateDocument(url, mime) {
    try {
      const objectUrl = await loadPrivateFile(url);
      if (mime && mime.indexOf("image/") === 0) {
        openModal({
          title: "Document",
          bodyHtml: `<div class="evidence-body"><img src="${objectUrl}" alt="Application document" /></div>`,
          footerHtml: `<button type="button" class="secondary" data-action="close-modal">Close</button>`
        });
      } else {
        window.open(objectUrl, "_blank", "noopener");
      }
    } catch (error) {
      toast(error.message, "error");
    }
  }

  // ---------------------------------------------------------------------------
  // Payment Modals
  // ---------------------------------------------------------------------------

  async function openPaymentModal(billId, remainingAmount) {
    if (!state.user) {
      requireLogin();
      return;
    }
    try {
      const billData = await api(`/api/payments/bills/${billId}`);
      const bill = billData.bill;
      if (!bill) {
        toast("Bill not found", "error");
        return;
      }

      // Pre-populate amount with remaining due or passed amount
      const amount = Number(remainingAmount) || (bill.amount_due - bill.amount_paid);
      const typeLabel = {
        electricity: "⚡ Electricity",
        water: "💧 Water",
        property_tax: "🏠 Property Tax"
      }[bill.service_type] || bill.service_type;

      const modal = openModal({
        title: `Pay ${typeLabel} Bill`,
        wide: true,
        bodyHtml: `
          <div class="payment-modal">
            <div class="payment-summary">
              <div class="summary-row"><span>Account:</span> <strong>${esc(bill.account_number)}</strong></div>
              ${bill.bill_number ? `<div class="summary-row"><span>Bill No:</span> <strong>${esc(bill.bill_number)}</strong></div>` : ""}
              <div class="summary-row"><span>Period:</span> <strong>${esc(bill.billing_period_start)} to ${esc(bill.billing_period_end)}</strong></div>
              <div class="summary-row"><span>Total Due:</span> <strong>₹${esc((bill.amount_due / 100).toFixed(2))}</strong></div>
              <div class="summary-row"><span>Already Paid:</span> <strong>₹${esc((bill.amount_paid / 100).toFixed(2))}</strong></div>
              <div class="summary-row highlight"><span>Amount to Pay:</span> <strong>₹${esc((amount / 100).toFixed(2))}</strong></div>
              ${bill.due_date ? `<div class="summary-row"><span>Due Date:</span> <strong>${esc(fmtDate(bill.due_date))}</strong></div>` : ""}
              ${bill.provider_name ? `<div class="summary-row"><span>Provider:</span> <strong>${esc(bill.provider_name)}</strong></div>` : ""}
            </div>
            <form id="payment-form" class="payment-form">
              <div class="form-group">
                <label for="payment-amount">Amount (₹)</label>
                <input id="payment-amount" name="amount" type="number" step="0.01" min="1" max="${amount / 100}" value="${(amount / 100).toFixed(2)}" required />
                <p class="map-help">Minimum ₹1, maximum remaining due.</p>
              </div>
              <div id="payment-error" class="error-message" role="alert"></div>
              <button type="button" class="primary" id="payment-proceed-btn">Proceed to Payment</button>
              <button type="button" class="secondary" data-action="close-modal">Cancel</button>
            </form>
          </div>
        `,
        footerHtml: ""
      });

      // Handle form submission
      const form = $("#payment-form");
      if (form) {
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          await processPayment(billId, form);
        });
      }
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function processPayment(billId, form) {
    const errorNode = $("#payment-error");
    const btn = $("#payment-proceed-btn");
    const amountInput = $("#payment-amount");

    if (errorNode) errorNode.textContent = "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Creating order...";
    }

    try {
      const amountPaise = Math.round(Number(amountInput.value) * 100);

      // Create payment order
      const response = await api("/api/payments/orders", {
        method: "POST",
        body: { bill_id: billId, amount: amountPaise }
      });

      const { order, checkout, gateway, is_test_mode } = response;

      // Close current modal
      closeModal();

      // Open payment checkout
      await openPaymentCheckout(order, checkout, gateway, is_test_mode, billId);
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Proceed to Payment";
      }
    }
  }

  async function openPaymentCheckout(order, checkout, gateway, isTestMode, billId) {
    if (gateway === "demo" || checkout.__demo) {
      // Demo mode: show simulated payment UI
      const modal = openModal({
        title: "Demo Payment Gateway",
        wide: true,
        bodyHtml: `
          <div class="demo-payment">
            <div class="demo-notice">
              <h4>🧪 Demo / Test Mode</h4>
              <p>No real money will be charged. This simulates a payment gateway checkout.</p>
            </div>
            <div class="payment-details">
              <div class="detail-row"><span>Order ID:</span> <code>${esc(order.gateway_order_id)}</code></div>
              <div class="detail-row"><span>Amount:</span> <strong>₹${esc((order.amount / 100).toFixed(2))}</strong></div>
              <div class="detail-row"><span>Bill:</span> <code>${esc(order.notes?.bill_id || "")}</code></div>
            </div>
            <form id="demo-payment-form">
              <div class="form-group">
                <label>Payment Method</label>
                <select name="method" id="demo-method">
                  <option value="upi">UPI</option>
                  <option value="card">Credit/Debit Card</option>
                  <option value="netbanking">Net Banking</option>
                  <option value="wallet">Wallet</option>
                </select>
              </div>
              <div class="form-group">
                <label>Simulate Result</label>
                <select name="result" id="demo-result">
                  <option value="captured">✅ Success</option>
                  <option value="failed">❌ Failed</option>
                </select>
              </div>
              <div id="demo-payment-error" class="error-message" role="alert"></div>
              <div class="form-actions">
                <button type="submit" class="primary" id="demo-pay-btn">Simulate Payment</button>
                <button type="button" class="secondary" data-action="close-modal">Cancel</button>
              </div>
            </form>
          </div>
        `,
        footerHtml: ""
      });

      const form = $("#demo-payment-form");
      if (form) {
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          await processDemoPayment(form, order.gateway_order_id, billId);
        });
      }
    } else {
      // Real Razorpay checkout - redirect to Razorpay
      if (typeof window.Razorpay !== "undefined") {
        const options = {
          ...checkout,
          handler: async (response) => {
            await verifyPayment(response, order.id);
          },
          modal: {
            ...checkout.modal,
            ondismiss: () => {
              closeModal();
              toast("Payment window closed. You can try again from your bills.", "info");
            }
          }
        };
        const rzp = new window.Razorpay(options);
        rzp.open();
      } else {
        toast("Razorpay SDK not loaded. Please refresh the page.", "error");
        closeModal();
      }
    }
  }

  async function processDemoPayment(form, gatewayOrderId, billId) {
    const errorNode = $("#demo-payment-error");
    const btn = $("#demo-pay-btn");
    const method = $("#demo-method").value;
    const result = $("#demo-result").value;

    if (errorNode) errorNode.textContent = "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Processing...";
    }

    try {
      // Simulate payment
      const simResponse = await api("/api/payments/demo/simulate", {
        method: "POST",
        body: { order_id: gatewayOrderId, status: result, method }
      });

      const { payment_id, signature, status: simStatus } = simResponse;

      // Verify payment
      const verifyResponse = await api("/api/payments/verify", {
        method: "POST",
        body: { order_id: gatewayOrderId, payment_id, signature }
      });

      closeModal();
      toast(simStatus === "captured" ? "✅ Payment successful! Receipt generated." : "❌ Payment failed.", simStatus === "captured" ? "success" : "error");

      if (simStatus === "captured") {
        // Refresh dashboard
        await loadDashboardPayments();
      }
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Simulate Payment";
      }
    }
  }

  async function verifyPayment(response, orderRecordId) {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = response;

    try {
      const verifyResponse = await api("/api/payments/verify", {
        method: "POST",
        body: {
          order_id: razorpay_order_id,
          payment_id: razorpay_payment_id,
          signature: razorpay_signature
        }
      });

      closeModal();
      toast("✅ Payment successful! Receipt generated.", "success");
      await loadDashboardPayments();
    } catch (error) {
      toast("Payment verification failed: " + error.message, "error");
    }
  }

  async function openBillDetailModal(billId) {
    if (!state.user) {
      requireLogin();
      return;
    }
    try {
      const billData = await api(`/api/payments/bills/${billId}`);
      const { bill, transactions } = billData;

      const typeLabel = {
        electricity: "⚡ Electricity",
        water: "💧 Water",
        property_tax: "🏠 Property Tax"
      }[bill.service_type] || bill.service_type;

      const transactionsHtml = transactions && transactions.length
        ? `<div class="section">
            <h4>Payment Attempts</h4>
            <ul class="record-list">
              ${transactions.map((txn) => {
                const statusLabel = { captured: "✅ Success", failed: "❌ Failed", pending: "⏳ Pending", refunded: "↩️ Refunded" }[txn.status] || txn.status;
                return `<li class="record-row">
                  <div class="record-main">
                    <div class="record-title">${statusLabel} · ₹${esc((txn.amount / 100).toFixed(2))}</div>
                    <div class="record-meta muted small">${esc(fmtDateTime(txn.created_at))} · ${esc(txn.method || "")} · ${esc(txn.gateway || "")}</div>
                    ${txn.gateway_payment_id ? `<div class="record-meta muted small mono">Gateway: ${esc(txn.gateway_payment_id)}</div>` : ""}
                    ${txn.failure_reason ? `<div class="record-meta muted small error">Reason: ${esc(txn.failure_reason)}</div>` : ""}
                  </div>
                </li>`;
              }).join("")}
            </ul>
          </div>`
        : `<p class="muted small">No payment attempts yet.</p>`;

      openModal({
        title: `${typeLabel} Bill Details`,
        wide: true,
        bodyHtml: `
          <div class="bill-detail">
            <div class="detail-section">
              <h4>Bill Information</h4>
              <div class="detail-grid">
                <div class="detail-row"><span>Account Number:</span> <strong>${esc(bill.account_number)}</strong></div>
                ${bill.bill_number ? `<div class="detail-row"><span>Bill Number:</span> <strong>${esc(bill.bill_number)}</strong></div>` : ""}
                <div class="detail-row"><span>Service Type:</span> <strong>${esc(typeLabel)}</strong></div>
                <div class="detail-row"><span>Billing Period:</span> <strong>${esc(bill.billing_period_start)} to ${esc(bill.billing_period_end)}</strong></div>
                <div class="detail-row"><span>Total Amount:</span> <strong>₹${esc((bill.amount_due / 100).toFixed(2))}</strong></div>
                <div class="detail-row"><span>Amount Paid:</span> <strong>₹${esc((bill.amount_paid / 100).toFixed(2))}</strong></div>
                <div class="detail-row"><span>Remaining:</span> <strong class="${(bill.amount_due - bill.amount_paid) > 0 ? "error" : "success"}">₹${esc(((bill.amount_due - bill.amount_paid) / 100).toFixed(2))}</strong></div>
                ${bill.due_date ? `<div class="detail-row"><span>Due Date:</span> <strong>${esc(fmtDate(bill.due_date))}</strong></div>` : ""}
                <div class="detail-row"><span>Status:</span> <span class="status-tag status-${bill.status}">${esc(bill.status)}</span></div>
                ${bill.provider_name ? `<div class="detail-row"><span>Provider:</span> <strong>${esc(bill.provider_name)}</strong></div>` : ""}
              </div>
            </div>
            ${transactionsHtml}
          </div>
        `,
        footerHtml: `<button type="button" class="secondary" data-action="close-modal">Close</button>`
      });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function openReceiptModal(transactionId) {
    if (!state.user) {
      requireLogin();
      return;
    }
    try {
      const receiptData = await api(`/api/payments/receipts/${transactionId}`);
      const { receipt, bill, transaction, user } = receiptData;

      const typeLabel = {
        electricity: "⚡ Electricity",
        water: "💧 Water",
        property_tax: "🏠 Property Tax"
      }[bill.service_type] || bill.service_type;

      openModal({
        title: `Receipt #${receipt.receipt_number}`,
        wide: true,
        bodyHtml: `
          <div class="receipt-modal">
            <div class="receipt-header">
              <div class="receipt-title">
                <h3>Municipal Corporation</h3>
                <p class="muted">Citizen Services & Complaints Portal</p>
              </div>
              <div class="receipt-badge">RECEIPT</div>
            </div>
            <div class="receipt-body">
              <table class="receipt-table">
                <tr><th>Receipt Number</th><td>${esc(receipt.receipt_number)}</td></tr>
                <tr><th>Date & Time</th><td>${esc(fmtDateTime(receipt.payment_date))}</td></tr>
                <tr><th>Transaction ID</th><td class="mono">${esc(transaction.gateway_payment_id || transaction.id)}</td></tr>
                <tr><th>Gateway</th><td>${esc(transaction.gateway || "Demo")}</td></tr>
                <tr><th>Payment Method</th><td>${esc(transaction.method || "Online")}</td></tr>
                <tr><th>Service</th><td>${esc(typeLabel)}</td></tr>
                <tr><th>Account Number</th><td>${esc(bill.account_number)}</td></tr>
                ${bill.bill_number ? `<tr><th>Bill Number</th><td>${esc(bill.bill_number)}</td></tr>` : ""}
                <tr><th>Amount Paid</th><td class="amount">₹${esc((receipt.amount_paid / 100).toFixed(2))}</td></tr>
                <tr><th>Payer</th><td>${esc(user.name)} (${esc(user.email)})</td></tr>
              </table>
              <p class="receipt-note">This is a computer-generated receipt. No signature required.</p>
            </div>
            <div class="receipt-actions">
              <button type="button" class="primary" onclick="window.print()">Print Receipt</button>
              <button type="button" class="secondary" data-action="close-modal">Close</button>
            </div>
          </div>
        `,
        footerHtml: ""
      });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function renderOffices(container) {
    if (!container) return;
    try {
      const data = await api("/api/services/offices");
      const rows = (data && data.offices) || [];
      container.innerHTML = rows.length
        ? `<ul class="plain-list">${rows
            .map(
              (office) => `<li class="office-row">
                <div class="office-name">${esc(office.name)}</div>
                <div class="muted small">${esc(office.office_type || "Municipal office")}</div>
                ${office.address ? `<div class="muted small">${esc(office.address)}</div>` : ""}
                <div class="muted small">
                  ${office.phone ? `Phone: ${esc(office.phone)}` : ""}
                  ${office.email ? ` &middot; ${esc(office.email)}` : ""}
                  ${
                    office.ward_name
                      ? ` &middot; ${esc(office.ward_name)}${
                          office.zone ? ` (Zone ${esc(office.zone)})` : ""
                        }`
                      : ""
                  }
                </div>
                ${office.office_hours ? `<div class="muted small">${esc(office.office_hours)}</div>` : ""}
              </li>`
            )
            .join("")}</ul>`
        : emptyState("No municipal offices have been published yet.");
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  /* =========================================================================
   * 16. Public transparency dashboard
   * ========================================================================= */
  async function renderTransparency() {
    let data;
    try {
      data = await loadTransparency(true);
    } catch (error) {
      const totals = $("#transparency-totals");
      if (totals) totals.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
      return;
    }

    const totals = data.totals || {};
    const container = $("#transparency-totals");
    if (container) {
      container.innerHTML = [
        statCard("Total complaints", totals.total || 0, "Published records only"),
        statCard("Resolved", totals.resolved || 0),
        statCard("Still open", totals.open || 0),
        statCard("Past target date", totals.overdue || 0, "Internal municipal target"),
        statCard(
          "Resolution rate",
          data.resolution_rate === null || data.resolution_rate === undefined
            ? "Not available"
            : `${Math.round(Number(data.resolution_rate) * 100)}%`,
          "Resolved ÷ (total − rejected)"
        ),
        statCard("Average resolution time", humanHours(data.average_resolution_hours))
      ].join("");
    }

    const byCategory = data.by_category || [];
    renderDoughnutChart(
      "transparency-category-chart",
      "transparencyCategory",
      byCategory.map((row) => row.name || "Uncategorised"),
      byCategory.map((row) => row.count)
    );

    const byStatus = data.by_status || [];
    renderBarChart(
      "transparency-status-chart",
      "transparencyStatus",
      byStatus.map((row) => row.status),
      byStatus.map((row) => row.count)
    );

    const wardNote = $("#transparency-ward-note");
    if (wardNote) {
      const suppressed = data.suppressed_ward_groups || 0;
      wardNote.textContent = suppressed
        ? `Wards with fewer than ${data.ward_min_group_size} complaints are suppressed (${suppressed} hidden).`
        : `Groups smaller than ${data.ward_min_group_size} complaints are suppressed.`;
    }

    const wardBody = $("#transparency-ward-body");
    if (wardBody) {
      const rows = data.by_ward || [];
      wardBody.innerHTML = rows.length
        ? rows
            .map((row) => `<tr><td>${esc(row.name)}</td><td>${esc(row.count)}</td></tr>`)
            .join("")
        : `<tr><td colspan="2" class="muted">No ward breakdown is published yet.</td></tr>`;
    }

    const resolvedBody = $("#transparency-resolved-body");
    if (resolvedBody) {
      const rows = data.recently_resolved || [];
      resolvedBody.innerHTML = rows.length
        ? rows
            .map(
              (row) => `<tr>
                <td class="mono">${esc(row.reference_no)}</td>
                <td>${esc(row.category_name || "Uncategorised")}</td>
                <td>${esc(fmtDate(row.resolved_at))}</td>
              </tr>`
            )
            .join("")
        : `<tr><td colspan="3" class="muted">No complaints have been resolved yet.</td></tr>`;
    }

    const generated = $("#transparency-generated");
    if (generated) {
      generated.textContent = `Figures generated ${fmtDateTime(data.generated_at)}. ${
        data.resolution_rate_definition || ""
      }`;
    }
  }

  /* =========================================================================
   * 17. Citizen dashboard
   * ========================================================================= */
  const DASHBOARD_TABS = [
    { key: "complaints", label: "My complaints" },
    { key: "applications", label: "My applications" },
    { key: "payments", label: "My payments" },
    { key: "notifications", label: "Alerts" },
    { key: "profile", label: "My profile" }
  ];

  function renderTabBar(container, tabs, activeKey, action) {
    if (!container) return;
    container.innerHTML = tabs
      .map(
        (tab) => `<button type="button" class="tab${
          tab.key === activeKey ? " active" : ""
        }" data-action="${action}" data-tab="${tab.key}"${
          tab.key === activeKey ? ' aria-current="true"' : ""
        }>${esc(tab.label)}</button>`
      )
      .join("");
  }

  function tableHtml(headers, rows, emptyMessage) {
    if (!rows || !rows.length) return emptyState(emptyMessage || "No records.");
    return `<div class="table-wrapper">
      <table class="data-table">
        <thead><tr>${headers
          .map((heading) => `<th scope="col">${esc(heading)}</th>`)
          .join("")}</tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>`;
  }

  async function renderDashboard() {
    if (!state.user) {
      requireLogin();
      return;
    }
    const title = $("#dashboard-title");
    const subtitle = $("#dashboard-subtitle");
    if (title) title.textContent = `Welcome, ${state.user.name || "citizen"}`;
    if (subtitle) {
      subtitle.textContent = `${state.user.email || ""}${
        state.user.role && state.user.role !== "user" ? ` · ${state.user.role} account` : ""
      }`;
    }
    renderTabBar($("#dashboard-tabs"), DASHBOARD_TABS, state.dashboardTab, "dashboard-tab");

    try {
      await loadWards();
    } catch (error) {
      console.error(error);
    }

    const summaryNode = $("#dashboard-summary");
    try {
      const summary = await api("/api/complaints/summary");
      if (summaryNode) {
        summaryNode.innerHTML = [
          statCard("Total complaints", summary.total),
          statCard("Open", summary.open),
          statCard("Resolved", summary.resolved),
          statCard("Reopened", summary.reopened)
        ].join("");
      }
    } catch (error) {
      if (summaryNode) summaryNode.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }

    await refreshDashboardTab();
  }

  async function refreshDashboardTab() {
    renderTabBar($("#dashboard-tabs"), DASHBOARD_TABS, state.dashboardTab, "dashboard-tab");
    const container = $("#dashboard-content");
    if (!container) return;
    container.innerHTML = `<p class="loading-text">Loading…</p>`;
    if (state.dashboardTab === "applications") return loadDashboardApplications();
    if (state.dashboardTab === "payments") return loadDashboardPayments();
    if (state.dashboardTab === "notifications") return loadNotifications(container, 50);
    if (state.dashboardTab === "profile") {
      renderProfileForm(container);
      return;
    }
    return loadDashboardComplaints();
  }

  async function loadDashboardComplaints() {
    const container = $("#dashboard-content");
    if (!container) return;
    const params = new URLSearchParams();
    params.set("page", String(state.myComplaints.page));
    params.set("limit", String(state.myComplaints.limit));
    try {
      const data = await api(`/api/complaints?${params.toString()}`);
      state.myComplaints.totalPages = data.total_pages;
      state.myComplaints.total = data.total;
      container.innerHTML = `<div class="card">
        <div class="card-header">
          <h3>My complaints (${esc(data.total)})</h3>
          <div class="dashboard-actions">
            <button class="secondary small" data-action="new-complaint">Submit a complaint</button>
          </div>
        </div>
        ${complaintListHtml(data.items)}
        ${paginationHtml(data.page, data.total_pages, "dashboard-complaints-page")}
      </div>`;
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  function applicationRow(item) {
    return `<li class="record-row">
      <div class="record-main">
        <div class="record-title">${esc(item.subcategory_name || "Service application")}</div>
        <div class="record-meta">
          <span class="mono">${esc(item.reference_no)}</span>
          ${statusTag(item.status)}
          <span class="muted">${esc(item.category_name || "")}</span>
        </div>
        <div class="record-meta muted small">
          Submitted ${esc(fmtDateTime(item.created_at))}
          ${item.department_name ? ` &middot; ${esc(item.department_name)}` : ""}
        </div>
        ${item.reviewer_note ? `<div class="muted small">Note: ${esc(item.reviewer_note)}</div>` : ""}
      </div>
      <div class="record-actions">
        <button type="button" class="secondary small" data-action="open-application" data-id="${
          item.id
        }">View details</button>
      </div>
    </li>`;
  }

  async function loadDashboardApplications() {
    const container = $("#dashboard-content");
    if (!container) return;
    const params = new URLSearchParams();
    params.set("page", String(state.myApps.page));
    params.set("limit", String(state.myApps.limit));
    try {
      const data = await api(`/api/services/applications?${params.toString()}`);
      state.myApps.totalPages = data.total_pages;
      state.myApps.total = data.total;
      container.innerHTML = `<div class="card">
        <div class="card-header">
          <h3>My service applications (${esc(data.total)})</h3>
          <div class="dashboard-actions">
            <button class="secondary small" data-route="services">Browse services</button>
          </div>
        </div>
        ${
          data.items && data.items.length
            ? `<ul class="record-list">${data.items.map(applicationRow).join("")}</ul>`
            : emptyState(
                "You have not submitted any service applications yet. Browse the Citizen Services section to get started."
              )
        }
        ${paginationHtml(data.page, data.total_pages, "dashboard-applications-page")}
      </div>`;
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  async function loadDashboardPayments() {
    const container = $("#dashboard-content");
    if (!container) return;
    const params = new URLSearchParams();
    params.set("page", String(state.myPayments.page));
    params.set("limit", String(state.myPayments.limit));
    try {
      const data = await api(`/api/payments/bills?${params.toString()}`);
      state.myPayments.totalPages = data.total_pages;
      state.myPayments.total = data.total;

      // Also load summary
      const summaryData = await api("/api/payments/bills/summary");
      const summaryHtml = renderPaymentSummary(summaryData.summary);

      container.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3>Bills & Payments (${esc(data.total)})</h3>
          </div>
          ${summaryHtml}
          <div class="filter-bar" style="margin-top: 1rem;">
            <label class="sr-only" for="payment-filter-type">Filter by service</label>
            <select id="payment-filter-type">
              <option value="">All services</option>
              <option value="electricity">Electricity</option>
              <option value="water">Water</option>
              <option value="property_tax">Property Tax</option>
            </select>
            <label class="sr-only" for="payment-filter-status">Filter by status</label>
            <select id="payment-filter-status">
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="partial">Partially Paid</option>
              <option value="paid">Paid</option>
              <option value="overdue">Overdue</option>
            </select>
            <button class="secondary small" data-action="apply-payment-filters">Apply</button>
            <button class="secondary small" data-action="refresh-payments">Refresh</button>
          </div>
          <div id="payment-bills-list">
            ${data.bills && data.bills.length
              ? `<ul class="record-list">${data.bills.map(paymentBillRow).join("")}</ul>`
              : emptyState("No bills found. When real billing integrations are configured, your outstanding bills will appear here.")}
          </div>
          ${paginationHtml(data.page, data.total_pages, "dashboard-payments-page")}
        </div>
        <div class="card" style="margin-top: 1rem;">
          <div class="card-header">
            <h3>Payment History</h3>
          </div>
          <div id="payment-history-list">
            <p class="loading-text">Loading payment history...</p>
          </div>
        </div>`;

      // Load payment history
      loadPaymentHistory();
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  function paymentBillRow(bill) {
    const amountDue = bill.amount_due / 100;
    const amountPaid = bill.amount_paid / 100;
    const remaining = amountDue - amountPaid;
    const isOverdue = bill.due_date && new Date(bill.due_date) < new Date() && bill.status !== "paid";

    const statusLabel = {
      pending: "Pending",
      partial: "Partially Paid",
      paid: "Paid",
      cancelled: "Cancelled",
      overdue: "Overdue"
    }[bill.status] || bill.status;

    const statusClass = {
      pending: "status-pending",
      partial: "status-partial",
      paid: "status-paid",
      cancelled: "status-cancelled",
      overdue: "status-overdue"
    }[bill.status] || "";

    const typeLabel = {
      electricity: "⚡ Electricity",
      water: "💧 Water",
      property_tax: "🏠 Property Tax"
    }[bill.service_type] || bill.service_type;

    return `<li class="record-row">
      <div class="record-main">
        <div class="record-title">${esc(typeLabel)}</div>
        <div class="record-meta">
          <span class="mono">${esc(bill.account_number)}</span>
          <span class="status-tag ${statusClass}">${esc(statusLabel)}</span>
          ${bill.bill_number ? `<span class="muted">${esc(bill.bill_number)}</span>` : ""}
        </div>
        <div class="record-meta muted small">
          Bill: ₹${esc(amountDue.toFixed(2))} &middot; Paid: ₹${esc(amountPaid.toFixed(2))} &middot; Due: ₹${esc(remaining.toFixed(2))}
          ${bill.due_date ? ` &middot; Due: ${esc(fmtDate(bill.due_date))}` : ""}
          ${isOverdue ? " ⚠️ OVERDUE" : ""}
        </div>
        ${bill.provider_name ? `<div class="record-meta muted small">Provider: ${esc(bill.provider_name)}</div>` : ""}
      </div>
      <div class="record-actions">
        ${bill.status !== "paid" && bill.status !== "cancelled"
          ? `<button type="button" class="primary small" data-action="pay-bill" data-id="${bill.id}" data-amount="${bill.amount_due - bill.amount_paid}">Pay Now</button>`
          : `<span class="muted small">${bill.status === "paid" ? "✓ Paid in full" : "Cancelled"}</span>`}
        <button type="button" class="secondary small" data-action="view-bill" data-id="${bill.id}">Details</button>
      </div>
    </li>`;
  }

  function renderPaymentSummary(summary) {
    if (!summary || !summary.length) return "";
    const html = summary.map((s) => {
      const totalDue = (s.total_due || 0) / 100;
      const totalPaid = (s.total_paid || 0) / 100;
      const typeLabel = {
        electricity: "⚡ Electricity",
        water: "💧 Water",
        property_tax: "🏠 Property Tax"
      }[s.service_type] || s.service_type;
      return `<div class="stat-card">
        <div class="stat-label">${esc(typeLabel)}</div>
        <div class="stat-value">₹${esc(totalDue.toFixed(2))}</div>
        <div class="stat-note muted">Paid: ₹${esc(totalPaid.toFixed(2))} · ${esc(s.count)} bill(s)</div>
      </div>`;
    }).join("");
    return `<div class="summary-grid">${html}</div>`;
  }

  function transactionRow(txn) {
    const amount = txn.amount / 100;
    const statusLabel = {
      captured: "Success",
      failed: "Failed",
      pending: "Pending",
      refunded: "Refunded",
      cancelled: "Cancelled"
    }[txn.status] || txn.status;
    const statusClass = {
      captured: "status-captured",
      failed: "status-failed",
      pending: "status-pending",
      refunded: "status-refunded",
      cancelled: "status-cancelled"
    }[txn.status] || "";
    const typeLabel = {
      electricity: "⚡ Electricity",
      water: "💧 Water",
      property_tax: "🏠 Property Tax"
    }[txn.service_type] || txn.service_type;

    return `<li class="record-row">
      <div class="record-main">
        <div class="record-title">${esc(typeLabel)} - ₹${esc(amount.toFixed(2))}</div>
        <div class="record-meta">
          <span class="mono">${esc(txn.gateway_payment_id || txn.id)}</span>
          <span class="status-tag ${statusClass}">${esc(statusLabel)}</span>
        </div>
        <div class="record-meta muted small">
          ${esc(fmtDateTime(txn.created_at))} · ${esc(txn.method || "Online")} · ${esc(txn.gateway || "Demo")}
          ${txn.receipt_number ? ` · Receipt: ${esc(txn.receipt_number)}` : ""}
        </div>
        ${txn.failure_reason ? `<div class="record-meta muted small error">Failed: ${esc(txn.failure_reason)}</div>` : ""}
      </div>
      <div class="record-actions">
        ${txn.receipt_number
          ? `<button type="button" class="secondary small" data-action="view-receipt" data-transaction="${txn.id}">View Receipt</button>`
          : `<span class="muted small">No receipt</span>`}
      </div>
    </li>`;
  }

  async function loadPaymentHistory() {
    const container = $("#payment-history-list");
    if (!container) return;
    try {
      const data = await api("/api/payments/history?limit=20");
      container.innerHTML = data.transactions && data.transactions.length
        ? `<ul class="record-list">${data.transactions.map(transactionRow).join("")}</ul>`
        : emptyState("No payment history yet.");
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  function renderProfileForm(container) {
    if (!container) return;
    const user = state.user || {};
    const wardOptions = optionsFrom(state.wards, "id", "name", "Not sure", user.ward_id || "");
    container.innerHTML = `<div class="card">
      <div class="card-header"><h3>My profile</h3></div>
      <p class="muted small">Only your own contact details can be changed here. Your email address identifies your account.</p>
      <form id="profile-form" class="profile-form">
        <div class="form-row two">
          <div class="form-group">
            <label for="profile-name">Full name</label>
            <input id="profile-name" name="name" maxlength="120" value="${esc(user.name || "")}" />
          </div>
          <div class="form-group">
            <label for="profile-phone">Phone</label>
            <input id="profile-phone" name="phone" maxlength="20" value="${esc(user.phone || "")}" />
          </div>
        </div>
        <div class="form-row two">
          <div class="form-group">
            <label for="profile-address">Address</label>
            <input id="profile-address" name="address" maxlength="400" value="${esc(
              user.address || ""
            )}" />
          </div>
          <div class="form-group">
            <label for="profile-ward">Ward</label>
            <select id="profile-ward" name="ward_id">${wardOptions}</select>
          </div>
        </div>
        ${detailField("Email address", esc(user.email || ""))}
        <div id="profile-error" class="error-message" role="alert"></div>
        <button type="submit" class="primary small">Save profile</button>
      </form>
    </div>`;
  }

  async function saveProfile(form) {
    const errorNode = $("#profile-error");
    const wardField = $("#profile-ward");
    const payload = {
      name: $("#profile-name").value.trim(),
      phone: $("#profile-phone").value.trim(),
      address: $("#profile-address").value.trim(),
      ward_id: wardField && wardField.value ? Number(wardField.value) : null
    };
    if (errorNode) errorNode.textContent = "";
    try {
      const data = await api("/api/auth/me", { method: "PATCH", body: payload });
      setSession(state.token, data.user);
      toast("Profile updated.", "success");
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    }
  }

  /* =========================================================================
   * 18. Notifications
   * ========================================================================= */
  function notificationRow(row) {
    return `<li class="record-row${row.is_read ? "" : " unread"}">
      <div class="record-main">
        <div class="record-title">${esc(row.message)}</div>
        <div class="record-meta muted small">${esc(fmtDateTime(row.created_at))}${
          row.type ? ` &middot; ${esc(row.type)}` : ""
        }</div>
      </div>
      <div class="record-actions">
        ${
          row.complaint_id
            ? `<button type="button" class="secondary small" data-action="open-complaint" data-id="${row.complaint_id}">View complaint</button>`
            : ""
        }
        ${
          row.is_read
            ? '<span class="muted small">Read</span>'
            : `<button type="button" class="link-button" data-action="mark-notification" data-id="${row.id}">Mark as read</button>`
        }
      </div>
    </li>`;
  }

  async function loadNotifications(container, limit) {
    if (!container) return;
    if (!state.user) {
      container.innerHTML = emptyState("Sign in to see your alerts.");
      return;
    }
    container.innerHTML = `<p class="loading-text">Loading alerts…</p>`;
    try {
      const data = await api(`/api/notifications?limit=${limit || 30}`);
      const rows = data.notifications || [];
      container.innerHTML = `<div class="card">
        <div class="card-header">
          <h3>Alerts (${esc(data.unread || 0)} unread)</h3>
          <div class="dashboard-actions">
            <button class="secondary small" data-action="mark-all-notifications">Mark all as read</button>
          </div>
        </div>
        ${
          rows.length
            ? `<ul class="record-list">${rows.map(notificationRow).join("")}</ul>`
            : emptyState("You have no alerts yet. Updates about your complaints will appear here.")
        }
      </div>`;
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  async function openNotifications() {
    if (!state.user) {
      requireLogin();
      return;
    }
    openModal({
      title: "Your alerts",
      bodyHtml: `<div id="notification-list"><p class="loading-text">Loading alerts…</p></div>`,
      footerHtml: `<button type="button" class="secondary" data-action="mark-all-notifications">Mark all as read</button>
        <button type="button" class="secondary" data-action="close-modal">Close</button>`
    });
    await loadNotifications($("#notification-list"), 50);
  }

  async function markNotificationRead(id) {
    try {
      await api(`/api/notifications/${id}/read`, { method: "POST", body: {} });
      await refreshNotificationCount();
      const container = $("#notification-list") || $("#dashboard-content");
      if (container) await loadNotifications(container, 50);
      if (currentRoute() === "dashboard" && state.dashboardTab === "notifications") {
        await refreshDashboardTab();
      }
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function markAllNotifications() {
    try {
      await api("/api/notifications/read-all", { method: "POST", body: {} });
      await refreshNotificationCount();
      toast("All alerts marked as read.", "success");
      if (currentRoute() === "dashboard" && state.dashboardTab === "notifications") {
        await refreshDashboardTab();
      } else if ($("#notification-list")) {
        await loadNotifications($("#notification-list"), 50);
      }
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* =========================================================================
   * 19. Municipal service desk (staff)
   * ========================================================================= */
  const STAFF_TABS = [
    { key: "queue", label: "Complaint queue" },
    { key: "sla", label: "SLA & escalations" },
    { key: "reopen", label: "Reopening requests" },
    { key: "feedback", label: "Citizen feedback" },
    { key: "applications", label: "Applications" }
  ];

  async function renderStaff() {
    if (!isStaff()) {
      toast("The service desk is only available to municipal staff.", "warning");
      navigate(state.user ? "dashboard" : "login");
      return;
    }
    const subtitle = $("#staff-subtitle");
    if (subtitle) {
      subtitle.textContent = `${state.user.name || ""} · ${
        state.user.designation || (state.user.role === "admin" ? "Administrator" : "Service desk")
      }`;
    }
    renderTabBar($("#staff-tabs"), STAFF_TABS, state.staffTab, "staff-tab");

    const summaryNode = $("#staff-summary");
    if (summaryNode) summaryNode.innerHTML = `<p class="loading-text">Loading figures…</p>`;
    try {
      const [summary, worklists] = await Promise.all([
        api("/api/complaints/summary?scope=all"),
        api("/api/staff/worklists")
      ]);
      if (summaryNode) {
        summaryNode.innerHTML = [
          statCard("Total complaints", summary.total),
          statCard("Open", summary.open),
          statCard("Past target date", (worklists.overdue || []).length),
          statCard("Due within 12 hours", (worklists.due_soon || []).length),
          statCard("Resolved", summary.resolved)
        ].join("");
      }
    } catch (error) {
      if (summaryNode) summaryNode.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }

    await refreshStaffTab();
  }

  async function refreshStaffTab() {
    renderTabBar($("#staff-tabs"), STAFF_TABS, state.staffTab, "staff-tab");
    const container = $("#staff-content");
    if (!container) return;
    container.innerHTML = `<p class="loading-text">Loading…</p>`;
    try {
      if (state.staffTab === "sla") {
        await renderStaffSla(container);
      } else if (state.staffTab === "reopen") {
        await renderStaffReopen(container);
      } else if (state.staffTab === "feedback") {
        await renderStaffFeedback(container);
      } else if (state.staffTab === "applications") {
        await renderStaffApplications(container);
      } else {
        await renderStaffQueue(container);
      }
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  async function renderStaffQueue(container) {
    await Promise.all([loadTaxonomy(), loadWards(), loadDepartments()]);

    const filters = state.staffFilters;
    const subcategories = [];
    for (const category of state.taxonomy.categories) {
      for (const sub of category.subcategories || []) {
        if (!filters.category_id || String(sub.category_id) === String(filters.category_id)) {
          subcategories.push(sub);
        }
      }
    }

    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>Complaint queue</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="apply-staff-filters">Apply filters</button>
          <button class="secondary small" data-action="reset-staff-filters">Reset</button>
        </div>
      </div>
      <div class="filter-bar">
        <label class="sr-only" for="staff-filter-window">Deadline window</label>
        <select id="staff-filter-window">
          <option value="">All deadlines</option>
          <option value="open" ${filters.window === "open" ? "selected" : ""}>Open complaints</option>
          <option value="overdue" ${filters.window === "overdue" ? "selected" : ""}>Past target date</option>
          <option value="due_soon" ${filters.window === "due_soon" ? "selected" : ""}>Due within 12 hours</option>
        </select>
        <label class="sr-only" for="staff-filter-status">Status</label>
        <select id="staff-filter-status">${optionsFrom(
          STATUSES.map((value) => ({ value: value, label: value })),
          "value",
          "label",
          "All statuses",
          filters.status
        )}</select>
        <label class="sr-only" for="staff-filter-category">Category</label>
        <select id="staff-filter-category">${optionsFrom(
          state.taxonomy.categories,
          "id",
          "name",
          "All categories",
          filters.category_id
        )}</select>
        <label class="sr-only" for="staff-filter-subcategory">Issue type</label>
        <select id="staff-filter-subcategory">${optionsFrom(
          subcategories.map((sub) => ({
            id: sub.id,
            name: `${sub.category_name} › ${sub.name}`
          })),
          "id",
          "name",
          "All issue types",
          filters.subcategory_id
        )}</select>
        <label class="sr-only" for="staff-filter-ward">Ward</label>
        <select id="staff-filter-ward">${optionsFrom(
          state.wards,
          "id",
          "name",
          "All wards",
          filters.ward_id
        )}</select>
        <label class="sr-only" for="staff-filter-department">Department</label>
        <select id="staff-filter-department">${optionsFrom(
          state.departments,
          "id",
          "name",
          "All departments",
          filters.department_id
        )}</select>
        <label class="sr-only" for="staff-filter-priority">Priority</label>
        <select id="staff-filter-priority">${optionsFrom(
          PRIORITIES.map((value) => ({ value: value, label: value })),
          "value",
          "label",
          "All priorities",
          filters.priority
        )}</select>
        <label class="sr-only" for="staff-filter-from">Filed from</label>
        <input id="staff-filter-from" type="date" value="${esc(filters.from)}" />
        <label class="sr-only" for="staff-filter-to">Filed until</label>
        <input id="staff-filter-to" type="date" value="${esc(filters.to)}" />
        <label class="sr-only" for="staff-filter-search">Search</label>
        <input id="staff-filter-search" type="search" placeholder="Reference, title or location"
          value="${esc(filters.search)}" />
        <label class="inline-check">
          <input type="checkbox" id="staff-filter-unassigned" ${
            filters.unassigned ? "checked" : ""
          } /> Unassigned only
        </label>
      </div>
      <div id="staff-queue-list"><p class="loading-text">Loading complaints…</p></div>
    </div>`;

    await loadStaffQueue();
  }

  function readStaffFilters() {
    const filters = state.staffFilters;
    const read = (selector, key) => {
      const node = $(selector);
      filters[key] = node ? node.value : "";
    };
    read("#staff-filter-window", "window");
    read("#staff-filter-status", "status");
    read("#staff-filter-category", "category_id");
    read("#staff-filter-subcategory", "subcategory_id");
    read("#staff-filter-ward", "ward_id");
    read("#staff-filter-department", "department_id");
    read("#staff-filter-priority", "priority");
    read("#staff-filter-from", "from");
    read("#staff-filter-to", "to");
    read("#staff-filter-search", "search");
    const unassigned = $("#staff-filter-unassigned");
    filters.unassigned = !!(unassigned && unassigned.checked);
    return filters;
  }

  async function loadStaffQueue() {
    const container = $("#staff-queue-list");
    if (!container) return;
    const filters = readStaffFilters();
    const params = new URLSearchParams();
    params.set("page", String(state.staffQueue.page));
    params.set("limit", String(state.staffQueue.limit));

    if (filters.window === "open") params.set("open", "1");
    else if (filters.window === "overdue") params.set("overdue", "1");
    else if (filters.window === "due_soon") params.set("due_soon", "1");
    if (filters.status) params.set("status", filters.status);
    if (filters.category_id) params.set("category_id", filters.category_id);
    if (filters.subcategory_id) params.set("subcategory_id", filters.subcategory_id);
    if (filters.ward_id) params.set("ward_id", filters.ward_id);
    if (filters.department_id) params.set("department_id", filters.department_id);
    if (filters.priority) params.set("priority", filters.priority);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.search) params.set("search", filters.search);
    if (filters.unassigned) params.set("unassigned", "1");

    container.innerHTML = `<p class="loading-text">Loading complaints…</p>`;
    try {
      const data = await api(`/api/complaints?${params.toString()}`);
      state.staffQueue.total = data.total;
      state.staffQueue.totalPages = data.total_pages;
      container.innerHTML =
        `<p class="muted small">${esc(data.total)} complaint(s) match the current filters.</p>` +
        complaintListHtml(data.items) +
        paginationHtml(data.page, data.total_pages, "staff-queue-page");
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  function worklistTable(rows) {
    return tableHtml(
      ["Reference", "Complaint", "Status", "Priority", "Department", "Officer", "Target date", ""],
      (rows || []).map(
        (row) => `<tr>
          <td class="mono">${esc(row.reference_no)}</td>
          <td>${esc(row.title)}</td>
          <td>${statusTag(row.status)}</td>
          <td>${priorityTag(row.priority)}</td>
          <td>${esc(row.department_name || "Not routed")}</td>
          <td>${esc(row.assigned_user_name || "Unassigned")}</td>
          <td>${esc(fmtDateTime(row.due_at))}${
            row.sla_state === "overdue" ? ' <span class="overdue-flag">Overdue</span>' : ""
          }</td>
          <td><button type="button" class="secondary small" data-action="open-complaint" data-id="${
            row.id
          }">Open</button></td>
        </tr>`
      ),
      "Nothing is in this worklist."
    );
  }

  async function renderStaffSla(container) {
    const [worklists, escalations] = await Promise.all([
      api("/api/staff/worklists"),
      api("/api/staff/escalations")
    ]);

    const escalationRows = (escalations || []).map(
      (row) => `<tr>
        <td class="mono">${esc(row.reference_no)}</td>
        <td>${esc(row.level)}</td>
        <td>${esc(row.reason || "")}</td>
        <td>${esc(row.escalated_to || "")}</td>
        <td>${esc(fmtDateTime(row.created_at))}</td>
        <td>${
          row.acknowledged_at
            ? `<span class="muted small">Acknowledged ${esc(fmtDateTime(row.acknowledged_at))}</span>`
            : `<button type="button" class="link-button" data-action="ack-escalation" data-id="${row.id}">Acknowledge</button>`
        }</td>
      </tr>`
    );

    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>Resolution targets</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="run-escalations">Run escalation sweep</button>
          <button class="secondary small" data-action="refresh-staff-tab">Refresh</button>
        </div>
      </div>
      <p class="map-help">
        These are internally configured municipal resolution targets, not legally mandated service
        levels. Escalation records the event and notifies the responsible officer; it never changes a
        complaint's status on its own.
      </p>
      <p class="muted small">Last sweep: ${esc(fmtDateTime(worklists.last_sweep))}</p>
      <h4 class="subsection-title">Past target date (${esc((worklists.overdue || []).length)})</h4>
      ${worklistTable(worklists.overdue)}
      <h4 class="subsection-title">Approaching deadline (${esc((worklists.due_soon || []).length)})</h4>
      ${worklistTable(worklists.due_soon)}
    </div>
    <div class="card">
      <div class="card-header"><h3>Escalation history</h3></div>
      ${tableHtml(
        ["Reference", "Level", "Reason", "Escalated to", "Raised", ""],
        escalationRows,
        "No escalations have been recorded."
      )}
    </div>`;
  }

  async function renderStaffReopen(container) {
    const rows = await api("/api/staff/reopen-requests");
    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>Pending reopening requests</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="refresh-staff-tab">Refresh</button>
        </div>
      </div>
      ${
        rows && rows.length
          ? `<ul class="record-list">${rows
              .map(
                (row) => `<li class="record-row">
                  <div class="record-main">
                    <div class="record-title">${esc(row.title)}</div>
                    <div class="record-meta">
                      <span class="mono">${esc(row.reference_no)}</span>
                      ${statusTag(row.complaint_status)}
                      <span class="muted small">Requested ${esc(fmtDateTime(row.created_at))}</span>
                    </div>
                    <div class="muted">${esc(row.reason)}</div>
                  </div>
                  <div class="record-actions">
                    <button type="button" class="primary small" data-action="open-complaint" data-id="${
                      row.complaint_id
                    }">Review</button>
                  </div>
                </li>`
              )
              .join("")}</ul>`
          : emptyState("There are no pending reopening requests.")
      }
      <p class="map-help">
        A reopening request is approved or declined from the complaint view, so the decision and its
        notes are recorded in the complaint's history and the earlier resolution is preserved.
      </p>
    </div>`;
  }

  async function renderStaffFeedback(container) {
    const data = await api("/api/staff/feedback/summary");
    const categoryRows = (data.by_category || []).map(
      (row) => `<tr>
        <td>${esc(row.category_name || "Uncategorised")}</td>
        <td>${esc(row.responses)}</td>
        <td>${
          row.average_rating === null || row.average_rating === undefined
            ? "Not available"
            : esc(Number(row.average_rating).toFixed(2))
        }</td>
      </tr>`
    );
    const attentionRows = (data.needs_attention || []).map(
      (row) => `<tr>
        <td class="mono">${esc(row.reference_no)}</td>
        <td>${esc(row.rating)} / 5</td>
        <td>${row.was_resolved ? "Confirmed resolved" : '<span class="overdue-flag">Not resolved</span>'}</td>
        <td>${esc(row.comments || "")}</td>
        <td>${esc(fmtDateTime(row.created_at))}</td>
        <td><button type="button" class="secondary small" data-action="open-complaint" data-id="${
          row.complaint_id
        }">Open</button></td>
      </tr>`
    );

    container.innerHTML = `<div class="summary-grid">
        ${statCard("Feedback responses", data.responses)}
        ${statCard(
          "Average rating",
          data.average_rating === null || data.average_rating === undefined
            ? "Not available"
            : `${data.average_rating} / 5`
        )}
        ${statCard("Citizen confirmed resolved", data.confirmed_resolved)}
      </div>
      <div class="card">
        <div class="card-header"><h3>Satisfaction by category</h3></div>
        ${tableHtml(["Category", "Responses", "Average rating"], categoryRows, "No feedback has been recorded yet.")}
      </div>
      <div class="card">
        <div class="card-header"><h3>Needs attention</h3></div>
        <p class="map-help">Complaints rated 2 or lower, or where the citizen says the issue was not resolved.</p>
        ${tableHtml(
          ["Reference", "Rating", "Citizen view", "Comments", "Recorded", ""],
          attentionRows,
          "Nothing needs attention right now."
        )}
      </div>`;
  }

  async function renderStaffApplications(container) {
    const data = await api("/api/services/applications?limit=50");
    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>Service applications (${esc(data.total || 0)})</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="refresh-staff-tab">Refresh</button>
        </div>
      </div>
      ${
        data.items && data.items.length
          ? `<ul class="record-list">${data.items.map(applicationRow).join("")}</ul>`
          : emptyState("No service applications have been submitted.")
      }
      <p class="map-help">Open an application to review it, attach a reviewer note and move it through its statuses.</p>
    </div>`;
  }

  /* =========================================================================
   * 20. Administration
   * ========================================================================= */
  const ADMIN_TABS = [
    { key: "complaints", label: "All complaints" },
    { key: "payments", label: "Payments" },
    { key: "categories", label: "Categories" },
    { key: "subcategories", label: "Services & routing" },
    { key: "departments", label: "Departments" },
    { key: "wards", label: "Wards" },
    { key: "targets", label: "Resolution targets" },
    { key: "staff", label: "Staff accounts" },
    { key: "announcements", label: "Announcements" },
    { key: "offices", label: "Offices" },
    { key: "email", label: "Email & alerts" },
    { key: "settings", label: "Settings" },
    { key: "audit", label: "Audit trail" }
  ];

  let adminAuditPage = 1;

  function wardName(id) {
    if (!id) return "City-wide";
    const ward = state.wards.find((row) => String(row.id) === String(id));
    return ward ? ward.name : `Ward ${id}`;
  }

  function categoryOptions() {
    return (state.taxonomy ? state.taxonomy.categories : []).map((cat) => ({
      value: cat.id,
      label: cat.name
    }));
  }

  function departmentOptions() {
    return state.departments.map((row) => ({ value: row.id, label: row.name }));
  }

  function wardOptions() {
    return state.wards.map((row) => ({
      value: row.id,
      label: `${row.name}${row.zone ? ` (Zone ${row.zone})` : ""}`
    }));
  }

  function linesToArray(value) {
    return String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseChecklistText(value) {
    if (!value) return "";
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.join("\n");
    } catch (error) {
      /* stored as plain text */
    }
    return String(value);
  }

  const ADMIN_ENTITIES = {
    categories: {
      label: "category",
      heading: "Service categories",
      note: "Deactivating a category hides it from new submissions. Complaints already filed keep their category.",
      path: "/api/admin/categories",
      collection: "categories",
      columns: [
        { label: "Name", key: "name" },
        { label: "Code", key: "code", className: "mono" },
        { label: "Kind", key: "kind" },
        { label: "Emergency", render: (row) => (row.is_emergency ? "Yes" : "No") },
        { label: "Status", render: (row) => (row.is_active ? "Active" : "Inactive") }
      ],
      fields: [
        { key: "name", label: "Category name", required: true, max: 120 },
        { key: "code", label: "Code (generated when left blank)", max: 60, createOnly: true },
        { key: "kind", label: "Category kind", type: "select", options: ["complaint", "service", "mixed"] },
        { key: "description", label: "Description", type: "textarea", max: 500 },
        { key: "is_emergency", label: "Emergency category", type: "checkbox" },
        { key: "sort_order", label: "Sort order", type: "number" },
        { key: "is_active", label: "Active", type: "checkbox", defaultValue: true }
      ]
    },
    subcategories: {
      label: "service",
      heading: "Services and routing rules",
      path: "/api/admin/subcategories",
      collection: "subcategories",
      columns: [
        { label: "Service", key: "name" },
        { label: "Category", render: (row) => esc(row.category_name || "") },
        { label: "Type", render: (row) => typeBadge(row.item_type) },
        { label: "Department", render: (row) => esc(row.department_name || "Not routed") },
        { label: "Priority", key: "default_priority" },
        { label: "Status", render: (row) => (row.is_active ? "Active" : "Inactive") }
      ],
      fields: [
        { key: "category_id", label: "Parent category", type: "select", required: true, options: categoryOptions },
        { key: "name", label: "Service name", required: true, max: 160 },
        { key: "code", label: "Code (generated when left blank)", max: 60, createOnly: true },
        { key: "item_type", label: "Service type", type: "select", options: ["complaint", "application", "information"] },
        { key: "summary", label: "Summary", type: "textarea", max: 500 },
        {
          key: "checklist",
          label: "What the citizen should have ready (one item per line)",
          type: "textarea",
          max: 2000,
          fromRecord: (row) => parseChecklistText(row.checklist),
          transform: linesToArray
        },
        { key: "processing_time", label: "Expected handling time", max: 120 },
        { key: "official_url", label: "Official external link (full URL)", max: 300 },
        { key: "department_id", label: "Handling department", type: "select", placeholder: "Not routed", options: departmentOptions },
        { key: "default_priority", label: "Default priority", type: "select", options: PRIORITIES },
        { key: "sla_hours", label: "Target hours (blank uses the priority target)", type: "number" },
        { key: "sort_order", label: "Sort order", type: "number" },
        { key: "is_active", label: "Active", type: "checkbox", defaultValue: true }
      ]
    },
    departments: {
      label: "department",
      heading: "Departments",
      note: "Departments are the routing targets for complaints. Deactivating one leaves its existing complaints untouched.",
      path: "/api/admin/departments",
      collection: "departments",
      columns: [
        { label: "Name", key: "name" },
        { label: "Code", key: "code", className: "mono" },
        { label: "Contact email", render: (row) => esc(row.contact_email || "—") },
        { label: "Contact phone", render: (row) => esc(row.contact_phone || "—") },
        { label: "Status", render: (row) => (row.is_active ? "Active" : "Inactive") }
      ],
      fields: [
        { key: "name", label: "Department name", required: true, max: 120 },
        { key: "code", label: "Code (generated when left blank)", max: 60, createOnly: true },
        { key: "description", label: "Description", type: "textarea", max: 500 },
        { key: "contact_email", label: "Contact email", max: 160 },
        { key: "contact_phone", label: "Contact phone", max: 20 },
        { key: "is_active", label: "Active", type: "checkbox", defaultValue: true }
      ]
    },
    wards: {
      label: "ward",
      heading: "Wards",
      note: "Wards are administrative boundaries. A complaint's ward is taken from this list or from the citizen — it is never guessed from an address.",
      path: "/api/admin/wards",
      collection: "wards",
      columns: [
        { label: "Code", key: "code", className: "mono" },
        { label: "Name", key: "name" },
        { label: "Zone", render: (row) => esc(row.zone || "—") },
        { label: "Status", render: (row) => (row.is_active ? "Active" : "Inactive") }
      ],
      fields: [
        { key: "code", label: "Ward code", required: true, max: 20, createOnly: true },
        { key: "name", label: "Ward name", required: true, max: 120 },
        { key: "zone", label: "Zone", max: 60 },
        { key: "description", label: "Description", type: "textarea", max: 400 },
        { key: "is_active", label: "Active", type: "checkbox", defaultValue: true }
      ]
    },
    targets: {
      label: "resolution target",
      heading: "Resolution targets",
      note: "These are internally configured municipal resolution targets, not legally mandated service levels.",
      path: "/api/admin/sla-policies",
      collection: "policies",
      noteKey: "note",
      columns: [
        { label: "Priority", key: "priority" },
        { label: "Category", render: (row) => esc(row.category_name || "All categories") },
        { label: "Target hours", key: "target_hours" },
        { label: "Status", render: (row) => (row.is_active ? "Active" : "Inactive") }
      ],
      fields: [
        { key: "priority", label: "Priority", type: "select", options: PRIORITIES, required: true, createOnly: true },
        { key: "category_id", label: "Category (optional)", type: "select", placeholder: "All categories", options: categoryOptions, createOnly: true },
        { key: "target_hours", label: "Target hours", type: "number", required: true },
        { key: "is_active", label: "Active", type: "checkbox", defaultValue: true }
      ]
    },
    announcements: {
      label: "announcement",
      heading: "Public announcements",
      note: "Published notices appear on the home page and the Citizen Services page.",
      path: "/api/admin/announcements",
      collection: "announcements",
      columns: [
        { label: "Title", key: "title" },
        { label: "Published", render: (row) => esc(fmtDateTime(row.published_at)) },
        { label: "Status", render: (row) => (row.is_active ? "Published" : "Hidden") }
      ],
      fields: [
        { key: "title", label: "Title", required: true, max: 200 },
        { key: "body", label: "Notice text", type: "textarea", max: 5000 },
        { key: "is_active", label: "Published", type: "checkbox", defaultValue: true }
      ]
    },
    offices: {
      label: "office",
      heading: "Municipal offices",
      path: "/api/admin/offices",
      collection: "offices",
      columns: [
        { label: "Name", key: "name" },
        { label: "Type", render: (row) => esc(row.office_type || "—") },
        { label: "Ward", render: (row) => esc(wardName(row.ward_id)) },
        { label: "Phone", render: (row) => esc(row.phone || "—") },
        { label: "Status", render: (row) => (row.is_active ? "Active" : "Inactive") }
      ],
      fields: [
        { key: "name", label: "Office name", required: true, max: 160 },
        { key: "office_type", label: "Office type", max: 80 },
        { key: "ward_id", label: "Ward", type: "select", placeholder: "City-wide", options: wardOptions },
        { key: "address", label: "Address", type: "textarea", max: 400 },
        { key: "phone", label: "Phone", max: 20 },
        { key: "email", label: "Email", max: 160 },
        { key: "office_hours", label: "Office hours", max: 160 },
        { key: "map_url", label: "Map link", max: 300 },
        { key: "is_active", label: "Active", type: "checkbox", defaultValue: true }
      ]
    }
  };

  async function renderAdmin() {
    if (!isAdmin()) {
      toast("Administration is only available to administrators.", "warning");
      navigate(state.user ? "dashboard" : "login");
      return;
    }
    try {
      await Promise.all([
        loadDepartments(true).catch((error) => console.error(error)),
        loadWards(true).catch((error) => console.error(error)),
        loadTaxonomy().catch((error) => console.error(error)),
        loadStaffUsers(true).catch((error) => console.error(error))
      ]);
    } catch (error) {
      console.error(error);
    }
    await renderAdminTab();
  }

  async function renderAdminTab() {
    const container = $("#admin-content");
    if (!container) return;
    renderTabBar($("#admin-tabs"), ADMIN_TABS, state.adminTab, "admin-tab");
    container.innerHTML = `<p class="loading-text">Loading…</p>`;
    try {
      if (state.adminTab === "complaints") return await renderAdminComplaints(container);
      if (state.adminTab === "payments") return await renderAdminPayments(container);
      if (state.adminTab === "email") return await renderAdminEmail(container);
      if (state.adminTab === "subcategories") return await renderAdminServices(container);
      if (state.adminTab === "staff") return await renderAdminStaff(container);
      if (state.adminTab === "settings") return await renderAdminSettings(container);
      if (state.adminTab === "audit") return await renderAdminAudit(container);
      return await renderAdminTable(container, state.adminTab);
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  /* -------------------------------------------------------------------------
   * All complaints — single view of every record with assignment to any officer
   * ----------------------------------------------------------------------- */
  function readAdminFilters() {
    const filters = state.adminFilters;
    const read = (selector, key) => {
      const node = $(selector);
      filters[key] = node ? node.value : "";
    };
    read("#admin-c-filter-status", "status");
    read("#admin-c-filter-category", "category_id");
    read("#admin-c-filter-department", "department_id");
    read("#admin-c-filter-officer", "assigned_to");
    read("#admin-c-filter-ward", "ward_id");
    read("#admin-c-filter-priority", "priority");
    read("#admin-c-filter-from", "from");
    read("#admin-c-filter-to", "to");
    read("#admin-c-filter-search", "search");
    const unassigned = $("#admin-c-filter-unassigned");
    filters.unassigned = !!(unassigned && unassigned.checked);
    return filters;
  }

  function resetAdminFilters() {
    state.adminFilters = {
      status: "",
      category_id: "",
      department_id: "",
      assigned_to: "",
      ward_id: "",
      priority: "",
      search: "",
      from: "",
      to: "",
      unassigned: false
    };
    state.adminComplaints.page = 1;
  }

  function adminOfficerOptions(selected) {
    const rows = state.staffUsers.filter((user) => user.role === "staff" || user.role === "admin");
    return `<option value="">All officers</option>${rows
      .map(
        (user) => `<option value="${user.id}" ${
          String(selected) === String(user.id) ? "selected" : ""
        }>${esc(user.name)}${user.department_name ? ` — ${esc(user.department_name)}` : ""}</option>`
      )
      .join("")}`;
  }

  async function renderAdminComplaints(container) {
    await Promise.all([
      loadTaxonomy().catch((error) => console.error(error)),
      loadDepartments().catch((error) => console.error(error)),
      loadWards().catch((error) => console.error(error)),
      loadStaffUsers().catch((error) => console.error(error))
    ]);
    const filters = state.adminFilters;

    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>All complaints</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="admin-complaints-apply">Apply filters</button>
          <button class="secondary small" data-action="admin-complaints-reset">Reset</button>
          <button class="secondary small" data-action="export-complaints">Export CSV</button>
          <button class="secondary small" data-action="export-payments-csv">Export Payments (CSV)</button>
          <button class="secondary small" data-action="refresh-admin">Refresh</button>
        </div>
      </div>
      <p class="map-help">
        Every complaint in the system, including those still awaiting routing. Select one or more rows and
        assign them to any officer; the officer and the department mailbox are alerted by email.
      </p>
      <div class="filter-bar">
        <label class="sr-only" for="admin-c-filter-status">Status</label>
        <select id="admin-c-filter-status">${optionsFrom(
          STATUSES.map((value) => ({ value: value, label: value })),
          "value",
          "label",
          "All statuses",
          filters.status
        )}</select>
        <label class="sr-only" for="admin-c-filter-category">Category</label>
        <select id="admin-c-filter-category">${optionsFrom(
          state.taxonomy ? state.taxonomy.categories : [],
          "id",
          "name",
          "All categories",
          filters.category_id
        )}</select>
        <label class="sr-only" for="admin-c-filter-department">Department</label>
        <select id="admin-c-filter-department">${optionsFrom(
          state.departments,
          "id",
          "name",
          "All departments",
          filters.department_id
        )}</select>
        <label class="sr-only" for="admin-c-filter-officer">Officer</label>
        <select id="admin-c-filter-officer">${adminOfficerOptions(filters.assigned_to)}</select>
        <label class="sr-only" for="admin-c-filter-ward">Ward</label>
        <select id="admin-c-filter-ward">${optionsFrom(
          state.wards,
          "id",
          "name",
          "All wards",
          filters.ward_id
        )}</select>
        <label class="sr-only" for="admin-c-filter-priority">Priority</label>
        <select id="admin-c-filter-priority">${optionsFrom(
          PRIORITIES.map((value) => ({ value: value, label: value })),
          "value",
          "label",
          "All priorities",
          filters.priority
        )}</select>
        <label class="sr-only" for="admin-c-filter-from">Filed from</label>
        <input id="admin-c-filter-from" type="date" value="${esc(filters.from)}" />
        <label class="sr-only" for="admin-c-filter-to">Filed until</label>
        <input id="admin-c-filter-to" type="date" value="${esc(filters.to)}" />
        <label class="sr-only" for="admin-c-filter-search">Search</label>
        <input id="admin-c-filter-search" type="search" placeholder="Reference, title or location"
          value="${esc(filters.search)}" />
        <label class="inline-check">
          <input type="checkbox" id="admin-c-filter-unassigned" ${
            filters.unassigned ? "checked" : ""
          } /> Unassigned only
        </label>
      </div>
      <div class="filter-bar">
        <button class="primary small" data-action="admin-assign-selected">Assign selected complaints</button>
      </div>
      <div id="admin-complaints-list"><p class="loading-text">Loading complaints…</p></div>
    </div>`;

    await loadAdminComplaints();
  }

  function adminComplaintRow(row) {
    return `<tr>
      <td><input type="checkbox" class="admin-complaint-select" value="${row.id}"
        aria-label="Select complaint ${esc(row.reference_no)}" /></td>
      <td class="mono">${esc(row.reference_no)}</td>
      <td>${esc(row.title)}</td>
      <td>${statusTag(row.status)}</td>
      <td>${priorityTag(row.priority)}</td>
      <td>${esc(row.category_name || "—")}</td>
      <td>${esc(row.department_name || "Not routed")}</td>
      <td>${esc(row.assigned_user_name || "Unassigned")}</td>
      <td>${esc(row.ward_name || "—")}</td>
      <td>${esc(fmtDateTime(row.created_at))}</td>
      <td>${esc(fmtDateTime(row.due_at))}${
        row.is_overdue ? ' <span class="overdue-flag">Overdue</span>' : ""
      }</td>
      <td class="record-actions">
        <button type="button" class="secondary small" data-action="open-complaint" data-id="${
          row.id
        }">View</button>
        <button type="button" class="link-button" data-action="admin-assign" data-id="${
          row.id
        }" data-reference="${esc(row.reference_no)}">Assign</button>
      </td>
    </tr>`;
  }

  async function loadAdminComplaints() {
    const container = $("#admin-complaints-list");
    if (!container) return;
    const filters = readAdminFilters();
    const params = new URLSearchParams();
    params.set("page", String(state.adminComplaints.page));
    params.set("limit", String(state.adminComplaints.limit));
    if (filters.status) params.set("status", filters.status);
    if (filters.category_id) params.set("category_id", filters.category_id);
    if (filters.department_id) params.set("department_id", filters.department_id);
    if (filters.assigned_to) params.set("assigned_to", filters.assigned_to);
    if (filters.ward_id) params.set("ward_id", filters.ward_id);
    if (filters.priority) params.set("priority", filters.priority);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.search) params.set("search", filters.search);
    if (filters.unassigned) params.set("unassigned", "1");

    container.innerHTML = `<p class="loading-text">Loading complaints…</p>`;
    try {
      const data = await api(`/api/complaints?${params.toString()}`);
      state.adminComplaints.total = data.total;
      state.adminComplaints.totalPages = data.total_pages;
      container.innerHTML =
        `<p class="muted small">${esc(data.total)} complaint(s) match the current filters.</p>` +
        tableHtml(
          [
            "",
            "Reference",
            "Complaint",
            "Status",
            "Priority",
            "Category",
            "Department",
            "Officer",
            "Ward",
            "Filed",
            "Target",
            ""
          ],
          (data.items || []).map(adminComplaintRow),
          "No complaints match the current filters."
        ) +
        paginationHtml(data.page, data.total_pages, "admin-complaints-page");
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
  }

  function selectedAdminComplaintIds() {
    return $$(".admin-complaint-select")
      .filter((node) => node.checked)
      .map((node) => Number(node.value));
  }

  /**
   * Assignment dialog for one complaint or a bulk selection.
   * The department applied to the whole selection comes from the chosen officer
   * so a complaint is never filed under a department its officer does not belong to.
   */
  async function openAssignDialog(ids, reference) {
    if (!ids.length) {
      toast("Select at least one complaint first.", "warning");
      return;
    }
    await Promise.all([
      loadDepartments().catch((error) => console.error(error)),
      loadStaffUsers().catch((error) => console.error(error))
    ]);

    const officers = state.staffUsers.filter((user) => user.role === "staff" || user.role === "admin");
    const single = ids.length === 1;

    openModal({
      title: single ? `Assign ${reference || "complaint"}` : `Assign ${ids.length} complaints`,
      bodyHtml: `<form id="admin-assign-form" data-ids="${ids.join(",")}">
        ${
          single
            ? `<div class="form-group">
                 <label for="admin-assign-department">Department</label>
                 <select id="admin-assign-department">${optionsFrom(
                   state.departments,
                   "id",
                   "name",
                   "Keep the current department",
                   ""
                 )}</select>
               </div>`
            : ""
        }
        <div class="form-group">
          <label for="admin-assign-officer">Assign to officer</label>
          <select id="admin-assign-officer">
            <option value="">Select an officer…</option>
            ${officers
              .map(
                (user) => `<option value="${user.id}" data-department="${esc(
                  user.department_id || ""
                )}">${esc(user.name)}${user.department_name ? ` — ${esc(user.department_name)}` : ""}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="form-group">
          <label for="admin-assign-note">Assignment note (optional)</label>
          <input id="admin-assign-note" maxlength="500" />
        </div>
        <p class="map-help">
          The selected officer receives an email alert, and the department mailbox is copied when a contact
          address is configured for it.
        </p>
        <div id="admin-assign-error" class="error-message" role="alert"></div>
        <div class="form-actions">
          <button type="submit" class="primary">Assign</button>
          <button type="button" class="secondary" data-action="close-modal">Cancel</button>
        </div>
      </form>`
    });
  }

  async function submitAdminAssign(form) {
    const errorNode = $("#admin-assign-error");
    const ids = String(form.getAttribute("data-ids") || "")
      .split(",")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    const officerNode = $("#admin-assign-officer");
    const officerId = officerNode && officerNode.value ? Number(officerNode.value) : null;
    const departmentNode = $("#admin-assign-department");
    const departmentId = departmentNode && departmentNode.value ? Number(departmentNode.value) : null;
    const note = ($("#admin-assign-note") || {}).value || "";

    if (!ids.length) {
      if (errorNode) errorNode.textContent = "No complaints were selected.";
      return;
    }
    if (!officerId && !departmentId) {
      if (errorNode) errorNode.textContent = "Select an officer or a department to assign to.";
      return;
    }

    const payload = {};
    if (officerId) payload.assigned_user_id = officerId;
    if (departmentId) payload.department_id = departmentId;
    if (note.trim()) payload.note = note.trim();

    const button = $("button[type='submit']", form);
    if (button) {
      button.disabled = true;
      button.textContent = "Assigning…";
    }
    if (errorNode) errorNode.textContent = "";

    let assigned = 0;
    const failures = [];
    for (const id of ids) {
      try {
        await api(`/api/staff/complaints/${id}/assign`, { method: "POST", body: payload });
        assigned += 1;
      } catch (error) {
        failures.push(`#${id}: ${error.message}`);
      }
    }

    if (button) {
      button.disabled = false;
      button.textContent = "Assign";
    }

    if (!assigned) {
      if (errorNode) errorNode.textContent = failures.join(" · ") || "Nothing could be assigned.";
      return;
    }

    toast(
      failures.length
        ? `${assigned} complaint(s) assigned. ${failures.length} could not be assigned: ${failures.join(" · ")}`
        : `${assigned} complaint(s) assigned and the officer alerted by email.`,
      failures.length ? "warning" : "success"
    );
    closeModal();
    await renderAdminTab();
  }

  /* -------------------------------------------------------------------------
   * Email & alerts — Brevo configuration, delivery log and inbox
   * ----------------------------------------------------------------------- */
  async function renderAdminEmail(container) {
    const params = new URLSearchParams();
    params.set("page", String(state.adminEmail.page));
    params.set("limit", String(state.adminEmail.limit));
    if (state.adminEmail.direction) params.set("direction", state.adminEmail.direction);
    if (state.adminEmail.status) params.set("status", state.adminEmail.status);

    const [status, log] = await Promise.all([
      api("/api/email/status"),
      api(`/api/email/log?${params.toString()}`)
    ]);

    const config = status.config || {};
    const missing = config.missing || [];
    const rows = (log.items || []).map(
      (row) => `<tr>
        <td>${esc(fmtDateTime(row.created_at))}</td>
        <td>${row.direction === "inbound" ? "Received" : "Sent"}</td>
        <td>${esc(
          row.direction === "inbound"
            ? row.from_email || "unknown sender"
            : row.to_email || "unknown recipient"
        )}</td>
        <td>${esc(row.subject || "(no subject)")}</td>
        <td>${esc(row.reference_no || "—")}</td>
        <td>${
          row.status === "sent" || row.status === "received"
            ? `<span class="status-tag status-resolved">${esc(row.status)}</span>`
            : `<span class="overdue-flag">${esc(row.status)}</span>`
        }${
          row.error ? `<div class="muted small">${esc(row.error)}</div>` : ""
        }</td>
        <td class="muted small">${esc(row.preview || "")}</td>
      </tr>`
    );

    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>Email &amp; alerts</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="refresh-admin">Refresh</button>
        </div>
      </div>
      <p class="map-help">
        Alert emails are delivered through Brevo. Nothing is reported as delivered unless Brevo accepted the
        message — attempts appear in this log with the exact reason when they were skipped or rejected.
      </p>
      <div class="summary-grid">
        ${statCard("Provider configured", config.configured ? "Yes" : "No", config.sender_email || "No sender address")}
        ${statCard("Alert emails", status.alerts_enabled ? "Enabled" : "Disabled", "Change it under Settings")}
        ${statCard(
          "Inbound webhook",
          config.inbound_webhook_protected ? "Protected" : "Unprotected",
          config.inbound_webhook_path || "/api/email/inbound"
        )}
        ${statCard("Municipal inbox", status.support_inbox || "Not set", "Address citizens reply to")}
      </div>
      ${
        missing.length
          ? `<div class="alert alert-warning">
               Email alerts are not active. Add these environment variables and restart the server:
               <strong>${esc(missing.join(", "))}</strong>
             </div>`
          : `<div class="alert alert-success">Brevo is configured. Alert emails are being delivered.</div>`
      }
      ${
        config.inbound_webhook_protected
          ? ""
          : `<div class="alert alert-warning">
               The inbound webhook is not protected. Set <strong>BREVO_INBOUND_SECRET</strong> and append
               <code>?token=…</code> to the Brevo inbound webhook URL.
             </div>`
      }
      <form id="admin-email-test-form" class="action-panel">
        <div class="form-row two">
          <div class="form-group">
            <label for="admin-email-test-to">Send a test email to</label>
            <input id="admin-email-test-to" type="email" maxlength="160" value="${esc(
              state.user ? state.user.email : ""
            )}" />
          </div>
          <div class="form-group">
            <label>&nbsp;</label>
            <button type="submit" class="secondary small">Send test email</button>
          </div>
        </div>
        <div id="admin-email-test-error" class="error-message" role="alert"></div>
      </form>
    </div>
    <div class="card">
      <div class="card-header">
        <h3>Delivery log (${esc(log.total || 0)})</h3>
      </div>
      <div class="filter-bar">
        <label class="sr-only" for="admin-email-direction">Direction</label>
        <select id="admin-email-direction">
          <option value="" ${state.adminEmail.direction === "" ? "selected" : ""}>All messages</option>
          <option value="outbound" ${state.adminEmail.direction === "outbound" ? "selected" : ""}>Sent by the portal</option>
          <option value="inbound" ${state.adminEmail.direction === "inbound" ? "selected" : ""}>Received from citizens</option>
        </select>
        <label class="sr-only" for="admin-email-status">Status</label>
        <select id="admin-email-status">
          <option value="">All statuses</option>
          ${["sent", "received", "failed", "skipped"]
            .map(
              (value) =>
                `<option value="${value}" ${
                  state.adminEmail.status === value ? "selected" : ""
                }>${value}</option>`
            )
            .join("")}
        </select>
      </div>
      ${tableHtml(
        ["When", "Direction", "Counterparty", "Subject", "Complaint", "Status", "Preview"],
        rows,
        "No email has been sent or received yet."
      )}
      ${paginationHtml(log.page, log.total_pages, "admin-email-page")}
    </div>`;
  }

  async function submitEmailTest(form) {
    const errorNode = $("#admin-email-test-error");
    const to = ($("#admin-email-test-to") || {}).value || "";
    if (errorNode) errorNode.textContent = "";
    try {
      const data = await api("/api/email/test", { method: "POST", body: { to: to.trim() } });
      toast(data.message || "Test email sent.", "success");
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    }
  }

  async function renderAdminTable(container, key) {
    const config = ADMIN_ENTITIES[key];
    if (!config) {
      container.innerHTML = `<p class="error-message">Unknown administration section.</p>`;
      return;
    }
    const data = await api(config.path);
    const rows = (data && data[config.collection]) || [];
    const note = config.noteKey ? data[config.noteKey] : config.note;

    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>${esc(config.heading)} (${esc(rows.length)})</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="admin-create" data-entity="${key}">Add new</button>
          <button class="secondary small" data-action="refresh-admin">Refresh</button>
        </div>
      </div>
      ${note ? `<p class="map-help">${esc(note)}</p>` : ""}
      ${tableHtml(
        config.columns.map((column) => column.label).concat([""]),
        rows.map(
          (row) => `<tr>
            ${config.columns
              .map(
                (column) =>
                  `<td class="${column.className || ""}">${
                    column.render ? column.render(row) : esc(row[column.key] === undefined || row[column.key] === null ? "" : row[column.key])
                  }</td>`
              )
              .join("")}
            <td><button type="button" class="secondary small" data-action="admin-edit" data-entity="${key}" data-id="${
            row.id
          }">Edit</button></td>
          </tr>`
        ),
        "Nothing has been configured in this section yet."
      )}
    </div>`;
  }

  async function renderAdminServices(container) {
    await loadTaxonomy();
    const select = $("#admin-service-category");
    const filter = select ? select.value : "";
    const data = await api(
      `/api/admin/subcategories${filter ? `?category_id=${encodeURIComponent(filter)}` : ""}`
    );
    const rows = (data && data.subcategories) || [];
    const config = ADMIN_ENTITIES.subcategories;

    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>Services and routing rules (${esc(rows.length)})</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="admin-create" data-entity="subcategories">Add service</button>
          <button class="secondary small" data-action="refresh-admin">Refresh</button>
        </div>
      </div>
      <div class="filter-bar">
        <label class="sr-only" for="admin-service-category">Filter by category</label>
        <select id="admin-service-category">${optionsFrom(
          state.taxonomy.categories,
          "id",
          "name",
          "All categories",
          filter
        )}</select>
      </div>
      <p class="map-help">
        Each service is typed as an information service, an online application or a civic complaint, and
        carries the department it routes to. Routing rules are used automatically when a complaint is filed.
      </p>
      ${tableHtml(
        config.columns.map((column) => column.label).concat([""]),
        rows.map((row) => `<tr>
            ${config.columns
              .map((column) => `<td>${column.render ? column.render(row) : esc(row[column.key] || "")}</td>`)
              .join("")}
            <td><button type="button" class="secondary small" data-action="admin-edit" data-entity="subcategories" data-id="${
          row.id
        }">Edit</button></td>
          </tr>`),
        "No services have been configured yet."
      )}
    </div>`;
  }

  function adminFieldHtml(field, record) {
    const id = `admin-field-${field.key}`;
    let value;
    if (record) {
      value = field.fromRecord ? field.fromRecord(record) : record[field.key];
    } else {
      value = field.defaultValue !== undefined ? field.defaultValue : "";
    }

    if (field.type === "checkbox") {
      const checked = record ? Number(value) === 1 || value === true : !!field.defaultValue;
      return `<div class="form-group"><label class="inline-check">
        <input type="checkbox" id="${id}" name="${field.key}" ${checked ? "checked" : ""} /> ${esc(field.label)}
      </label></div>`;
    }
    if (field.type === "textarea") {
      return `<div class="form-group">
        <label for="${id}">${esc(field.label)}</label>
        <textarea id="${id}" name="${field.key}" rows="3" maxlength="${field.max || 2000}">${esc(
        value === null || value === undefined ? "" : value
      )}</textarea>
      </div>`;
    }
    if (field.type === "select") {
      const options = (typeof field.options === "function" ? field.options() : field.options || []).map(
        (option) => (typeof option === "string" ? { value: option, label: option } : option)
      );
      const placeholder = field.placeholder
        ? `<option value="">${esc(field.placeholder)}</option>`
        : "";
      return `<div class="form-group">
        <label for="${id}">${esc(field.label)}</label>
        <select id="${id}" name="${field.key}">${placeholder}${options
        .map(
          (option) =>
            `<option value="${esc(option.value)}" ${
              String(value) === String(option.value) ? "selected" : ""
            }>${esc(option.label)}</option>`
        )
        .join("")}</select>
      </div>`;
    }
    return `<div class="form-group">
      <label for="${id}">${esc(field.label)}</label>
      <input id="${id}" name="${field.key}" type="${field.type || "text"}" ${
      field.max ? `maxlength="${field.max}"` : ""
    } value="${esc(value === null || value === undefined ? "" : value)}" />
    </div>`;
  }

  async function openAdminEditor(entityKey, id) {
    const config = ADMIN_ENTITIES[entityKey];
    if (!config) return;
    if (entityKey === "subcategories") {
      await loadTaxonomy();
    } else if (config.fields.some((field) => typeof field.options === "function")) {
      await Promise.all([
        loadTaxonomy().catch((error) => console.error(error)),
        loadDepartments().catch((error) => console.error(error)),
        loadWards().catch((error) => console.error(error))
      ]);
    }

    let record = null;
    if (id) {
      const data = await api(config.path);
      record = ((data && data[config.collection]) || []).find((row) => String(row.id) === String(id)) || null;
      if (!record) {
        toast("That record could not be found. Refresh and try again.", "error");
        return;
      }
    }

    const fields = config.fields.filter((field) => !(field.createOnly && record));
    openModal({
      title: `${record ? "Edit" : "New"} ${config.label}`,
      bodyHtml: `<form id="admin-editor-form" data-entity="${entityKey}" data-id="${record ? record.id : ""}">
        ${fields.map((field) => adminFieldHtml(field, record)).join("")}
        <div id="admin-editor-error" class="error-message" role="alert"></div>
        <div class="form-actions">
          <button type="submit" class="primary">${record ? "Save changes" : "Create"}</button>
          <button type="button" class="secondary" data-action="close-modal">Cancel</button>
        </div>
      </form>`,
      wide: true
    });
  }

  function adminEditorError(message) {
    const node = $("#admin-editor-error");
    if (node) node.textContent = message || "";
  }

  async function submitAdminEditor(form) {
    const entityKey = form.getAttribute("data-entity");
    const id = form.getAttribute("data-id");
    const config = ADMIN_ENTITIES[entityKey];
    if (!config) return;
    const fields = config.fields.filter((field) => !(field.createOnly && id));
    const payload = {};
    let problem = "";

    for (const field of fields) {
      const node = document.getElementById(`admin-field-${field.key}`);
      if (!node) continue;
      let value;
      if (field.type === "checkbox") {
        value = node.checked;
      } else {
        const raw = node.value.trim();
        if (field.type === "number") {
          if (raw === "") {
            value = null;
          } else {
            value = Number(raw);
            if (!Number.isFinite(value)) {
              problem = problem || `${field.label} must be a number.`;
              continue;
            }
          }
        } else {
          value = raw;
        }
        if (field.required && (value === "" || value === null)) {
          problem = problem || `${field.label} is required.`;
          continue;
        }
      }
      payload[field.key] = field.transform ? field.transform(value) : value;
    }

    adminEditorError(problem);
    if (problem) return;

    const button = $("button[type='submit']", form);
    if (button) {
      button.disabled = true;
      button.textContent = "Saving…";
    }
    try {
      const data = await api(id ? `${config.path}/${id}` : config.path, {
        method: id ? "PATCH" : "POST",
        body: payload
      });
      toast(data.message || "Saved.", "success");
      closeModal();
      await reloadAdminReferences(entityKey);
      await renderAdminTab();
    } catch (error) {
      adminEditorError(error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Save";
      }
    }
  }

  async function reloadAdminReferences(entityKey) {
    try {
      if (entityKey === "departments") {
        state.departments = [];
        await loadDepartments(true);
      } else if (entityKey === "wards") {
        state.wards = [];
        await loadWards(true);
      } else if (entityKey === "categories" || entityKey === "subcategories" || entityKey === "targets") {
        await loadTaxonomy(true);
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function renderAdminStaff(container) {
    const data = await api("/api/admin/staff-users");
    const users = (data && data.users) || [];
    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>Staff accounts (${esc(users.length)})</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="admin-staff-create">Add staff account</button>
          <button class="secondary small" data-action="refresh-admin">Refresh</button>
        </div>
      </div>
      <p class="map-help">
        An officer must belong to the department that handles the complaint. Deactivating an account keeps
        its history and the complaints it handled.
      </p>
      ${tableHtml(
        ["Name", "Email", "Role", "Designation", "Department", "Status", ""],
        users.map(
          (row) => `<tr>
            <td>${esc(row.name)}</td>
            <td>${esc(row.email)}</td>
            <td>${esc(row.role)}</td>
            <td>${esc(row.designation || "—")}</td>
            <td>${esc(row.department_name || "—")}</td>
            <td>${row.is_active ? "Active" : '<span class="overdue-flag">Inactive</span>'}</td>
            <td class="record-actions">
              <button type="button" class="link-button" data-action="admin-staff-edit" data-id="${row.id}">Edit</button>
              <button type="button" class="link-button" data-action="admin-staff-password" data-id="${row.id}">Reset password</button>
            </td>
          </tr>`
        ),
        "No staff accounts have been created yet."
      )}
    </div>`;
  }

  async function openStaffEditor(id) {
    await Promise.all([
      loadDepartments().catch((error) => console.error(error)),
      loadWards().catch((error) => console.error(error))
    ]);
    const data = await api("/api/admin/staff-users");
    const record = id ? (data.users || []).find((row) => String(row.id) === String(id)) || null : null;
    if (id && !record) {
      toast("That account could not be found. Refresh and try again.", "error");
      return;
    }

    openModal({
      title: record ? `Edit ${record.name}` : "New staff account",
      bodyHtml: `<form id="admin-staff-form" data-id="${record ? record.id : ""}">
        <div class="form-row two">
          <div class="form-group">
            <label for="staff-admin-name">Full name *</label>
            <input id="staff-admin-name" maxlength="120" value="${esc(record ? record.name : "")}" />
          </div>
          <div class="form-group">
            <label for="staff-admin-email">Email *</label>
            <input id="staff-admin-email" type="email" maxlength="160" value="${esc(
              record ? record.email : ""
            )}" ${record ? "disabled" : ""} />
          </div>
        </div>
        ${
          record
            ? ""
            : `<div class="form-group">
                 <label for="staff-admin-password">Temporary password * (minimum 6 characters)</label>
                 <input id="staff-admin-password" type="password" maxlength="72" />
               </div>`
        }
        <div class="form-row two">
          <div class="form-group">
            <label for="staff-admin-role">Role</label>
            <select id="staff-admin-role">${["staff", "admin"]
              .map(
                (role) =>
                  `<option value="${role}" ${record && record.role === role ? "selected" : ""}>${role}</option>`
              )
              .join("")}</select>
          </div>
          <div class="form-group">
            <label for="staff-admin-designation">Designation</label>
            <input id="staff-admin-designation" maxlength="120" value="${esc(
              record && record.designation ? record.designation : ""
            )}" />
          </div>
        </div>
        <div class="form-row two">
          <div class="form-group">
            <label for="staff-admin-department">Department</label>
            <select id="staff-admin-department">${optionsFrom(
              state.departments,
              "id",
              "name",
              "None",
              record ? record.department_id : ""
            )}</select>
          </div>
          <div class="form-group">
            <label for="staff-admin-ward">Ward</label>
            <select id="staff-admin-ward">${optionsFrom(
              state.wards,
              "id",
              "name",
              "Not applicable",
              record ? record.ward_id : ""
            )}</select>
          </div>
        </div>
        <div class="form-row two">
          <div class="form-group">
            <label for="staff-admin-phone">Phone</label>
            <input id="staff-admin-phone" maxlength="20" value="${esc(
              record && record.phone ? record.phone : ""
            )}" />
          </div>
          <div class="form-group">
            <label class="inline-check">
              <input type="checkbox" id="staff-admin-active" ${!record || record.is_active ? "checked" : ""} />
              Account active
            </label>
          </div>
        </div>
        <div id="admin-staff-error" class="error-message" role="alert"></div>
        <div class="form-actions">
          <button type="submit" class="primary">${record ? "Save changes" : "Create account"}</button>
          <button type="button" class="secondary" data-action="close-modal">Cancel</button>
        </div>
      </form>`,
      wide: true
    });
  }

  async function submitStaffEditor(form) {
    const id = form.getAttribute("data-id");
    const errorNode = $("#admin-staff-error");
    const name = $("#staff-admin-name").value.trim();
    const payload = {
      name: name,
      role: $("#staff-admin-role").value,
      designation: $("#staff-admin-designation").value.trim(),
      phone: $("#staff-admin-phone").value.trim(),
      department_id: $("#staff-admin-department").value
        ? Number($("#staff-admin-department").value)
        : null,
      ward_id: $("#staff-admin-ward").value ? Number($("#staff-admin-ward").value) : null,
      is_active: $("#staff-admin-active").checked
    };

    if (errorNode) errorNode.textContent = "";
    if (name.length < 3) {
      if (errorNode) errorNode.textContent = "Enter the full name of the officer.";
      return;
    }

    try {
      if (id) {
        await api(`/api/admin/staff-users/${id}`, { method: "PATCH", body: payload });
      } else {
        const email = $("#staff-admin-email").value.trim();
        const password = $("#staff-admin-password").value;
        if (!email) {
          if (errorNode) errorNode.textContent = "Enter the staff email address.";
          return;
        }
        if (password.length < 6) {
          if (errorNode) errorNode.textContent = "Choose a temporary password of at least 6 characters.";
          return;
        }
        await api("/api/admin/staff-users", {
          method: "POST",
          body: Object.assign({}, payload, { email: email, password: password })
        });
      }
      toast(id ? "Account updated." : "Staff account created.", "success");
      closeModal();
      state.staffUsers = [];
      await loadStaffUsers(true).catch((error) => console.error(error));
      await renderAdminTab();
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    }
  }

  function openPasswordReset(id) {
    openModal({
      title: "Reset password",
      bodyHtml: `<form id="admin-password-form" data-id="${id}">
        <p class="muted small">Set a new temporary password and share it through a secure channel.</p>
        <div class="form-group">
          <label for="admin-password-new">New password * (minimum 6 characters)</label>
          <input id="admin-password-new" type="password" maxlength="72" />
        </div>
        <div id="admin-password-error" class="error-message" role="alert"></div>
        <div class="form-actions">
          <button type="submit" class="primary">Update password</button>
          <button type="button" class="secondary" data-action="close-modal">Cancel</button>
        </div>
      </form>`
    });
  }

  async function submitAdminPassword(form) {
    const id = form.getAttribute("data-id");
    const errorNode = $("#admin-password-error");
    const password = $("#admin-password-new").value;
    if (password.length < 6) {
      if (errorNode) errorNode.textContent = "Choose a password of at least 6 characters.";
      return;
    }
    if (errorNode) errorNode.textContent = "";
    try {
      const data = await api(`/api/admin/staff-users/${id}/reset-password`, {
        method: "POST",
        body: { password: password }
      });
      toast(data.message || "Password updated.", "success");
      closeModal();
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    }
  }

  const SETTING_LABELS = {
    escalation_enabled: "Automatic escalation enabled (1 = on, 0 = off)",
    escalation_interval_minutes: "Background escalation sweep interval (minutes)",
    duplicate_radius_meters: "Duplicate detection radius (metres)",
    duplicate_similarity: "Duplicate detection similarity threshold (0.2 – 0.95)",
    public_min_group_count: "Minimum group size published on the public dashboard"
  };

  async function renderAdminSettings(container) {
    const data = await api("/api/admin/settings");
    const editable = data.editable_keys || [];
    const stored = {};
    for (const row of data.settings || []) stored[row.key] = row.value;

    container.innerHTML = `<div class="card">
      <div class="card-header"><h3>Application settings</h3></div>
      <p class="map-help">
        Only the settings listed below can be changed from this screen. Internal keys are read-only and
        are shown for transparency.
      </p>
      <form id="admin-settings-form">
        ${editable
          .map(
            (key) => `<div class="form-group">
              <label for="admin-setting-${key}">${esc(SETTING_LABELS[key] || key)}</label>
              <input id="admin-setting-${key}" name="${key}" value="${esc(
              stored[key] === undefined ? "" : stored[key]
            )}" />
            </div>`
          )
          .join("")}
        <div id="admin-settings-error" class="error-message" role="alert"></div>
        <button type="submit" class="primary small">Save settings</button>
      </form>
      <h4 class="subsection-title">All stored settings</h4>
      ${tableHtml(
        ["Key", "Value", "Last updated"],
        (data.settings || []).map(
          (row) => `<tr>
            <td class="mono">${esc(row.key)}</td>
            <td>${esc(row.value)}</td>
            <td>${esc(fmtDateTime(row.updated_at))}</td>
          </tr>`
        ),
        "No settings have been stored yet."
      )}
    </div>`;
  }

  async function submitAdminSettings(form) {
    const errorNode = $("#admin-settings-error");
    const payload = {};
    for (const node of $$("[id^='admin-setting-']", form)) {
      const key = node.getAttribute("name");
      if (key) payload[key] = node.value.trim();
    }
    if (errorNode) errorNode.textContent = "";
    try {
      const data = await api("/api/admin/settings", { method: "PUT", body: payload });
      toast(data.message || "Settings updated.", "success");
      state.transparency = null;
      await renderAdminTab();
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    }
  }

    async function renderAdminPayments(container) {
    let data;
    try {
      data = await api("/api/admin/payments");
    } catch (error) {
      container.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
      return;
    }

    const stats = data.stats || {};
    const transactions = data.transactions || [];

    const summaryHtml = `<div class="summary-grid">
      <div class="stat-card">
        <div class="stat-label">Total Transactions</div>
        <div class="stat-value">${esc(stats.total_count || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Successful Payments</div>
        <div class="stat-value">${esc(stats.successful_count || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Collected</div>
        <div class="stat-value">₹${esc(((stats.total_collected || 0) / 100).toFixed(2))}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Failed / Pending</div>
        <div class="stat-value">${esc((stats.failed_count || 0) + (stats.pending_count || 0))}</div>
      </div>
    </div>`;

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>Payment Transactions Management</h3>
          <div class="dashboard-actions">
            <button class="secondary small" data-action="export-payments-csv">Export Payments (CSV)</button>
            <button class="secondary small" data-action="refresh-admin">Refresh</button>
          </div>
        </div>
        ${summaryHtml}
        <div class="table-wrapper" style="margin-top: 1.5rem;">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Service / Account</th>
                <th>User</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Method</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              ${transactions.length ? transactions.map((t) => {
                const amount = (t.amount / 100).toFixed(2);
                const typeLabel = {
                  electricity: "⚡ Electricity",
                  water: "💧 Water",
                  property_tax: "🏠 Property Tax"
                }[t.service_type] || t.service_type;
                const statusClass = t.status === "captured" ? "status-paid" : "status-pending";
                return `<tr>
                  <td>${esc(fmtDateTime(t.created_at))}</td>
                  <td><strong>${esc(typeLabel)}</strong><br/><span class="mono muted small">${esc(t.account_number)}</span></td>
                  <td>${esc(t.user_name)}<br/><span class="muted small">${esc(t.user_email)}</span></td>
                  <td><strong>₹${esc(amount)}</strong></td>
                  <td><span class="status-tag ${statusClass}">${esc(t.status)}</span></td>
                  <td>${esc(t.method || "online")}</td>
                  <td>${t.receipt_number ? `<span class="mono small">${esc(t.receipt_number)}</span>` : "—"}</td>
                </tr>`;
              }).join("") : `<tr><td colspan="7" class="empty-state">No payment transactions found.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  async function exportPaymentsCsv() {
    try {
      const response = await api("/api/admin/payments/export", { raw: true });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `municipal_payments_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function renderAdminAudit(container) {
    const params = new URLSearchParams({ page: String(adminAuditPage), limit: "50" });
    const data = await api(`/api/admin/audit-logs?${params.toString()}`);
    adminAuditPage = data.page || 1;

    container.innerHTML = `<div class="card">
      <div class="card-header">
        <h3>Audit trail (${esc(data.total)})</h3>
        <div class="dashboard-actions">
          <button class="secondary small" data-action="refresh-admin">Refresh</button>
        </div>
      </div>
      <p class="map-help">
        Every administrative and complaint action is recorded with the responsible account and the time it
        happened. Records cannot be edited or removed from this screen.
      </p>
      ${tableHtml(
        ["When", "Account", "Action", "Entity", ""],
        (data.items || []).map(
          (row) => `<tr>
            <td>${esc(fmtDateTime(row.created_at))}</td>
            <td>${esc(row.actor_email || (row.user_id ? `User ${row.user_id}` : "System"))}</td>
            <td>${esc(row.action)}</td>
            <td>${esc(row.entity_type || "")}${row.entity_id ? ` #${esc(row.entity_id)}` : ""}</td>
            <td></td>
          </tr>`
        ),
        "No audit records have been written yet."
      )}
      ${paginationHtml(data.page, data.total_pages, "admin-audit-page")}
    </div>`;
  }

  async function exportComplaints() {
    try {
      const response = await api("/api/staff/export/complaints.csv", { raw: true });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `municipal-complaints-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast("Complaint report downloaded.", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* =========================================================================
   * 21. Contact
   * ========================================================================= */
  async function renderContact() {
    await renderOffices($("#contact-offices"));
  }

  /* =========================================================================
   * 22. CivilBot — the portal's civic assistant
   * ========================================================================= */
  const chatbotHistory = [];
  let chatbotMenuShown = false;

  function toggleChatbot() {
    const panel = $("#chatbot-panel");
    if (!panel) return;
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      const input = $("#chatbot-input");
      if (input) input.focus();
      // Initialize chatbot action handlers
      initChatbotActions();
      // Show the quick action buttons automatically the first time the chatbot opens
      if (!chatbotMenuShown) {
        chatbotMenuShown = true;
        showQuickActions();
      }
    }
  }

  // Auto-show the quick action buttons when the chatbot opens for the first time.
  function showQuickActions() {
    const pending = appendChatMessage("CivilBot is reading the municipal records…", "bot");
    api("/api/chatbot", {
      method: "POST",
      body: { message: "quick_actions", conversationHistory: [] }
    }).then((data) => {
      if (pending) pending.remove();
      const reply = (data && (data.response || data.message)) ||
        "Here are the main things I can help you with:";
      if (data && data.actions && data.actions.length > 0) {
        appendChatMessage(data.response || "", "bot", data.actions);
      } else {
        appendChatMessage(reply, "bot");
      }
      chatbotHistory.push({ role: "assistant", content: reply });
    }).catch((error) => {
      if (pending) pending.remove();
      appendChatMessage(
        error.message || "The assistant is unavailable right now. Please try again shortly.",
        "bot"
      );
    });
  }

  function appendChatMessage(text, who, actions = null) {
    const container = $("#chatbot-messages");
    if (!container) return null;
    const wrapper = document.createElement("div");
    wrapper.className = `chatbot-message ${who}`;
    const content = document.createElement("div");
    content.className = "message-content";

    if (typeof text === 'string') {
      // Check if text contains our special action button markers
      if (actions && actions.length > 0) {
        // Render text with action buttons
        content.innerHTML = esc(text).replace(/\n/g, '<br>');

        // Add action buttons
        const actionsDiv = document.createElement("div");
        actionsDiv.className = "chatbot-actions";
        actionsDiv.style.marginTop = "0.5rem";
        actionsDiv.style.display = "flex";
        actionsDiv.style.flexWrap = "wrap";
        actionsDiv.style.gap = "0.5rem";

        actions.forEach(action => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "chatbot-action-btn primary small";
          btn.style.fontSize = "0.75rem";
          btn.style.padding = "0.35rem 0.75rem";
          btn.textContent = action.label;
          btn.dataset.action = action.action;
          if (action.data) {
            Object.entries(action.data).forEach(([key, value]) => {
              btn.dataset[key] = value;
            });
          }
          actionsDiv.appendChild(btn);
        });
        content.appendChild(actionsDiv);
      } else {
        content.textContent = text;
      }
    }

    wrapper.appendChild(content);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
    return wrapper;
  }

  // Handle chatbot action button clicks
  function handleChatbotAction(event) {
    const btn = event.target.closest('.chatbot-action-btn');
    if (!btn) return;

    const action = btn.dataset.action;

    // Simulate user clicking the button - add to history and process
    const label = btn.textContent;
    appendChatMessage(label, "user");
    chatbotHistory.push({ role: "user", content: label });

    // Disable button after click
    const allBtns = document.querySelectorAll('.chatbot-action-btn');
    allBtns.forEach(b => {
      b.disabled = true;
      b.style.opacity = '0.6';
      b.style.cursor = 'not-allowed';
    });

    // Process the action
    processChatbotAction(action, btn.dataset);
  }

  // Process chatbot actions
  async function processChatbotAction(action, data) {
    const input = $("#chatbot-input");
    const button = $("#chatbot-form button[type='submit']");
    if (button) button.disabled = true;
    const pending = appendChatMessage("CivilBot is reading the municipal records…", "bot");

    try {
      const response = await api("/api/chatbot", {
        method: "POST",
        body: {
          message: action,  // Use action as message
          conversationHistory: chatbotHistory.slice(-8),
          action: action,   // Pass action type
          actionData: data  // Pass additional data
        }
      });

      // `response` is the API result; `data` is the button's dataset.
      const reply = (response && (response.response || response.message)) ||
        "I could not answer that. Please rephrase your question, or file the complaint from the Complaints section.";

      if (pending) pending.remove();

      // Check if response has action buttons
      if (response && response.actions && response.actions.length > 0) {
        appendChatMessage(response.response || "", "bot", response.actions);
      } else {
        appendChatMessage(reply, "bot");
      }

      chatbotHistory.push({ role: "assistant", content: reply });
    } catch (error) {
      if (pending) pending.remove();
      appendChatMessage(
        error.message || "The assistant is unavailable right now. Please try again shortly.",
        "bot"
      );
    } finally {
      if (button) button.disabled = false;
      if (input) input.focus();
    }
  }

  async function sendChatbotMessage(event) {
    if (event) event.preventDefault();
    const input = $("#chatbot-input");
    const message = input ? input.value.trim() : "";
    if (!message) return;

    appendChatMessage(message, "user");
    chatbotHistory.push({ role: "user", content: message });
    if (input) input.value = "";

    const button = $("#chatbot-form button[type='submit']");
    if (button) button.disabled = true;
    const pending = appendChatMessage("CivilBot is reading the municipal records…", "bot");

    try {
      const data = await api("/api/chatbot", {
        method: "POST",
        body: { message: message, conversationHistory: chatbotHistory.slice(-8) }
      });
      const reply =
        (data && (data.response || data.message)) ||
        "I could not answer that. Please rephrase your question, or file the complaint from the Complaints section.";
      if (pending) pending.remove();

      // Check if response has action buttons
      if (data && data.actions && data.actions.length > 0) {
        appendChatMessage(data.response || "", "bot", data.actions);
      } else {
        appendChatMessage(reply, "bot");
      }
      chatbotHistory.push({ role: "assistant", content: reply });
    } catch (error) {
      if (pending) pending.remove();
      appendChatMessage(
        error.message || "The assistant is unavailable right now. Please try again shortly.",
        "bot"
      );
    } finally {
      if (button) button.disabled = false;
      if (input) input.focus();
    }
  }

  // Initialize chatbot action handlers
  function initChatbotActions() {
    const container = $("#chatbot-messages");
    if (container) {
      container.addEventListener('click', handleChatbotAction);
    }
  }

  /* =========================================================================
   * 23. Complaint action forms (citizen and staff)
   * ========================================================================= */
  async function submitFeedback(form) {
    const id = form.getAttribute("data-complaint");
    const payload = {
      rating: Number($("#feedback-rating").value),
      was_resolved: $("#feedback-resolved").checked,
      comments: $("#feedback-comments").value.trim()
    };
    try {
      const data = await api(`/api/complaints/${id}/feedback`, { method: "POST", body: payload });
      toast(data.message || "Thank you for your feedback.", "success");
      closeModal();
      refreshCurrentView();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function submitReopenRequest(form) {
    const id = form.getAttribute("data-complaint");
    const reason = $("#reopen-reason").value.trim();
    if (reason.length < 10) {
      modalError("Describe why the issue is not resolved (at least 10 characters).");
      return;
    }
    try {
      const data = await api(`/api/complaints/${id}/reopen-request`, {
        method: "POST",
        body: { reason: reason }
      });
      toast(data.message || "Reopening request sent.", "success");
      closeModal();
      refreshCurrentView();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function submitReopenReview(form) {
    const id = form.getAttribute("data-complaint");
    const requestId = form.getAttribute("data-request");
    const payload = {
      decision: $("#reopen-decision").value,
      notes: $("#reopen-notes").value.trim()
    };
    try {
      const data = await api(
        `/api/staff/complaints/${id}/reopen-requests/${requestId}/review`,
        { method: "POST", body: payload }
      );
      toast(data.message || "Decision recorded.", "success");
      closeModal();
      refreshCurrentView();
      refreshNotificationCount();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function submitStaffStatus(form) {
    const id = form.getAttribute("data-complaint");
    const status = $("#staff-status").value;
    const payload = { status: status };
    const remarks = $("#staff-remarks").value.trim();
    const notes = $("#staff-resolution-notes").value.trim();
    const reason = $("#staff-rejection-reason").value.trim();
    if (remarks) payload.remarks = remarks;
    if (notes) payload.resolution_notes = notes;
    if (reason) payload.rejection_reason = reason;

    if (status === "Resolved" && notes.length < 15) {
      modalError("Resolution notes of at least 15 characters are required before a complaint can be resolved.");
      return;
    }
    if (status === "Rejected" && reason.length < 10) {
      modalError("A rejection reason of at least 10 characters is required.");
      return;
    }

    try {
      const data = await api(`/api/staff/complaints/${id}/status`, { method: "PATCH", body: payload });
      toast(data.message || "Status updated.", "success");
      closeModal();
      refreshCurrentView();
      refreshNotificationCount();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function submitStaffAssign(form) {
    const id = form.getAttribute("data-complaint");
    const payload = {};
    const department = $("#staff-assign-department").value;
    const officer = $("#staff-assign-officer").value;
    const note = $("#staff-assign-note").value.trim();
    if (department) payload.department_id = Number(department);
    if (officer) payload.assigned_user_id = Number(officer);
    if (note) payload.note = note;
    if (!payload.department_id && !payload.assigned_user_id) {
      modalError("Choose a department or an officer to assign this complaint.");
      return;
    }
    try {
      const data = await api(`/api/staff/complaints/${id}/assign`, { method: "POST", body: payload });
      toast(data.message || "Complaint assigned.", "success");
      closeModal();
      refreshCurrentView();
      refreshNotificationCount();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function submitStaffPriority(form) {
    const id = form.getAttribute("data-complaint");
    try {
      const data = await api(`/api/staff/complaints/${id}/priority`, {
        method: "PATCH",
        body: { priority: $("#staff-priority").value }
      });
      toast(data.message || "Priority updated.", "success");
      closeModal();
      refreshCurrentView();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function submitStaffNote(form) {
    const id = form.getAttribute("data-complaint");
    const note = $("#staff-note").value.trim();
    if (note.length < 2) {
      modalError("Write an update of at least 2 characters.");
      return;
    }
    try {
      const data = await api(`/api/staff/complaints/${id}/notes`, {
        method: "POST",
        body: { note: note, visibility: $("#staff-note-visibility").value }
      });
      toast(data.message || "Update added.", "success");
      closeModal();
      refreshCurrentView();
      refreshNotificationCount();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function submitStaffEvidence(form) {
    const id = form.getAttribute("data-complaint");
    const input = $("#staff-evidence");
    if (!input || !input.files.length) {
      modalError("Select at least one photo or video of the completed work.");
      return;
    }
    const payload = new FormData();
    for (const file of input.files) {
      payload.append(file.type.startsWith("video/") ? "video" : "image", file);
    }
    try {
      const data = await api(`/api/staff/complaints/${id}/attachments`, {
        method: "POST",
        form: payload
      });
      toast(data.message || "Resolution evidence uploaded.", "success");
      closeModal();
      refreshCurrentView();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function submitStaffDuplicate(form) {
    const id = form.getAttribute("data-complaint");
    const reference = $("#staff-duplicate-reference").value.trim();
    const reason = $("#staff-duplicate-reason").value.trim();
    if (!reference) {
      modalError("Enter the reference number of the original complaint.");
      return;
    }
    modalError("");
    try {
      const found = await api(`/api/complaints?search=${encodeURIComponent(reference)}&limit=10`);
      const wanted = reference.toUpperCase();
      const rows = (found && found.items) || [];
      const match = rows.find((row) => String(row.reference_no).toUpperCase() === wanted);
      if (!match) {
        modalError(`No complaint with reference ${reference} is visible to your account.`);
        return;
      }
      const payload = { duplicate_of_id: match.id };
      if (reason) payload.reason = reason;
      const data = await api(`/api/staff/complaints/${id}/duplicates`, { method: "POST", body: payload });
      toast(data.message || "Complaints linked.", "success");
      closeModal();
      refreshCurrentView();
    } catch (error) {
      modalError(error.message);
    }
  }

  async function runEscalations() {
    try {
      const data = await api("/api/staff/escalations/run", { method: "POST", body: {} });
      const created = data && Array.isArray(data.escalated) ? data.escalated.length : 0;
      toast(
        created ? `${created} overdue complaint(s) escalated.` : data.message || "No complaint needed escalation.",
        created ? "success" : "info"
      );
      await refreshStaffTab();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function acknowledgeEscalation(id) {
    try {
      const data = await api(`/api/staff/escalations/${id}/acknowledge`, { method: "POST", body: {} });
      toast(data.message || "Escalation acknowledged.", "success");
      await refreshStaffTab();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* =========================================================================
   * 24. Event wiring and bootstrap
   * ========================================================================= */
  function refreshStaffSubcategoryFilter() {
    const categorySelect = $("#staff-filter-category");
    const subSelect = $("#staff-filter-subcategory");
    if (!subSelect || !state.taxonomy) return;
    const categoryId = categorySelect ? categorySelect.value : "";
    const subs = [];
    for (const category of state.taxonomy.categories) {
      for (const sub of category.subcategories || []) {
        if (!categoryId || String(sub.category_id) === String(categoryId)) {
          subs.push({ id: sub.id, name: `${category.name} › ${sub.name}` });
        }
      }
    }
    const previous = subSelect.value;
    subSelect.innerHTML = optionsFrom(subs, "id", "name", "All issue types", previous);
    state.staffFilters.category_id = categoryId;
    state.staffFilters.subcategory_id = subSelect.value;
  }

  function resetStaffFilters() {
    state.staffFilters = {
      status: "",
      category_id: "",
      subcategory_id: "",
      ward_id: "",
      department_id: "",
      priority: "",
      search: "",
      from: "",
      to: "",
      window: "",
      unassigned: false
    };
    state.staffQueue.page = 1;
  }

  async function handleAction(action, element, id, page) {
    switch (action) {
      case "close-modal":
        closeModal();
        break;
      case "new-complaint":
        closeModal();
        navigate("complaints");
        break;
      case "browse-category":
        state.serviceFocus = element.getAttribute("data-category");
        navigate("services");
        break;
      case "start-complaint":
        closeModal();
        state.pendingService = {
          categoryId: element.getAttribute("data-category") || null,
          subcategoryId: element.getAttribute("data-sub") || null
        };
        navigate("complaints");
        break;
      case "start-application":
        closeModal();
        openApplicationForm(element.getAttribute("data-sub"));
        break;
      case "open-service":
        openServiceDetail(element.getAttribute("data-sub"));
        break;
      case "open-complaint":
        openComplaintDetail(id);
        break;
      case "open-application":
        openApplicationDetail(id);
        break;
      case "open-document":
        openPrivateDocument(element.getAttribute("data-url"), element.getAttribute("data-mime"));
        break;
      case "track-reference":
        await trackReference();
        break;
      case "use-my-location":
        useMyLocation(element.getAttribute("data-map-target") || "complaint");
        break;
      case "clear-pin":
        clearPin(element.getAttribute("data-map-target") || "complaint");
        break;
      case "check-duplicates":
        await checkDuplicates();
        break;
      case "reset-complaint-form":
        resetComplaintForm();
        break;
      case "refresh-my-complaints":
        await loadMyComplaints();
        break;
      case "apply-my-filters":
        applyMyFilters();
        break;
      case "my-complaints-page":
        state.myComplaints.page = Number(page) || 1;
        await loadMyComplaints();
        break;
      case "dashboard-tab":
        state.dashboardTab = element.getAttribute("data-tab");
        state.myComplaints.page = 1;
        state.myApps.page = 1;
        state.myPayments.page = 1;
        await refreshDashboardTab();
        break;
      case "dashboard-complaints-page":
        state.myComplaints.page = Number(page) || 1;
        await loadDashboardComplaints();
        break;
      case "dashboard-applications-page":
        state.myApps.page = Number(page) || 1;
        await loadDashboardApplications();
        break;
      case "dashboard-payments-page":
        state.myPayments.page = Number(page) || 1;
        await loadDashboardPayments();
        break;
      case "apply-payment-filters":
        state.myPayments.page = 1;
        await loadDashboardPayments();
        break;
      case "refresh-payments":
        await loadDashboardPayments();
        break;
      case "open-profile":
        state.dashboardTab = "profile";
        if (currentRoute() === "dashboard") await refreshDashboardTab();
        else navigate("dashboard");
        break;
      case "refresh-dashboard":
        await renderDashboard();
        break;
      case "mark-notification":
        await markNotificationRead(id);
        break;
      case "mark-all-notifications":
        await markAllNotifications();
        break;
      case "open-notifications":
        await openNotifications();
        break;
      case "staff-tab":
        state.staffTab = element.getAttribute("data-tab");
        state.staffQueue.page = 1;
        await refreshStaffTab();
        break;
      case "apply-staff-filters":
        readStaffFilters();
        state.staffQueue.page = 1;
        await loadStaffQueue();
        break;
      case "reset-staff-filters":
        resetStaffFilters();
        await renderStaffQueue($("#staff-content"));
        break;
      case "staff-queue-page":
        state.staffQueue.page = Number(page) || 1;
        await loadStaffQueue();
        break;
      case "run-escalations":
        await runEscalations();
        break;
      case "ack-escalation":
        await acknowledgeEscalation(id);
        break;
      case "refresh-staff-tab":
        await refreshStaffTab();
        break;
      case "refresh-staff":
        await renderStaff();
        break;
      case "admin-tab":
        state.adminTab = element.getAttribute("data-tab");
        adminAuditPage = 1;
        await renderAdminTab();
        break;
      case "login-tab": {
        state.loginTab = element.getAttribute("data-tab");
        const tab = LOGIN_TABS.find((row) => row.key === state.loginTab) || LOGIN_TABS[0];
        renderTabBar($("#login-tabs"), LOGIN_TABS, tab.key, "login-tab");
        const heading = $("#login-heading");
        if (heading) heading.textContent = tab.heading;
        const hint = $("#login-hint");
        if (hint) hint.textContent = tab.hint;
        const errorNode = $("#login-error");
        if (errorNode) errorNode.textContent = "";
        break;
      }
      case "login-fill": {
        const account = ((state.loginDefaults && state.loginDefaults.accounts) || []).find(
          (row) => row.email === id
        );
        if (!account || !account.password) break;
        fillLoginCredentials(account.email, account.password);
        toast(`${account.label} credentials filled in — select "Sign in" to continue.`, "success");
        break;
      }
      case "refresh-admin":
        await renderAdminTab();
        break;
      case "admin-create":
        await openAdminEditor(element.getAttribute("data-entity"), null);
        break;
      case "admin-edit":
        await openAdminEditor(element.getAttribute("data-entity"), id);
        break;
      case "admin-staff-create":
        await openStaffEditor(null);
        break;
      case "admin-staff-edit":
        await openStaffEditor(id);
        break;
      case "admin-staff-password":
        openPasswordReset(id);
        break;
      case "admin-audit-page":
        adminAuditPage = Number(page) || 1;
        await renderAdminTab();
        break;
      case "admin-complaints-apply":
        readAdminFilters();
        state.adminComplaints.page = 1;
        await loadAdminComplaints();
        break;
      case "admin-complaints-reset":
        resetAdminFilters();
        await renderAdminTab();
        break;
      case "admin-complaints-page":
        state.adminComplaints.page = Number(page) || 1;
        await loadAdminComplaints();
        break;
      case "admin-assign":
        await openAssignDialog([Number(id)], element.getAttribute("data-reference"));
        break;
      case "admin-assign-selected":
        await openAssignDialog(selectedAdminComplaintIds());
        break;
      case "admin-email-page":
        state.adminEmail.page = Number(page) || 1;
        await renderAdminTab();
        break;
      case "export-complaints":
        await exportComplaints();
        break;
      case "pay-bill":
        await openPaymentModal(id, element.getAttribute("data-amount"));
        break;
      case "view-bill":
        await openBillDetailModal(id);
        break;
      case "view-receipt":
        await openReceiptModal(id);
        break;
      case "toggle-chatbot":
        toggleChatbot();
        break;
      case "logout":
        handleLogout();
        break;
      default:
        break;
    }
  }

  const FORM_HANDLERS = {
    "complaint-form": () => submitComplaint(),
    "login-form": (event) => handleLogin(event),
    "register-form": (event) => handleRegister(event),
    "chatbot-form": (event) => sendChatbotMessage(event),
    "feedback-form": (event, form) => submitFeedback(form),
    "reopen-request-form": (event, form) => submitReopenRequest(form),
    "reopen-review-form": (event, form) => submitReopenReview(form),
    "staff-status-form": (event, form) => submitStaffStatus(form),
    "staff-assign-form": (event, form) => submitStaffAssign(form),
    "staff-priority-form": (event, form) => submitStaffPriority(form),
    "staff-note-form": (event, form) => submitStaffNote(form),
    "staff-evidence-form": (event, form) => submitStaffEvidence(form),
    "staff-duplicate-form": (event, form) => submitStaffDuplicate(form),
    "application-form": (event, form) => submitApplication(form),
    "application-status-form": (event, form) => updateApplicationStatus(form),
    "profile-form": (event, form) => saveProfile(form),
    "admin-editor-form": (event, form) => submitAdminEditor(form),
    "admin-staff-form": (event, form) => submitStaffEditor(form),
    "admin-password-form": (event, form) => submitAdminPassword(form),
    "admin-settings-form": (event, form) => submitAdminSettings(form),
    "admin-assign-form": (event, form) => submitAdminAssign(form),
    "admin-email-test-form": (event, form) => submitEmailTest(form)
  };

  let serviceSearchTimer = null;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;

    const actionElement = target.closest("[data-action]");
    if (actionElement) {
      const action = actionElement.getAttribute("data-action");
      handleAction(
        action,
        actionElement,
        actionElement.getAttribute("data-id"),
        actionElement.getAttribute("data-page")
      ).catch((error) => {
        console.error(error);
        toast(error.message || "That action could not be completed.", "error");
      });
      return;
    }

    const routeElement = target.closest("[data-route]");
    if (routeElement) {
      event.preventDefault();
      navigate(routeElement.getAttribute("data-route"));
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form || !form.id) return;
    const handler = FORM_HANDLERS[form.id];
    if (!handler) return;
    event.preventDefault();
    Promise.resolve(handler(event, form)).catch((error) => {
      console.error(error);
      toast(error.message || "That form could not be submitted.", "error");
    });
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!target || !target.id) return;
    if (target.id === "complaint-category") populateSubcategories(true);
    else if (target.id === "complaint-subcategory") updateSubcategoryHelp();
    else if (target.id === "staff-filter-category") refreshStaffSubcategoryFilter();
    else if (target.id === "service-filter-kind") renderServiceList();
    else if (target.id === "admin-service-category") renderAdminTab();
    else if (target.id === "admin-email-direction") {
      state.adminEmail.direction = target.value;
      state.adminEmail.page = 1;
      renderAdminTab();
    } else if (target.id === "admin-email-status") {
      state.adminEmail.status = target.value;
      state.adminEmail.page = 1;
      renderAdminTab();
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target && target.id === "service-search") {
      clearTimeout(serviceSearchTimer);
      serviceSearchTimer = setTimeout(() => renderServiceList(), 200);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const target = event.target;
    if (!target || !target.id) return;
    if (target.id === "track-reference") {
      event.preventDefault();
      trackReference().catch((error) => toast(error.message, "error"));
    } else if (target.id === "my-filter-search") {
      event.preventDefault();
      applyMyFilters();
    } else if (target.id === "staff-filter-search") {
      event.preventDefault();
      readStaffFilters();
      state.staffQueue.page = 1;
      loadStaffQueue().catch((error) => toast(error.message, "error"));
    } else if (target.id === "admin-c-filter-search") {
      event.preventDefault();
      readAdminFilters();
      state.adminComplaints.page = 1;
      loadAdminComplaints().catch((error) => toast(error.message, "error"));
    }
  });

  window.addEventListener("hashchange", () => {
    renderRoute();
  });

  async function verifySession() {
    try {
      const data = await api("/api/auth/me");
      if (data && data.user) {
        state.user = data.user;
        localStorage.setItem(STORAGE.user, JSON.stringify(data.user));
        updateAuthUI();
      }
    } catch (error) {
      if (error.status === 401) {
        clearSession();
        toast("Your session has expired. Please sign in again.", "warning");
        renderRoute();
      }
    }
  }

  function bootstrap() {
    try {
      const token = localStorage.getItem(STORAGE.token);
      const cached = localStorage.getItem(STORAGE.user);
      if (token) {
        state.token = token;
        if (cached) state.user = JSON.parse(cached);
      }
    } catch (error) {
      console.error(error);
    }
    updateAuthUI();
    if (!location.hash) {
      history.replaceState(null, "", "#/home");
    }
    renderRoute();
    if (state.token) verifySession();
  }

  bootstrap();
})();

const SUPABASE_URL = "https://sskhdfahnmutbtautwug.supabase.co";
const SUPABASE_KEY = "sb_publishable_tqZia5sUkcjLDExkb_Eulw_I8XPZfw9";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

async function loadEntries() {
  const { data, error } = await supabaseClient
    .from("entries")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Database error:", error.message);
    return;
  }

  console.log("Database entries:", data);
}

loadEntries();
