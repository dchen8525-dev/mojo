/* mojo GUI — vanilla JS client. Talks to the local backend over SSE + POST. */

const token = location.hash.slice(1);
const $ = (sel) => document.querySelector(sel);

/* ---------------- API ---------------- */

async function api(path, body, method) {
  const opts = { method: method ?? (body ? "POST" : "GET"), headers: { "x-agent-token": token } };
  if (body) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    toast("鉴权失败：请通过完整 URL（含 #token）打开页面", true);
    throw new Error("unauthorized");
  }
  return res.json().catch(() => ({}));
}

function toast(msg, isError) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = isError ? "error" : "";
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 4000);
}

/* ---------------- XSS scrub ---------------- */

const BAD_TAGS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "STYLE", "META", "BASE", "FORM"]);

function scrub(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild;
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (BAD_TAGS.has(child.tagName)) {
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const n = attr.name.toLowerCase();
        const v = attr.value.trim().toLowerCase();
        if (n.startsWith("on") || ((n === "href" || n === "src") && v.startsWith("javascript:"))) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

function renderMarkdown(el, text) {
  el.innerHTML = scrub(marked.parse(text ?? "", { breaks: true }));
  // copy buttons on code blocks
  el.querySelectorAll("pre").forEach((pre) => {
    const btn = document.createElement("button");
    btn.className = "copy";
    btn.textContent = "复制";
    btn.onclick = () => {
      navigator.clipboard.writeText(pre.innerText.replace(/^复制\n?/, ""));
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制"), 1500);
    };
    pre.appendChild(btn);
  });
  el.querySelectorAll("a").forEach((a) => a.setAttribute("target", "_blank"));
}

/* ---------------- state ---------------- */

const state = {
  busy: false,
  planMode: false,
  mode: "default",
  sessionId: "",
  items: [], // {kind, ...} finalized transcript entries
  liveTurn: null, // {turnId, text, thinking, tools[]}
  images: [], // pending attachments {media_type, data}
  perms: [], // queued permission requests
};

const transcriptEl = $("#transcript");

/* ---------------- rendering ---------------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function makeUserItem(text, images) {
  const wrap = el("div", "msg user");
  if (text) wrap.appendChild(el("div", "", text));
  const count = typeof images === "number" ? images : images?.length ?? 0;
  if (count) wrap.appendChild(el("div", "", `🖼 ${count} 张图片`));
  for (const img of Array.isArray(images) ? images : []) {
    const i = document.createElement("img");
    i.src = `data:${img.source.media_type};base64,${img.source.data}`;
    i.style.cssText = "max-height:160px;display:block;margin-top:6px;border-radius:6px";
    wrap.appendChild(i);
  }
  return wrap;
}

function makeAssistantItem(text) {
  const wrap = el("div", "msg assistant");
  const md = el("div", "md");
  renderMarkdown(md, text);
  wrap.appendChild(md);
  return wrap;
}

function makeSystemItem(text, kind, highlight) {
  const div = el("div", `msg system${kind === "error" ? " error" : ""}`);
  if (highlight && text) {
    // Emphasize case-insensitive occurrences of the highlight term (e.g. the
    // /search query) with <mark>; everything else stays a plain text node.
    const re = new RegExp(highlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) div.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.textContent = m[0];
      div.appendChild(mark);
      last = m.index + m[0].length;
      if (!m[0].length) re.lastIndex++; // zero-length guard
    }
    div.appendChild(document.createTextNode(text.slice(last)));
  } else {
    div.textContent = text;
  }
  return div;
}

function makeToolCard(tool) {
  const card = el("div", "tool-card");
  const head = el("div", "tool-head");
  const dot = el("span", "tool-status " + (tool.ok === undefined ? "running" : tool.ok ? "ok" : "err"));
  head.appendChild(dot);
  head.appendChild(el("span", "tool-name", "⚡ " + tool.name));
  head.appendChild(el("span", "tool-preview", tool.result ? tool.result.split("\n")[0] : tool.inputPreview || "正在生成参数…"));
  const body = el("div", "tool-body");
  const pre = el("pre");
  pre.textContent = `入参: ${tool.inputPreview || "…"}\n结果: ${tool.result ?? "…"}`;
  body.appendChild(pre);
  head.onclick = () => card.classList.toggle("open");
  card.appendChild(head);
  card.appendChild(body);
  card._tool = tool;
  return card;
}

function refreshToolCard(card) {
  const t = card._tool;
  card.querySelector(".tool-status").className = "tool-status " + (t.ok === undefined ? "running" : t.ok ? "ok" : "err");
  card.querySelector(".tool-preview").textContent = t.result ? t.result.split("\n")[0] : t.inputPreview || "正在生成参数…";
  card.querySelector(".tool-body pre").textContent = `入参: ${t.inputPreview || "…"}\n结果: ${t.result ?? "…"}`;
}

/* ---- thinking card ---- */

function makeThinkingCard(text, open) {
  const card = el("div", "tool-card thinking-card" + (open ? " open" : ""));
  const head = el("div", "tool-head");
  head.appendChild(el("span", "think-icon", "💭"));
  head.appendChild(el("span", "tool-name", "思考过程"));
  head.appendChild(el("span", "tool-preview", firstLine(text)));
  const body = el("div", "tool-body");
  const pre = el("pre");
  pre.textContent = text;
  body.appendChild(pre);
  head.onclick = () => card.classList.toggle("open");
  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function firstLine(text) {
  const line = (text ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

function refreshThinkingCard(card, text) {
  card.querySelector(".tool-preview").textContent = firstLine(text);
  const pre = card.querySelector(".tool-body pre");
  pre.textContent = text;
  if (card.classList.contains("open")) pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
}

function scrollBottom() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function appendItem(node) {
  transcriptEl.appendChild(node);
  updateWelcome();
  scrollBottom();
}

/* Welcome screen shows only while the transcript is empty. */
function updateWelcome() {
  const empty = !transcriptEl.childElementCount && !state.liveTurn;
  $("#welcome").classList.toggle("hidden", !empty);
  transcriptEl.classList.toggle("hidden", !!empty);
}

/* Live streaming: thinking card + assistant bubble + tool cards, rebuilt from state.liveTurn. */
let liveNodes = null; // {thinkEl, textEl, mdEl, waitEl, toolEls: Map<id, card>, renderQueued}

function mountLive() {
  unmountLive();
  if (!state.liveTurn) return;
  liveNodes = { toolEls: new Map() };
  if (state.liveTurn.thinking) {
    liveNodes.thinkEl = makeThinkingCard(state.liveTurn.thinking, true);
    transcriptEl.appendChild(liveNodes.thinkEl);
  }
  liveNodes.textEl = el("div", "msg assistant");
  liveNodes.mdEl = el("div", "md streaming");
  liveNodes.textEl.appendChild(liveNodes.mdEl);
  if (!state.liveTurn.text) liveNodes.textEl.classList.add("hidden");
  transcriptEl.appendChild(liveNodes.textEl);
  if (state.liveTurn.text || state.liveTurn.thinking) {
    liveNodes.waitEl = null;
  } else {
    liveNodes.waitEl = makeWaitIndicator();
    transcriptEl.appendChild(liveNodes.waitEl);
  }
  for (const t of state.liveTurn.tools) {
    const card = makeToolCard(t);
    liveNodes.toolEls.set(t.id, card);
    transcriptEl.appendChild(card);
  }
  updateWelcome();
  scheduleLiveRender();
}

function unmountLive() {
  if (!liveNodes) return;
  liveNodes.thinkEl?.remove();
  liveNodes.textEl.remove();
  liveNodes.waitEl?.remove();
  for (const card of liveNodes.toolEls.values()) card.remove();
  liveNodes = null;
  updateWelcome();
}

/** "Still working" bubble shown while no output has streamed yet. */
function makeWaitIndicator() {
  const wrap = el("div", "msg assistant wait");
  wrap.appendChild(el("span", "wait-label", "正在思考"));
  for (let i = 0; i < 3; i++) wrap.appendChild(el("span", "wait-dot"));
  return wrap;
}

/** Hide the wait indicator once anything visible has started streaming. */
function dismissWait() {
  if (liveNodes?.waitEl) {
    liveNodes.waitEl.remove();
    liveNodes.waitEl = null;
  }
}

function scheduleLiveRender() {
  if (!liveNodes || liveNodes.renderQueued) return;
  liveNodes.renderQueued = true;
  requestAnimationFrame(() => {
    if (!liveNodes) return;
    liveNodes.renderQueued = false;
    renderMarkdown(liveNodes.mdEl, state.liveTurn?.text ?? "");
    liveNodes.mdEl.classList.add("streaming");
    liveNodes.textEl.classList.toggle("hidden", !(state.liveTurn?.text ?? "").trim());
    scrollBottom();
  });
}

function finalizeLive() {
  if (!liveNodes) return;
  liveNodes.mdEl.classList.remove("streaming");
  // Collapse the thinking card once the turn is done; keep it expandable.
  liveNodes.thinkEl?.classList.remove("open");
  liveNodes = null;
}

/* ---------------- full redraw (initial load / reconnect) ---------------- */

async function refreshState() {
  const s = await api("/api/state");
  state.busy = s.busy;
  state.planMode = s.planMode;
  state.mode = s.mode;
  state.sessionId = s.sessionId;
  transcriptEl.replaceChildren();
  for (const item of s.transcript) {
    if (item.kind === "user") appendItem(makeUserItem(item.text, item.images ?? 0));
    else if (item.kind === "assistant") appendItem(makeAssistantItem(item.text));
    else if (item.kind === "tool") appendItem(makeToolCard(item.tool));
    else if (item.kind === "thinking") appendItem(makeThinkingCard(item.text, false));
  }
  state.liveTurn = s.liveTurn ?? null;
  mountLive();
  if (Array.isArray(s.customCommands)) customCmds = s.customCommands;
  // Re-show any prompts that arrived while we were disconnected.
  if (Array.isArray(s.pendingPermissions) && s.pendingPermissions.length) {
    const known = new Set(state.perms.map((p) => p.id));
    for (const p of s.pendingPermissions) if (!known.has(p.id)) state.perms.push(p);
    showPermission();
  }
  updateHeader(s);
  updateStatus(s);
  updateComposer();
}

function updateHeader(s) {
  $("#model-input").placeholder = `${s.provider}:${s.model}`;
  $("#plan-toggle").checked = s.planMode;
  document.querySelectorAll("#mode-picker button").forEach((b) => b.classList.toggle("active", b.dataset.mode === s.mode));
  const pct = Math.min(100, Math.round((s.tokenEstimate / s.contextWindow) * 100));
  $("#ctx-fill").style.width = pct + "%";
  $("#ctx-text").textContent = `${s.tokenEstimate.toLocaleString()} / ${s.contextWindow.toLocaleString()} tokens`;
}

function updateStatus(s) {
  $("#statusbar").textContent =
    `${s.provider}:${s.model} · session ${s.sessionId} · 上下文 ${Math.min(100, Math.round((s.tokenEstimate / s.contextWindow) * 100))}% · ${s.cost}` +
    (s.todos?.length ? ` · 待办 ${s.todos.filter((t) => t.status === "completed").length}/${s.todos.length}` : "");
}

function updateComposer() {
  $("#send").classList.toggle("hidden", state.busy);
  $("#stop").classList.toggle("hidden", !state.busy);
  $("#input").disabled = false; // still allow typing while busy; send is guarded
}

/* ---------------- SSE ---------------- */

function connectSSE() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.onopen = () => {
    // Reconnect: re-sync from /api/state (the turn keeps running server-side).
    if (connectSSE._opened) refreshState().catch(() => {});
    connectSSE._opened = true;
  };
  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };

  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));

  on("turn_start", (d) => {
    finalizeLive();
    if (d.user) appendItem(makeUserItem(d.user, d.images ?? 0));
    state.busy = true;
    state.liveTurn = { turnId: d.turnId, text: "", thinking: "", tools: [] };
    mountLive();
    updateComposer();
  });

  on("thinking_delta", (d) => {
    if (!state.liveTurn) return;
    state.liveTurn.thinking += d.d;
    if (!liveNodes) return;
    if (!liveNodes.thinkEl) {
      liveNodes.thinkEl = makeThinkingCard(state.liveTurn.thinking, true);
      transcriptEl.insertBefore(liveNodes.thinkEl, liveNodes.textEl);
    } else {
      refreshThinkingCard(liveNodes.thinkEl, state.liveTurn.thinking);
    }
    dismissWait();
    scrollBottom();
  });

  on("text_delta", (d) => {
    if (!state.liveTurn) return;
    state.liveTurn.text += d.d;
    dismissWait();
    scheduleLiveRender();
  });

  on("tool_use_start", (d) => {
    // The model started a tool call; render its card immediately (args still streaming).
    if (!state.liveTurn) return;
    if (state.liveTurn.tools.some((t) => t.id === d.id)) return;
    const tool = { id: d.id, name: d.name, inputPreview: "" };
    state.liveTurn.tools.push(tool);
    if (liveNodes) {
      dismissWait();
      const card = makeToolCard(tool);
      liveNodes.toolEls.set(tool.id, card);
      transcriptEl.appendChild(card);
      scrollBottom();
    }
  });

  on("tool_start", (d) => {
    if (!state.liveTurn) return;
    let t = state.liveTurn.tools.find((x) => x.id === d.id);
    if (t) {
      t.inputPreview = d.inputPreview;
    } else {
      t = { id: d.id, name: d.name, inputPreview: d.inputPreview };
      state.liveTurn.tools.push(t);
    }
    const card = liveNodes?.toolEls.get(d.id);
    if (card) {
      dismissWait();
      refreshToolCard(card);
    } else if (liveNodes) {
      dismissWait();
      const created = makeToolCard(t);
      liveNodes.toolEls.set(t.id, created);
      transcriptEl.appendChild(created);
      scrollBottom();
    }
  });

  on("tool_end", (d) => {
    if (!state.liveTurn) return;
    const t = state.liveTurn.tools.find((x) => x.id === d.id);
    if (t) {
      t.result = d.preview;
      t.ok = d.ok;
    }
    const card = liveNodes?.toolEls.get(d.id);
    if (card) refreshToolCard(card);
  });

  on("turn_end", () => {
    finalizeLive();
    state.liveTurn = null;
    state.busy = false;
    updateComposer();
    refreshState().catch(() => {}); // pick up fresh token/cost numbers
  });

  on("turn_error", (d) => {
    finalizeLive();
    state.liveTurn = null;
    state.busy = false;
    updateComposer();
    if (!d.aborted && d.message) appendItem(makeSystemItem("错误: " + d.message, "error"));
    if (d.aborted) appendItem(makeSystemItem("（已中断）"));
  });

  on("usage", () => {
    api("/api/state").then(updateStatus).catch(() => {});
  });

  on("cost_warning", (d) => appendItem(makeSystemItem("⚠ " + d.message, "error")));
  on("compacting", () => appendItem(makeSystemItem("… 正在压缩上下文 …")));
  on("compacted", (d) => appendItem(makeSystemItem(`上下文: ${d.before.toLocaleString()} → ${d.after.toLocaleString()} tokens`)));
  on("hook", (d) => appendItem(makeSystemItem(`[hook ${d.event}] ${d.message}`)));
  on("plan_approved", () => {
    state.planMode = false;
    $("#plan-toggle").checked = false;
    appendItem(makeSystemItem("计划已批准 — 进入执行模式"));
  });
  on("system", (d) => appendItem(makeSystemItem(d.text, d.kind, d.highlight)));

  on("permission_request", (d) => {
    state.perms.push(d);
    showPermission();
  });
}

/* ---------------- permission modal ---------------- */

function showPermission() {
  if (!state.perms.length || !$("#perm-modal").classList.contains("hidden")) return;
  const p = state.perms[0];
  $("#perm-risk").textContent = p.risk === "high" ? "高危" : p.risk === "medium" ? "写入" : "低风险";
  $("#perm-risk").className = "badge " + p.risk;
  $("#perm-desc").textContent = p.description;
  const preview = $("#perm-preview");
  preview.replaceChildren();
  if (p.preview) {
    for (const line of p.preview.split("\n")) {
      const span = el("span", line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "", line + "\n");
      preview.appendChild(span);
    }
  } else {
    preview.textContent = "";
  }
  $("#perm-modal").classList.remove("hidden");
  preview.scrollTop = 0;
}

async function answerPermission(decision) {
  const p = state.perms.shift();
  if (!p) return;
  $("#perm-modal").classList.add("hidden");
  try {
    await api("/api/permission", { id: p.id, decision });
  } catch {
    /* already resolved elsewhere */
  }
  showPermission();
}

/** The turn ended (abort/flush server-side): drop any open prompt queue. */
function clearStalePermissions() {
  if (!state.perms.length) return;
  state.perms = [];
  $("#perm-modal").classList.add("hidden");
}

document.querySelectorAll(".perm-actions button").forEach((b) => (b.onclick = () => answerPermission(b.dataset.decision)));

/* ---------------- composer ---------------- */

const input = $("#input");

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(200, input.scrollHeight) + "px";
  updatePalette();
});

input.addEventListener("keydown", (e) => {
  if (!$("#perm-modal").classList.contains("hidden")) return; // modal owns keys
  if (paletteOpen()) {
    if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); return; }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      const active = $("#palette .palette-item.active");
      if (active) { e.preventDefault(); applyPalette(active.dataset.cmd); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); hidePalette(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

async function send() {
  const text = input.value.trim();
  if (!text && !state.images.length) return;
  if (state.busy) {
    toast("上一轮还在进行中，可先点“停止”", true);
    return;
  }
  input.value = "";
  input.style.height = "auto";
  hidePalette();
  const images = state.images;
  state.images = [];
  renderAttachments();
  try {
    const r = await api("/api/chat", { text, images: images.length ? images : undefined });
    if (r.error === "busy") toast("智能体正忙", true);
  } catch (err) {
    toast("发送失败: " + err.message, true);
  }
}

$("#send").onclick = send;
$("#stop").onclick = () => api("/api/abort", {});

/* attachments */
$("#attach").onclick = () => $("#file-input").click();
$("#file-input").onchange = (e) => {
  for (const file of e.target.files) {
    if (file.size > 5 * 1024 * 1024) {
      toast(`图片 ${file.name} 超过 5MB 上限`, true);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      state.images.push({ type: "image", source: { type: "base64", media_type: file.type, data: base64 } });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
  e.target.value = "";
};

function renderAttachments() {
  const box = $("#attachments");
  box.replaceChildren();
  state.images.forEach((img, i) => {
    const chip = el("span", "chip");
    const im = document.createElement("img");
    im.src = `data:${img.source.media_type};base64,${img.source.data}`;
    const x = el("button", "", "✕");
    x.onclick = () => {
      state.images.splice(i, 1);
      renderAttachments();
    };
    chip.appendChild(im);
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

/* command palette */
const BUILTIN_CMDS = [
  ["/help", "命令列表"],
  ["/model", "查看/切换模型"],
  ["/compact", "压缩上下文"],
  ["/cost", "费用与预算"],
  ["/plan", "切换 Plan 模式"],
  ["/auto", "切换自动批准"],
  ["/yolo", "切换 YOLO"],
  ["/review", "代码审查"],
  ["/undo", "撤销文件修改"],
  ["/sessions", "会话列表"],
  ["/search ", "跨会话全文检索 <词>"],
  ["/resume ", "恢复会话 <id>"],
  ["/fork ", "从当前会话分叉"],
  ["/rename ", "给当前会话改名"],
  ["/export ", "导出会话 md|json"],
  ["/clear", "新建会话"],
  ["/todos", "查看待办"],
  ["/permissions", "权限规则"],
  ["/hooks", "钩子列表"],
  ["/mcp", "MCP 状态"],
  ["/lsp", "LSP 状态"],
  ["/quit", "退出"],
];

let customCmds = [];

function paletteOpen() {
  return !$("#palette").classList.contains("hidden");
}

function updatePalette() {
  const v = input.value;
  const pal = $("#palette");
  if (!v.startsWith("/") || v.includes("\n")) return hidePalette();
  const q = v.slice(1).toLowerCase();
  const all = [...BUILTIN_CMDS, ...customCmds.map((c) => ["/" + c.name, c.description])];
  const hits = all.filter(([name]) => name.slice(1).toLowerCase().startsWith(q));
  if (!hits.length) return hidePalette();
  pal.replaceChildren();
  hits.slice(0, 12).forEach(([name, desc], i) => {
    const item = el("div", "palette-item" + (i === 0 ? " active" : ""));
    item.dataset.cmd = name;
    item.appendChild(el("span", "p-cmd", name));
    item.appendChild(el("span", "p-desc", desc));
    item.onclick = () => applyPalette(name);
    pal.appendChild(item);
  });
  pal.classList.remove("hidden");
}

function hidePalette() {
  $("#palette").classList.add("hidden");
}

function movePalette(dir) {
  const items = [...$("#palette").children];
  const idx = items.findIndex((i) => i.classList.contains("active"));
  items[idx]?.classList.remove("active");
  const next = items[(idx + dir + items.length) % items.length];
  next.classList.add("active");
  next.scrollIntoView({ block: "nearest" });
}

function applyPalette(cmd) {
  input.value = cmd.endsWith(" ") || cmd === "/resume" ? cmd : cmd + " ";
  if (cmd === "/resume") input.value = "/resume ";
  hidePalette();
  input.focus();
}

/* ---------------- header controls ---------------- */

$("#mode-picker").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  const r = await api("/api/settings", { mode: btn.dataset.mode });
  state.mode = r.mode;
  document.querySelectorAll("#mode-picker button").forEach((b) => b.classList.toggle("active", b === btn));
});

$("#plan-toggle").addEventListener("change", async (e) => {
  const r = await api("/api/settings", { planMode: e.target.checked });
  state.planMode = r.planMode;
});

$("#model-apply").onclick = async () => {
  const spec = $("#model-input").value.trim();
  if (!spec) return;
  const r = await api("/api/command", { line: "/model " + spec });
  toast(r.text ?? "已切换");
  $("#model-input").value = "";
  $("#model-pop").classList.add("hidden");
  refreshState().catch(() => {});
};

$("#model-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("#model-apply").click();
  } else if (e.key === "Escape") {
    $("#model-pop").classList.add("hidden");
  }
});

$("#model-custom").onclick = (e) => {
  e.stopPropagation();
  const pop = $("#model-pop");
  const willShow = pop.classList.contains("hidden");
  pop.classList.toggle("hidden", !willShow);
  if (willShow) {
    const f = $("#model-input");
    f.focus();
    f.select();
  }
};

document.addEventListener("click", (e) => {
  if (!e.target.closest("#model-pop") && !e.target.closest("#model-custom")) {
    $("#model-pop").classList.add("hidden");
  }
});

$("#model-select").onchange = async () => {
  const spec = $("#model-select").value;
  if (!spec) return;
  const r = await api("/api/command", { line: "/model " + spec });
  toast(r.text ?? "已切换");
  refreshState().catch(() => {});
};

async function loadModelOptions() {
  try {
    const models = await api("/api/models");
    if (!Array.isArray(models)) return;
    const sel = $("#model-select");
    sel.replaceChildren(el("option", "", ""));
    sel.lastElementChild.value = "";
    sel.lastElementChild.textContent = "选择模型…";
    for (const m of models.slice(0, 200)) {
      const o = el("option", "", m);
      o.value = m;
      sel.appendChild(o);
    }
  } catch {
    /* endpoint may not support listing */
  }
}

$("#quit").onclick = () => api("/api/shutdown", {}).then(() => window.close());

/* ---------------- sidebar ---------------- */

function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return iso.slice(0, 10);
}

async function loadSessions() {
  const list = await api("/api/sessions");
  const box = $("#session-list");
  box.replaceChildren();
  if (!Array.isArray(list)) return;
  for (const s of list.slice(0, 50)) {
    const item = el("div", "session-item" + (s.id === state.sessionId ? " active" : ""));
    item.appendChild(el("div", "s-title", s.title || s.id));
    const meta = el("div", "s-meta");
    meta.appendChild(el("span", "s-sub", s.model ? s.model.split(":").pop() : ""));
    meta.appendChild(el("span", "s-time", relTime(s.updatedAt)));
    item.appendChild(meta);
    const actions = el("div", "session-actions");
    const renameBtn = el("button", "", "✎");
    renameBtn.title = "改名";
    renameBtn.onclick = async (e) => {
      e.stopPropagation();
      const title = await promptText("会话名称", s.title ?? "");
      if (title === null) return;
      const r = await api("/api/session/rename", { id: s.id, title });
      if (r.error) return toast("改名失败: " + r.error, true);
      loadSessions();
    };
    const delBtn = el("button", "del", "🗑");
    delBtn.title = "删除";
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const label = s.title ? `“${s.title}”` : s.id;
      if (!(await confirmText(`删除会话 ${label}？此操作不可撤销。`))) return;
      const r = await api("/api/session/delete", { id: s.id });
      if (r.error) return toast(r.error === "busy" ? "请先停止当前回合" : "删除失败: " + r.error, true);
      if (r.activeReplaced) {
        toast(`当前会话已删除，已新建 ${r.activeReplaced}`);
        await refreshState();
      }
      loadSessions();
    };
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);
    item.onclick = async () => {
      if (state.busy) return toast("请先停止当前回合", true);
      const r = await api("/api/resume", { id: s.id });
      if (r.error) return toast("恢复失败: " + r.error, true);
      await refreshState();
      loadSessions();
    };
    box.appendChild(item);
  }
}

/* sidebar quick search — same engine as /search, debounced keystrokes */
const sessionSearch = $("#session-search");
let searchTimer = null;
sessionSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSessionSearch, 250);
});

async function runSessionSearch() {
  const q = sessionSearch.value.trim();
  if (!q) return loadSessions();
  const hits = await api("/api/search?q=" + encodeURIComponent(q));
  if (sessionSearch.value.trim() !== q) return; // a newer keystroke won the race
  const box = $("#session-list");
  box.replaceChildren();
  if (!Array.isArray(hits) || !hits.length) {
    box.appendChild(el("div", "s-empty", `无匹配 “${q}”`));
    return;
  }
  for (const h of hits) {
    const s = h.meta;
    const item = el("div", "session-item" + (s.id === state.sessionId ? " active" : ""));
    item.appendChild(el("div", "s-title", (h.titleMatch ? "标题 · " : "") + (s.title || s.id)));
    if (h.snippet) item.appendChild(el("div", "s-snippet", h.snippet));
    const meta = el("div", "s-meta");
    meta.appendChild(el("span", "s-sub", h.matches ? `${h.matches} 条命中` : "标题命中"));
    meta.appendChild(el("span", "s-time", relTime(s.updatedAt)));
    item.appendChild(meta);
    item.onclick = async () => {
      if (state.busy) return toast("请先停止当前回合", true);
      const r = await api("/api/resume", { id: s.id });
      if (r.error) return toast("恢复失败: " + r.error, true);
      sessionSearch.value = "";
      await refreshState();
      loadSessions();
    };
    box.appendChild(item);
  }
}

/* small text-input dialog (Electron has no window.prompt) */
function promptText(title, value) {
  return new Promise((resolve) => {
    $("#input-title").textContent = title;
    const field = $("#input-field");
    field.value = value ?? "";
    $("#input-modal").classList.remove("hidden");
    field.focus();
    field.select();
    const finish = (result) => {
      $("#input-modal").classList.add("hidden");
      field.onkeydown = null;
      $("#input-ok").onclick = null;
      $("#input-cancel").onclick = null;
      resolve(result);
    };
    field.onkeydown = (e) => {
      if (e.key === "Enter") finish(field.value);
      else if (e.key === "Escape") finish(null);
    };
    $("#input-ok").onclick = () => finish(field.value);
    $("#input-cancel").onclick = () => finish(null);
  });
}

/* confirm dialog reusing the same modal shell (no input field) */
function confirmText(message) {
  return new Promise((resolve) => {
    $("#input-title").textContent = message;
    $("#input-field").value = "";
    $("#input-field").style.display = "none";
    $("#input-modal").classList.remove("hidden");
    $("#input-ok").textContent = "删除";
    $("#input-ok").classList.add("danger");
    const finish = (result) => {
      $("#input-modal").classList.add("hidden");
      $("#input-field").style.display = "";
      $("#input-ok").textContent = "确定";
      $("#input-ok").classList.remove("danger");
      $("#input-ok").onclick = null;
      $("#input-cancel").onclick = null;
      resolve(result);
    };
    $("#input-ok").onclick = () => finish(true);
    $("#input-cancel").onclick = () => finish(false);
  });
}

$("#new-session").onclick = async () => {
  if (state.busy) return toast("请先停止当前回合", true);
  await api("/api/new", {});
  await refreshState();
  loadSessions();
};

/* ---------------- global keys ---------------- */

document.addEventListener("keydown", (e) => {
  if (!$("#perm-modal").classList.contains("hidden")) {
    const k = e.key.toLowerCase();
    const map = { y: "yes", a: "always", n: "no", d: "always_deny" };
    if (map[k]) {
      e.preventDefault();
      answerPermission(map[k]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      answerPermission("yes");
    }
  }
});

/* ---------------- boot ---------------- */

(async function boot() {
  if (!token) {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:sans-serif">缺少访问令牌：请通过 <code>agent --gui</code> 打印的完整 URL（含 #token）打开本页面。</div>';
    return;
  }
  if (window.marked) {
    marked.setOptions({ gfm: true });
  } else {
    const s = document.createElement("script");
    s.src = "/vendor/marked.min.js";
    document.head.appendChild(s);
  }
  customCmds = []; // loaded lazily from /help output; palette works with builtins meanwhile
  connectSSE();
  await refreshState();
  loadSessions();
  loadModelOptions();
})();
