const $ = (id) => document.getElementById(id);
const base = new URL("../", import.meta.url).href.replace(/\/$/, "");
let context = { application_name: "application", application_url: "/" };
let timer,
  logs = [],
  cursor = 0,
  logStart,
  busy = false;

function status(message, error = false) {
  $("admin-status").textContent = message;
  $("admin-status").classList.toggle("error", error);
}
function denied(code) {
  clearInterval(timer);
  logs = [];
  cursor = 0;
  renderResources(null);
  $("dashboard").hidden = true;
  $("access").hidden = false;
  $("access-title").textContent =
    code === 401
      ? `Sign in as a ${context.application_name} administrator`
      : "Administrator access required";
  $("access-message").textContent =
    code === 401
      ? `Open ${context.application_name}, sign in, then return here and check access.`
      : "This account cannot view or change server settings or logs.";
  $("network-form").reset();
  $("runtime-form").reset();
  for (const id of [
    "addresses",
    "save-queue",
    "admin-rooms",
    "log-entries",
    "account",
  ])
    $(id).replaceChildren();
}
async function api(path = "", options = {}) {
  const cookie = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${context.csrf_cookie}=`));
  const response = await fetch(base + path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(context.csrf_header && cookie
        ? {
            [context.csrf_header]: decodeURIComponent(
              cookie.slice(cookie.indexOf("=") + 1),
            ),
          }
        : {}),
    },
  });
  if (response.status === 401 || response.status === 403)
    denied(response.status);
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof value?.detail === "string"
        ? value.detail
        : `Request failed (${response.status})`,
    );
  if (path === "/context") {
    const applicationUrl = response.headers.get("X-Netplay-Application-URL");
    if (applicationUrl) value.application_url = applicationUrl;
  }
  return value;
}
function renderResources(value) {
  const percentage = (number) =>
    Number.isFinite(number) ? `${number.toFixed(1)}%` : "Collecting…";
  const bytes = (number) => {
    if (!Number.isFinite(number)) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const index =
      number > 0
        ? Math.min(
            Math.max(0, Math.floor(Math.log(number) / Math.log(1024))),
            units.length - 1,
          )
        : 0;
    return `${(number / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  };
  for (const id of ["service-cpu", "service-memory", "service-network"])
    $(id).textContent = "—";
  for (const id of [
    "service-cpu-detail",
    "service-memory-detail",
    "service-network-detail",
  ])
    $(id).textContent = "";
  $("resource-updated").textContent = value
    ? `Sampled ${new Date(value.sampledAt).toLocaleTimeString()}`
    : "Resource usage is unavailable on this bridge.";
  if (!value) return;
  const { service } = value;
  const scope = service.scope === "container" ? "container" : "process";
  $("service-cpu-label").textContent = `Bridge ${scope} CPU`;
  $("service-memory-label").textContent = `Bridge ${scope} memory`;
  $("service-cpu").textContent = percentage(service.cpuPercent);
  $("service-cpu-detail").textContent = `${service.cores} CPU capacity`;
  $("service-memory").textContent = bytes(service.usedBytes);
  $("service-memory-detail").textContent = service.limitBytes
    ? `${percentage(service.memoryPercent)} of ${bytes(service.limitBytes)} limit`
    : "No container memory limit reported";
  const network = service.network;
  if (!network) {
    $("service-network").textContent = "Unavailable";
    $("service-network-detail").textContent =
      "Container network statistics are unavailable.";
    return;
  }
  const rate = (number) =>
    Number.isFinite(number) ? `${bytes(number)}/s` : "Collecting…";
  $("service-network").textContent =
    `↓ ${rate(network.rxBytesPerSecond)}\n↑ ${rate(network.txBytesPerSecond)}`;
  $("service-network-detail").textContent =
    `Received ${bytes(network.rxBytes)} · Sent ${bytes(network.txBytes)}`;
}
function rows(id, values, text) {
  $(id).replaceChildren(
    ...values.map((value) => {
      const row = document.createElement("li");
      row.textContent = text(value);
      return row;
    }),
  );
}
async function load(initialize = false) {
  const value = await api();
  const { broker } = value;
  renderResources(broker.resources);
  $("access").hidden = true;
  $("dashboard").hidden = false;
  $("account").textContent = `Administrator: ${value.username}`;
  $("last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  $("bridge-status").textContent = "Online";
  $("active-rooms").textContent =
    `${broker.rooms.length} / ${broker.settings.maxRooms}`;
  $("pending-saves").textContent = broker.saves.pending;
  $("failed-saves").textContent = broker.saves.failed;
  const addresses = [
    ["Public bridge", value.public_url],
    ["RetroArch host", value.native_host],
    ["Internal bridge", value.internal_url],
    [
      "Native ports",
      `${broker.transport.nativePortStart}–${broker.transport.nativePortEnd}`,
    ],
    [
      "Allowed browser origins",
      broker.transport.allowedOrigins.join(", ") ||
        "Not restricted by the bridge",
    ],
  ];
  $("addresses").replaceChildren(
    ...addresses.flatMap(([name, address]) => {
      const dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = name;
      dd.textContent = address;
      return [dt, dd];
    }),
  );
  if (initialize) {
    $("public-url").value = value.network.public_url;
    $("native-host").value = value.network.native_host;
    $("public-url").placeholder = value.defaults.public_url;
    $("native-host").placeholder =
      value.defaults.native_host || "Use public bridge hostname";
    $("rooms-enabled").checked = broker.settings.roomsEnabled;
    $("max-rooms").value = broker.settings.maxRooms;
    $("max-rooms").max = broker.capacity;
    $("save-interval").value = broker.settings.saveIntervalSeconds;
  }
  $("save-runtime").disabled = !broker.persistent;
  $("persistence").textContent = broker.persistent
    ? "Settings are stored on the server and survive restarts."
    : "Configure persistent bridge storage before changing these settings.";
  $("sync-saves").disabled = !broker.saves.enabled || !broker.saves.pending;
  $("queue-empty").hidden = broker.saves.pending > 0;
  if (!broker.saves.enabled)
    $("queue-empty").textContent = "Server save storage is not configured.";
  else $("queue-empty").textContent = "No saves waiting for synchronization.";
  rows(
    "save-queue",
    broker.saves.queue,
    (entry) =>
      `Room ${entry.roomId} · Account ${entry.owner} · ROM ${entry.romId} · Frame ${entry.frame}${entry.error ? ` · ${entry.error}` : " · Waiting for sync"}`,
  );
  $("admin-rooms-empty").hidden = broker.rooms.length > 0;
  rows(
    "admin-rooms",
    broker.rooms,
    (room) =>
      `${room.system.toUpperCase()} · Room ${room.id} · ${room.current}/${room.players} players · ${room.running ? "Playing" : "Waiting"}${room.port ? ` · Port ${room.port}` : ""}`,
  );
}
function renderLogs() {
  const query = $("log-search").value.toLowerCase();
  const filtered = logs.filter((entry) =>
    JSON.stringify(entry).toLowerCase().includes(query),
  );
  $("logs-message").textContent = filtered.length
    ? `${filtered.length} events`
    : query
      ? "No matching events."
      : "No bridge events recorded yet.";
  $("log-entries").replaceChildren(
    ...filtered
      .slice()
      .reverse()
      .map((entry) => {
        const row = document.createElement("li"),
          time = document.createElement("time"),
          event = document.createElement("strong"),
          fields = document.createElement("pre");
        time.dateTime = entry.time;
        time.textContent = new Date(entry.time).toLocaleTimeString();
        event.textContent = entry.event;
        fields.textContent = JSON.stringify(entry.fields);
        row.append(time, event, fields);
        return row;
      }),
  );
}
async function refreshLogs() {
  const value = await api(`/logs?after=${cursor}`);
  if (logStart !== undefined && logStart !== value.startedAt) {
    logs = [];
    cursor = 0;
    logStart = value.startedAt;
    return refreshLogs();
  }
  logStart = value.startedAt;
  logs = [
    ...new Map(
      [...logs, ...value.events].map((entry) => [entry.id, entry]),
    ).values(),
  ].slice(-500);
  cursor = value.cursor;
  renderLogs();
}
async function checkAccess() {
  $("check-access").disabled = true;
  clearInterval(timer);
  try {
    context = await api("/context");
    for (const [id, text] of [
      ["application-link", "Open"],
      ["signin-link", "Sign in to"],
    ]) {
      $(id).href = context.application_url;
      $(id).textContent = `${text} ${context.application_name}`;
    }
    await load(true);
    status("Connected to the bridge.");
    timer = setInterval(async () => {
      if (document.hidden || busy) return;
      try {
        await load();
        if (!$("logs-panel").hidden && $("live-logs").checked)
          await refreshLogs();
      } catch (error) {
        $("bridge-status").textContent = "Unavailable";
        status(error.message, true);
      }
    }, 5000);
  } catch (error) {
    $("access-message").textContent = error.message;
    status(error.message, true);
  } finally {
    $("check-access").disabled = false;
  }
}
async function action(button, operation, message) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  try {
    await operation();
    await load();
    status(message);
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    button.disabled = false;
  }
}
$("runtime-form").onsubmit = (event) => {
  event.preventDefault();
  void action(
    $("save-runtime"),
    () =>
      api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          roomsEnabled: $("rooms-enabled").checked,
          maxRooms: Number($("max-rooms").value),
          saveIntervalSeconds: Number($("save-interval").value),
        }),
      }),
    "Multiplayer settings saved. Existing games stay connected.",
  );
};
$("network-form").onsubmit = (event) => {
  event.preventDefault();
  void action(
    event.submitter ?? $("network-form").querySelector('[type="submit"]'),
    () =>
      api("/network", {
        method: "PUT",
        body: JSON.stringify({
          public_url: $("public-url").value.trim(),
          native_host: $("native-host").value.trim(),
        }),
      }),
    "Connection addresses saved for new connections.",
  );
};
$("reset-addresses").onclick = () => {
  $("public-url").value = "";
  $("native-host").value = "";
  $("network-form").requestSubmit(
    $("network-form").querySelector('[type="submit"]'),
  );
};
$("sync-saves").onclick = () =>
  void action(
    $("sync-saves"),
    async () => {
      const result = await api("/saves/sync", { method: "POST" });
      if (result.pending)
        throw new Error(
          `${result.pending} saves are still pending. Check the queue for details.`,
        );
    },
    "Save synchronization completed.",
  );
function selectTab(name, focus = false) {
  for (const tab of ["settings", "logs"]) {
    const selected = name === tab;
    $(`${tab}-tab`).setAttribute("aria-selected", String(selected));
    $(`${tab}-tab`).tabIndex = selected ? 0 : -1;
    $(`${tab}-panel`).hidden = !selected;
  }
  if (focus) $(`${name}-tab`).focus();
  if (name === "logs")
    void Promise.all([load(), refreshLogs()]).catch((error) =>
      status(error.message, true),
    );
}
for (const name of ["settings", "logs"]) {
  $(`${name}-tab`).onclick = () => selectTab(name);
  $(`${name}-tab`).onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectTab(
      event.key === "Home"
        ? "settings"
        : event.key === "End"
          ? "logs"
          : name === "settings"
            ? "logs"
            : "settings",
      true,
    );
  };
}
$("log-search").oninput = renderLogs;
$("refresh-logs").onclick = () =>
  void Promise.all([load(), refreshLogs()]).catch((error) =>
    status(error.message, true),
  );
$("download-logs").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([logs.map((entry) => JSON.stringify(entry)).join("\n")], {
      type: "application/x-ndjson",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "netplay-bridge-logs.jsonl";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("theme").onchange = () => {
  document.documentElement.style.colorScheme = $("theme").value || "light dark";
};
$("check-access").onclick = checkAccess;
window.addEventListener("pagehide", () => clearInterval(timer));
void checkAccess();
