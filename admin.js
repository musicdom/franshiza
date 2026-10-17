(() => {
  const $ = (id) => document.getElementById(id);
  const loginPanel = $("login-panel");
  const dashboard = $("dashboard");
  const loginForm = $("login-form");
  const loginMessage = $("login-message");
  const dashboardMessage = $("dashboard-message");
  const list = $("request-list");
  const statuses = [
    ["new", "Новая"],
    ["in_progress", "В работе"],
    ["done", "Завершена"],
    ["archived", "Архив"]
  ];

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || (response.status === 401 ? "Требуется войти заново." : "Запрос не выполнен."));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function showLogin(message = "") {
    loginPanel.hidden = false;
    dashboard.hidden = true;
    loginMessage.textContent = message;
  }

  function showDashboard() {
    loginPanel.hidden = true;
    dashboard.hidden = false;
  }

  function field(label, value, extraClass = "") {
    const wrap = document.createElement("div");
    if (extraClass) wrap.className = extraClass;
    const title = document.createElement("span");
    title.className = "field-label";
    title.textContent = label;
    const content = document.createElement("div");
    content.className = "field-value";
    content.textContent = value || "—";
    wrap.append(title, content);
    return wrap;
  }

  function statusSelect(item) {
    const label = document.createElement("label");
    label.textContent = "Статус";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Статус заявки " + item.id);
    for (const [value, name] of statuses) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = name;
      option.selected = item.status === value;
      select.append(option);
    }
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await api("/api/admin/request", {
          method: "PATCH",
          body: JSON.stringify({ id: item.id, status: select.value })
        });
        dashboardMessage.textContent = "Статус заявки обновлён.";
      } catch (error) {
        dashboardMessage.textContent = error.message;
        if (error.status === 401) showLogin(error.message);
        select.value = item.status;
      } finally {
        select.disabled = false;
      }
    });
    label.append(select);
    return label;
  }

  function renderRequest(item) {
    const card = document.createElement("article");
    card.className = "request-card";
    const top = document.createElement("div");
    top.className = "request-card-top";
    const heading = document.createElement("div");
    const name = document.createElement("h2");
    name.textContent = item.name || "Без имени";
    const id = document.createElement("div");
    id.className = "request-id";
    id.textContent = "ID: " + item.id;
    heading.append(name, id);
    const date = document.createElement("time");
    date.className = "request-date";
    date.dateTime = item.createdAt || "";
    date.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString("ru-RU") : "Дата не указана";
    top.append(heading, date);

    const fields = document.createElement("div");
    fields.className = "request-fields";
    fields.append(
      field("Контакт", item.contact),
      field("Бизнес / отрасль", item.business),
      field("Продукт", item.productId),
      field("Согласие", item.consentAt ? new Date(item.consentAt).toLocaleString("ru-RU") : "Не указано"),
      field("Комментарий", item.comment, "request-comment")
    );

    const footer = document.createElement("div");
    footer.className = "request-footer";
    footer.append(statusSelect(item));
    const delivery = document.createElement("span");
    delivery.className = "delivery" + (item.notificationStatus === "sent" ? " sent" : "");
    delivery.textContent = item.notificationStatus === "sent"
      ? "Уведомление в MAX отправлено"
      : item.notificationStatus === "MAX_NOT_CONFIGURED"
        ? "MAX не настроен"
        : "Уведомление: " + (item.notificationStatus || "ожидает");
    footer.append(delivery);
    card.append(top, fields, footer);
    return card;
  }

  async function loadRequests() {
    dashboardMessage.textContent = "Загружаем заявки…";
    $("refresh-button").disabled = true;
    try {
      const result = await api("/api/admin/requests?limit=100");
      list.replaceChildren(...result.requests.map(renderRequest));
      $("request-count").textContent = String(result.requests.length);
      $("empty-state").hidden = result.requests.length > 0;
      dashboardMessage.textContent = result.requests.length ? "" : "Заявок пока нет.";
      showDashboard();
    } catch (error) {
      if (error.status === 401) showLogin(error.message);
      else dashboardMessage.textContent = error.message;
    } finally {
      $("refresh-button").disabled = false;
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = loginForm.querySelector("button[type=submit]");
    button.disabled = true;
    loginMessage.textContent = "";
    try {
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: $("admin-password").value })
      });
      $("admin-password").value = "";
      await loadRequests();
    } catch (error) {
      loginMessage.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $("refresh-button").addEventListener("click", loadRequests);
  $("logout-button").addEventListener("click", async () => {
    $("logout-button").disabled = true;
    try { await api("/api/admin/logout", { method: "POST", body: "{}" }); }
    catch (error) { dashboardMessage.textContent = error.message; }
    finally {
      $("logout-button").disabled = false;
      showLogin("Вы вышли из панели.");
    }
  });

  loadRequests().catch(() => showLogin());
})();
