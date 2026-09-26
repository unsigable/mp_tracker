// =========================================================
// mp tracker — статический дашборд для GitHub Pages (без backend).
// Читает готовый data.json (см. export_static.py) вместо живого /api/state —
// вся остальная логика отображения/фильтрации/сортировки та же, что и в
// web/app.js. Нет кнопки "Обновить сейчас" и модалки "Источники": здесь
// нет работающего сервера, который мог бы что-то скачать или сохранить —
// данные обновляются вручную через export_static.py + git push (см. README).
// =========================================================

const STATUS_COLOR_ORDER = ["green", "blue", "amber", "purple", "cyan", "pink", "red"];
const statusColorCache = {};

// Осмысленная (не хеш-случайная) подсветка для часто встречающихся
// статусов -- в частности, для этапов маркировки/ЧЗ ("Завершено" и т.п.),
// но применяется одинаково к любому status-подобному полю (см.
// STATUS_LIKE_KEYS ниже), в т.ч. к обычному "status" каталога/заказов,
// если там встретится такое же слово. Ключ -- статус в нижнем регистре;
// проверяется сначала точное совпадение, затем вхождение подстроки (на
// случай статуса вида "Не требуется (авто)"). Всё, чего нет в этом
// списке, получает случайный, но ПОСТОЯННЫЙ цвет через хеш, как раньше.
const STATUS_COLOR_MAP = {
  "завершено": "green",
  "выполнено": "green",
  "готово": "green",
  "отгружен": "green",
  "промаркировано": "green",
  "в работе": "blue",
  "в процессе": "blue",
  "взяли в работу": "blue",
  "в очереди": "amber",
  "не требуется": "grey",
  "без маркировки": "grey",
  "новый": "cyan",
  "отменено": "red",
  "отменен": "red",
  "отменён": "red",
  "ошибка": "red",
};

// Поля, которые отображаются цветным "pill", а не простым текстом (см.
// cellHtml/openDetail). "status" -- каталог/заказы; остальные пять --
// этапы раздела "Маркировка" (см. view_columns.MARKING_COLUMNS).
const STATUS_LIKE_KEYS = new Set([
  "status", "gtin_status", "cards_status", "km_status", "transgran_status", "barcode_status",
]);

let STATE = null;
let ACTIVE_TAB = "catalog";
let FILTERS = {
  catalog: { q: "", status: "Все", model: "Все", fabric: "Все" },
  orderitems: { q: "", order: "Все", model: "Все" },
  articles: { q: "" },
  models: { q: "" },
  marking: { q: "" },
  shipments: { q: "" },
};
// Активная "книжная" вкладка-переключатель по ссылкам источника (см.
// renderLinkTabs/baseDataFor) — отдельно для "orderitems" и "models",
// поскольку это независимые сводки. "Все" — сводный вид без разбивки
// (совпадает со старым поведением, когда у источника всего одна ссылка).
const ACTIVE_LINK = { orderitems: "Все", models: "Все", articles: "Все", marking: "Все" };
// Состояние сортировки по клику на заголовок колонки, отдельно на каждую
// вкладку: {key, dir: "asc"|"desc"} или null (обычный, несортированный порядок).
const SORT = { catalog: null, orderitems: null, articles: null, models: null };

// ---------- утилиты ----------

function fmtValue(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function colorForStatus(status) {
  if (!status) return "grey";
  const key = String(status).trim().toLowerCase();
  if (STATUS_COLOR_MAP[key]) return STATUS_COLOR_MAP[key];
  for (const needle in STATUS_COLOR_MAP) {
    if (key.includes(needle)) return STATUS_COLOR_MAP[needle];
  }
  if (statusColorCache[status]) return statusColorCache[status];
  let hash = 0;
  for (let i = 0; i < status.length; i++) hash = (hash * 31 + status.charCodeAt(i)) >>> 0;
  const color = STATUS_COLOR_ORDER[hash % STATUS_COLOR_ORDER.length];
  statusColorCache[status] = color;
  return color;
}

function statusPill(status) {
  if (!status) return "";
  const c = colorForStatus(status);
  return `<span class="status-pill status-${c}"><span class="dot"></span>${escapeHtml(status)}</span>`;
}

function showToast(msg, kind) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (kind ? " toast-" + kind : "");
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function uniqueSorted(list) {
  return Array.from(new Set(list.filter((v) => v !== null && v !== undefined && v !== ""))).sort();
}

// Иногда в ссылку на заказ попадает случайно приклеенный текст перед
// http(s):// (например, название модели). Бэкенд уже чистит такие ссылки
// при сохранении (см. url_utils.clean_url в Python), но на всякий случай
// делаем то же самое здесь перед переходом по ссылке — второй рубеж защиты
// на случай, если в браузере открыт снапшот данных, сохранённый до этого
// исправления.
function cleanUrl(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  const m = s.match(/https?:\/\/\S+/i);
  if (!m) return s;
  return m[0].replace(/[.,;:!?)\]}»"']+$/, "");
}

// ---------- загрузка состояния ----------

// Кэш-бастинг (?t=...) на случай агрессивного кэширования GitHub Pages/CDN —
// иначе после git push можно долго видеть старые данные из кэша браузера.
async function loadState() {
  const res = await fetch("./data.json?t=" + Date.now());
  if (!res.ok) throw new Error("Не удалось загрузить data.json (" + res.status + ")");
  STATE = await res.json();
  renderAll();
}

// ---------- общий рендер шапки/статистики ----------

function renderTop() {
  document.getElementById("updatedAt").textContent = STATE.updated_at || "—";
  document.getElementById("statRecords").textContent = STATE.records.length;
  document.getElementById("statOrderItems").textContent = STATE.orders.length;
  document.getElementById("statArticles").textContent = STATE.articles.length;
  document.getElementById("statModels").textContent = STATE.models.length;
  document.getElementById("statErrors").textContent = STATE.errors.length;

  const errBadge = document.getElementById("errorsBadge");
  if (STATE.errors.length) {
    errBadge.textContent = STATE.errors.length + " ошибок обновления";
    errBadge.classList.remove("badge-hidden");
    errBadge.title = STATE.errors.slice(0, 10).join("\n");
  } else {
    errBadge.classList.add("badge-hidden");
  }

  const srcList = document.getElementById("sourcesList");
  srcList.innerHTML = (STATE.meta.sources || [])
    .map((s) => `<div class="src-item" title="${escapeHtml(s)}">${escapeHtml(s)}</div>`)
    .join("") || "—";
}

const TAB_TITLES = {
  catalog: "Каталог / производство",
  orderitems: "Заказы",
  articles: "По артикулам",
  models: "По моделям",
  marking: "Маркировка",
  shipments: "Отгрузки",
};

function setActiveTab(tab) {
  ACTIVE_TAB = tab;
  document.getElementById("pageTitle").textContent = TAB_TITLES[tab];
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.tab === tab);
  });
  renderFilterbar();
  renderTable();
}

// ---------- filterbar ----------

function renderFilterbar() {
  const bar = document.getElementById("filterbar");
  bar.innerHTML = "";

  const addSearch = (placeholder, onInput, value) => {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = placeholder;
    inp.value = value || "";
    inp.addEventListener("input", () => { onInput(inp.value); renderTable(); });
    bar.appendChild(inp);
  };

  const addSelect = (label, options, current, onChange) => {
    const wrap = document.createElement("span");
    wrap.className = "f-label";
    wrap.textContent = label;
    bar.appendChild(wrap);
    const sel = document.createElement("select");
    ["Все", ...options].forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o;
      if (o === current) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => { onChange(sel.value); renderTable(); });
    bar.appendChild(sel);
  };

  if (ACTIVE_TAB === "catalog") {
    const cat = STATE.records;
    addSearch("Поиск по каталогу…", (v) => (FILTERS.catalog.q = v), FILTERS.catalog.q);
    addSelect("Статус", uniqueSorted(cat.map((r) => r.status)), FILTERS.catalog.status,
      (v) => (FILTERS.catalog.status = v));
    addSelect("Модель", uniqueSorted(cat.map((r) => r.model_name)), FILTERS.catalog.model,
      (v) => (FILTERS.catalog.model = v));
    addSelect("Ткань", uniqueSorted(cat.map((r) => r.fabric_type)), FILTERS.catalog.fabric,
      (v) => (FILTERS.catalog.fabric = v));
  } else if (ACTIVE_TAB === "orderitems") {
    const data = baseDataFor("orderitems");
    addSearch("Поиск по заказам…", (v) => (FILTERS.orderitems.q = v), FILTERS.orderitems.q);
    addSelect("Заказ №", uniqueSorted(data.map((o) => o.order_number)), FILTERS.orderitems.order,
      (v) => (FILTERS.orderitems.order = v));
    addSelect("Модель", uniqueSorted(data.flatMap((o) => o.models || [])), FILTERS.orderitems.model,
      (v) => (FILTERS.orderitems.model = v));
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "в одной строке — все артикулы/цвета/размеры заказа; клик по строке — список позиций";
    bar.appendChild(hint);
  } else if (ACTIVE_TAB === "articles") {
    addSearch("Поиск по артикулам…", (v) => (FILTERS.articles.q = v), FILTERS.articles.q);
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "показывает только артикулы, встретившиеся хотя бы в одном заказе";
    bar.appendChild(hint);
  } else if (ACTIVE_TAB === "shipments") {
    addSearch("Поиск по отгрузкам…", (v) => (FILTERS.shipments.q = v), FILTERS.shipments.q);
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "одна строка — одна отгрузка (совпадают дата и номер накладной)";
    bar.appendChild(hint);
  } else if (ACTIVE_TAB === "marking") {
    addSearch("Поиск по маркировке…", (v) => (FILTERS.marking.q = v), FILTERS.marking.q);
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "этапы Честного Знака по номеру заказа — отдельный вид данных, не каталог";
    bar.appendChild(hint);
  } else if (ACTIVE_TAB === "models") {
    addSearch("Поиск по моделям…", (v) => (FILTERS.models.q = v), FILTERS.models.q);
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "модели с разным написанием, но одинаковым текстом без учёта регистра/пробелов — одна строка";
    bar.appendChild(hint);
  }
}

// ---------- таблица ----------

function columnsFor(tab) {
  if (tab === "catalog") {
    const visible = new Set(STATE.meta.visible_catalog_columns);
    return STATE.meta.catalog_fields.filter((f) => visible.has(f.key));
  }
  if (tab === "orderitems") return STATE.meta.order_columns;
  if (tab === "articles") return STATE.meta.article_columns;
  if (tab === "models") return STATE.meta.model_columns;
  if (tab === "marking") return STATE.meta.marking_columns;
  if (tab === "shipments") return STATE.meta.shipment_columns;
  return [];
}

// "Книжные" вкладки (см. README -> "Несколько ссылок/листов на один
// источник"): для orderitems/models данные могут быть разбиты по тому,
// из какой именно названной ссылки источника "Производство ТМ" они
// произошли (см. collector._link_label / aggregate.bucket_order_items_by_link).
// Возвращает исходный (ещё не отфильтрованный по поиску) массив строк —
// либо сводный (STATE.orders/STATE.models), либо срез по одной ссылке.
function baseDataFor(tab) {
  if (tab === "catalog") return STATE.records;
  if (tab === "marking") {
    const label = ACTIVE_LINK.marking;
    if (label === "Все" || !(STATE.marking_link_labels || []).length) return STATE.marking || [];
    return (STATE.marking_by_link && STATE.marking_by_link[label]) || [];
  }
  if (tab === "shipments") return STATE.shipments || [];
  if (tab === "articles") {
    const label = ACTIVE_LINK.articles;
    if (label === "Все" || !(STATE.article_link_labels || []).length) return STATE.articles;
    return (STATE.articles_by_link && STATE.articles_by_link[label]) || [];
  }
  if (tab === "orderitems") {
    const label = ACTIVE_LINK.orderitems;
    if (label === "Все" || !(STATE.link_labels || []).length) return STATE.orders;
    return (STATE.orders_by_link && STATE.orders_by_link[label]) || [];
  }
  if (tab === "models") {
    const label = ACTIVE_LINK.models;
    if (label === "Все" || !(STATE.link_labels || []).length) return STATE.models;
    return (STATE.models_by_link && STATE.models_by_link[label]) || [];
  }
  return [];
}

function rowsFor(tab) {
  const data = baseDataFor(tab);
  if (tab === "catalog") {
    const f = FILTERS.catalog;
    const q = f.q.trim().toLowerCase();
    return data.filter((r) => {
      if (f.status !== "Все" && r.status !== f.status) return false;
      if (f.model !== "Все" && r.model_name !== f.model) return false;
      if (f.fabric !== "Все" && r.fabric_type !== f.fabric) return false;
      if (q) {
        const hay = STATE.meta.catalog_fields.map((c) => fmtValue(r[c.key])).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  if (tab === "orderitems") {
    // Фильтр/поиск работают ОДИНАКОВО независимо от того, какая "книжная"
    // вкладка сейчас выбрана (см. baseDataFor выше) -- ничего не сбрасывается
    // при переключении между ссылками.
    const f = FILTERS.orderitems;
    const q = f.q.trim().toLowerCase();
    return data.filter((o) => {
      if (f.order !== "Все" && String(o.order_number) !== f.order) return false;
      if (f.model !== "Все" && !(o.models || []).includes(f.model)) return false;
      if (q) {
        const hay = STATE.meta.order_columns.map((c) => fmtValue(o[c.key])).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  if (tab === "articles") {
    const q = FILTERS.articles.q.trim().toLowerCase();
    return data.filter((a) => {
      if (!q) return true;
      const hay = STATE.meta.article_columns.map((c) => fmtValue(a[c.key])).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  if (tab === "shipments") {
    const q = FILTERS.shipments.q.trim().toLowerCase();
    return data.filter((r) => {
      if (!q) return true;
      const hay = STATE.meta.shipment_columns.map((c) => fmtValue(r[c.key])).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  if (tab === "marking") {
    const q = FILTERS.marking.q.trim().toLowerCase();
    return data.filter((r) => {
      if (!q) return true;
      const hay = STATE.meta.marking_columns.map((c) => fmtValue(r[c.key])).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  if (tab === "models") {
    const q = FILTERS.models.q.trim().toLowerCase();
    return data.filter((m) => {
      if (!q) return true;
      const hay = STATE.meta.model_columns.map((c) => fmtValue(m[c.key])).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  return [];
}

function cellHtml(key, value) {
  if (STATUS_LIKE_KEYS.has(key)) {
    const pill = statusPill(fmtValue(value));
    return pill || '<span style="color:var(--text-faint)">—</span>';
  }
  const s = fmtValue(value);
  return s === "" ? '<span style="color:var(--text-faint)">—</span>' : escapeHtml(s);
}

// ---------- сортировка по клику на заголовок (три состояния: по возрастанию/убыванию/обычный) ----------

function onHeaderClick(tab, key) {
  const cur = SORT[tab];
  if (!cur || cur.key !== key) {
    SORT[tab] = { key, dir: "asc" };
  } else if (cur.dir === "asc") {
    SORT[tab] = { key, dir: "desc" };
  } else {
    SORT[tab] = null; // третий клик — назад к обычному порядку
  }
  renderTable();
}

function applySort(rows, tab) {
  const s = SORT[tab];
  if (!s) return rows;
  const dir = s.dir === "desc" ? -1 : 1;
  // Индекс сохраняем, чтобы сортировка была устойчивой (стабильной) —
  // строки с одинаковым значением не "перемешиваются" на каждый клик.
  return rows
    .map((row, i) => [row, i])
    .sort((a, b) => {
      let va = a[0][s.key];
      let vb = b[0][s.key];
      if (Array.isArray(va)) va = va.join(", ");
      if (Array.isArray(vb)) vb = vb.join(", ");
      const emptyA = va === null || va === undefined || va === "";
      const emptyB = vb === null || vb === undefined || vb === "";
      if (emptyA && emptyB) return a[1] - b[1];
      if (emptyA) return 1; // пустые значения — всегда в конец, независимо от направления
      if (emptyB) return -1;
      const na = typeof va === "number" ? va : parseFloat(String(va).replace(",", "."));
      const nb = typeof vb === "number" ? vb : parseFloat(String(vb).replace(",", "."));
      const bothNumeric = !Number.isNaN(na) && !Number.isNaN(nb) && String(va).trim() !== "" && String(vb).trim() !== "";
      if (bothNumeric) {
        return (na - nb) * dir || a[1] - b[1];
      }
      return (String(va).localeCompare(String(vb), "ru") * dir) || a[1] - b[1];
    })
    .map((pair) => pair[0]);
}

// ---------- "книжные" вкладки переключения по ссылкам-источникам ----------

function linkLabelsFor(tab) {
  if (tab === "marking") return STATE.marking_link_labels || [];
  if (tab === "articles") return STATE.article_link_labels || [];
  if (tab === "orderitems" || tab === "models") return STATE.link_labels || [];
  return [];
}

function renderLinkTabs() {
  const bar = document.getElementById("linkTabs");
  const labels = linkLabelsFor(ACTIVE_TAB);
  const applicable = ACTIVE_TAB === "orderitems" || ACTIVE_TAB === "models"
    || ACTIVE_TAB === "articles" || ACTIVE_TAB === "marking";
  if (!applicable || !labels.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  const current = ACTIVE_LINK[ACTIVE_TAB];
  bar.innerHTML = ["Все", ...labels].map((label) =>
    `<button type="button" class="link-tab${label === current ? " is-active" : ""}" data-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`
  ).join("");
  bar.querySelectorAll(".link-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      ACTIVE_LINK[ACTIVE_TAB] = btn.dataset.label;
      renderFilterbar(); // список значений в фильтрах (заказ №/модель) зависит от активной ссылки
      renderTable();
    });
  });
}

function renderTable() {
  const cols = columnsFor(ACTIVE_TAB);
  let rows = rowsFor(ACTIVE_TAB);
  rows = applySort(rows, ACTIVE_TAB);
  const totalForTab = baseDataFor(ACTIVE_TAB).length;

  renderLinkTabs();

  const sortState = SORT[ACTIVE_TAB];
  const thead = document.getElementById("tableHead");
  thead.innerHTML = "<tr>" + cols.map((c) => {
    const isSorted = sortState && sortState.key === c.key;
    const arrow = isSorted ? (sortState.dir === "asc" ? "▲" : "▼") : "";
    return `<th data-key="${escapeHtml(c.key)}" class="${isSorted ? "is-sorted" : ""}">`
      + `${escapeHtml(c.label)}<span class="sort-arrow">${arrow}</span></th>`;
  }).join("") + "</tr>";
  Array.from(thead.querySelectorAll("th")).forEach((th) => {
    th.addEventListener("click", () => onHeaderClick(ACTIVE_TAB, th.dataset.key));
  });

  const tbody = document.getElementById("tableBody");
  const table = document.getElementById("dataTable");
  const empty = document.getElementById("emptyState");

  if (!rows.length) {
    tbody.innerHTML = "";
    table.classList.add("hidden");
    empty.classList.remove("hidden");
  } else {
    table.classList.remove("hidden");
    empty.classList.add("hidden");
    tbody.innerHTML = rows.map((r, idx) => {
      const tds = cols.map((c) => `<td>${cellHtml(c.key, r[c.key])}</td>`).join("");
      return `<tr data-idx="${idx}">${tds}</tr>`;
    }).join("");

    Array.from(tbody.children).forEach((tr) => {
      tr.addEventListener("click", () => openDetail(rows[Number(tr.dataset.idx)], cols));
    });
  }

  document.getElementById("rowCount").innerHTML =
    `показано <span class="accent">${rows.length}</span> из <span class="accent">${totalForTab}</span>`;
}

// ---------- модалка деталей ----------

function openDetail(row, cols) {
  const overlay = document.getElementById("modalOverlay");
  const body = document.getElementById("modalBody");
  const foot = document.getElementById("modalFoot");

  const fullFields = ACTIVE_TAB === "catalog" ? STATE.meta.catalog_fields
    : ACTIVE_TAB === "orderitems" ? STATE.meta.order_columns
    : cols; // для articles/models показываем те же колонки, что и в таблице

  document.getElementById("modalTitle").textContent =
    ACTIVE_TAB === "catalog" ? "Запись каталога"
    : ACTIVE_TAB === "orderitems" ? "Заказ " + fmtValue(row.order_number)
    : ACTIVE_TAB === "shipments" ? "Отгрузка " + fmtValue(row.shipment_date) + " — " + fmtValue(row.invoice_number)
    : ACTIVE_TAB === "marking" ? "Маркировка — заказ " + fmtValue(row.order_number)
    : ACTIVE_TAB === "articles" ? "Артикул " + fmtValue(row.article)
    : "Модель " + fmtValue(row.display_name);

  let html = fullFields.map((f) => {
    const v = fmtValue(row[f.key]);
    const valueHtml = STATUS_LIKE_KEYS.has(f.key) ? statusPill(v) : (v === "" ? '<span class="empty">—</span>' : escapeHtml(v));
    return `<div class="detail-row"><span class="detail-label">${escapeHtml(f.label)}</span><span class="detail-value">${valueHtml}</span></div>`;
  }).join("");

  // Заказ схлопнут в одну строку (все артикулы/цвета/размеры вместе) —
  // здесь же, в детальной карточке, показываем полную раскладку по
  // отдельным SKU-позициям (артикул+цвет+размер), чтобы данные не терялись.
  if (ACTIVE_TAB === "orderitems") {
    const detailCols = STATE.meta.order_item_detail_columns || [];
    const labels = Object.fromEntries(STATE.meta.order_item_fields.map((f) => [f.key, f.label]));
    const items = STATE.order_items.filter((it) => String(it.order_number) === String(row.order_number));
    html += `<div class="detail-subtitle">Позиции заказа (${items.length})</div>`;
    html += '<div class="detail-subtable-wrap"><table class="detail-subtable"><thead><tr>' +
      detailCols.map((k) => `<th>${escapeHtml(labels[k] || k)}</th>`).join("") +
      "</tr></thead><tbody>" +
      items.map((it) => "<tr>" + detailCols.map((k) => `<td>${cellHtml(k, it[k])}</td>`).join("") + "</tr>").join("") +
      "</tbody></table></div>";
  }

  // Отгрузка тоже схлопнута в одну строку (см. aggregate.build_shipment_index) —
  // здесь показываем полную раскладку по "сырым" строкам этой отгрузки со
  // всеми колонками исходного листа (по требованию: остальные данные —
  // только в карточке, не в основной строке).
  if (ACTIVE_TAB === "shipments") {
    const detailCols = STATE.meta.shipment_detail_columns || [];
    const labels = Object.fromEntries((STATE.meta.shipment_fields || []).map((f) => [f.key, f.label]));
    const items = (STATE.shipment_items || []).filter((it) => it._shipment_key === row.shipment_key);
    html += `<div class="detail-subtitle">Строк в отгрузке (${items.length})</div>`;
    html += '<div class="detail-subtable-wrap"><table class="detail-subtable"><thead><tr>' +
      detailCols.map((k) => `<th>${escapeHtml(labels[k] || k)}</th>`).join("") +
      "</tr></thead><tbody>" +
      items.map((it) => "<tr>" + detailCols.map((k) => `<td>${cellHtml(k, it[k])}</td>`).join("") + "</tr>").join("") +
      "</tbody></table></div>";
  }

  body.innerHTML = html;

  const link = cleanUrl(row.order_link || row.invoice_link);
  const linkLabel = row.invoice_link && !row.order_link ? "Открыть ссылку на накладную →" : "Открыть ссылку на заказ →";
  foot.innerHTML = link
    ? `<a class="link-btn" href="${escapeHtml(link)}" target="_blank" rel="noopener">${linkLabel}</a>`
    : "";

  overlay.classList.remove("hidden");
}

function closeDetail() {
  document.getElementById("modalOverlay").classList.add("hidden");
}

// ---------- инициализация ----------

function renderAll() {
  renderTop();
  renderFilterbar();
  renderTable();
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
  document.getElementById("modalClose").addEventListener("click", closeDetail);
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "modalOverlay") closeDetail();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });

  loadState().catch((e) => showToast(String(e.message || e), "error"));
});
