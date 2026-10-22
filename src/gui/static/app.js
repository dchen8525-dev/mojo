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
  const html = marked.parse(text ?? "", { breaks: true });
  el.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }) : scrub(html);
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
  el.querySelectorAll("a").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
}

/* ---------------- state ---------------- */

const state = {
  busy: false,
  planMode: false,
  mode: "default",
  sessionId: "",
  cwd: "",
  model: "",
  sessions: [], // last /api/sessions result — drives the 最近项目 menu
  items: [], // {kind, ...} finalized transcript entries
  liveTurn: null, // {turnId, text, thinking, tools[]}
  perms: [], // queued permission requests
  todos: [], // latest todo plan (drives the 待办 popover)
  images: [], // staged image attachments for the next message
  steerMode: false, // while busy: inject into the running turn instead of queuing
};

let todoSyncSeq = 0;
let todoSyncEpoch = 0;

const transcriptEl = $("#transcript");

/** 权限下拉的四个档位：前三档是 permissions.mode，PLAN 是 agent.planMode。 */
const MODE_LABELS = { default: "每次都问", auto: "自动批准", yolo: "允许完全访问" };

function baseName(p) {
  const parts = String(p ?? "")
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function samePath(a, b) {
  const norm = (p) =>
    String(p ?? "")
      .replace(/[\\/]+$/, "")
      .replace(/\//g, "\\")
      .toLowerCase();
  return !!a && norm(a) === norm(b);
}

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

/* ---------------- tool cards ---------------- */

const RESULT_PREVIEW_LINES = 12;
const LONG_ARG = 80;

/** One-line, human description of a call — used in the card head and the sub-chain. */
function toolSummary(tool) {
  const input = tool.input ?? {};
  const str = (v) => (typeof v === "string" ? v : "");
  const short = (t, n = 60) => (t && t.length > n ? t.slice(0, n) + "…" : t || "");
  const result = tool.result ?? "";
  const pick = (re) => {
    const m = re.exec(result);
    return m ? m[1] : "";
  };

  switch (tool.name) {
    case "read_file": {
      const from = Number(input.offset) || 1;
      const limit = Number(input.limit);
      const range = input.offset || input.limit ? ` · ${from}–${limit ? from + limit - 1 : "…"}` : "";
      return str(input.path) + range;
    }
    case "write_file": {
      const content = str(input.content);
      return `${str(input.path)} · 写入 ${content ? content.split("\n").length : 0} 行`;
    }
    case "edit_file": {
      const stat = /\+(\d+)\s*[−-]\s*(\d+)/.exec(result);
      const n = /(\d+) replacement/.exec(result);
      return str(input.path) + (stat ? ` · ${stat[0]}` : n ? ` · ${n[1]} 处替换` : "");
    }
    case "multi_edit":
      return `${str(input.pattern)} · 搜 ${JSON.stringify(str(input.search))}`;
    case "grep": {
      const hits = pick(/(\d+)\s*(?:matches|处命中|match)/i);
      return `${JSON.stringify(str(input.pattern))} · ${str(input.path) || "."}${hits ? ` · ${hits} 处` : ""}`;
    }
    case "glob_files": {
      const n = pick(/(\d+)\s*(?:files|个文件|file)/i);
      return `${str(input.pattern)}${n ? ` · ${n} 个` : ""}`;
    }
    case "bash": {
      const code = pick(/\[exit code (\d+)\]/);
      return `${short(str(input.command), 64)}${code ? ` · exit ${code}` : ""}`;
    }
    case "bash_output":
    case "bash_kill":
      return str(input.id);
    case "task": {
      const mode = input.mode === "worker" ? "编码" : "研究";
      const calls = (tool.subCalls ?? []).length || Number(pick(/finished after (\d+) tool calls/)) || 0;
      return `${mode} · ${str(input.description)}${calls ? ` · ${calls} calls` : ""}`;
    }
    case "web_search":
      return short(str(input.query));
    case "web_fetch":
      return short(str(input.url));
    case "todo_write":
      return `${Array.isArray(input.todos) ? input.todos.length : 0} 项待办`;
    case "get_diagnostics":
      return str(input.path);
    case "exit_plan":
      return "提交计划";
    default:
      break;
  }
  if (tool.name.startsWith("git_")) {
    return short(str(input.branch) || str(input.message) || str(input.base) || str(input.path) || tool.name);
  }
  for (const v of Object.values(input)) if (typeof v === "string" && v.trim()) return short(v);
  return "";
}

function renderToolHead(card, tool) {
  const head = el("div", "tool-head");
  head.appendChild(el("span", "tool-status " + (tool.ok === undefined ? "running" : tool.ok ? "ok" : "err")));
  head.appendChild(el("span", "tool-name", tool.name));
  head.appendChild(el("span", "tool-summary", toolSummary(tool) || "正在生成参数…"));
  head.appendChild(el("span", "tool-state", tool.ok === undefined ? "运行中" : tool.ok ? "✓" : "✗"));
  head.onclick = () => card.classList.toggle("open");
  return head;
}

function renderArgs(input) {
  const box = el("div", "tool-args");
  const entries = Object.entries(input ?? {});
  if (!entries.length) {
    box.appendChild(el("div", "tool-empty", "（无参数）"));
    return box;
  }
  for (const [key, value] of entries) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const row = el("div", "tool-arg" + (text.length > LONG_ARG ? " wide" : ""));
    row.appendChild(el("span", "arg-key", key));
    if (text.length > LONG_ARG) {
      const pre = el("pre", "arg-value");
      pre.textContent = text;
      row.appendChild(pre);
    } else {
      row.appendChild(el("span", "arg-value", text));
    }
    box.appendChild(row);
  }
  return box;
}

/** Fill a <pre> with result lines, colouring +/- lines inside a diff block. */
function fillResult(pre, lines, colored) {
  for (const line of lines) {
    let cls = "";
    if (colored) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) cls = "diff-hunk";
      else if (line.startsWith("+")) cls = "diff-add";
      else if (line.startsWith("-")) cls = "diff-del";
    }
    pre.appendChild(el("span", cls, line + "\n"));
  }
}

function renderResult(tool) {
  const section = el("div", "tool-section");
  const label = el("div", "tool-label");
  label.appendChild(el("span", "", "结果"));
  section.appendChild(label);

  if (tool.ok === undefined) {
    section.appendChild(el("div", "tool-empty", "运行中…"));
    return section;
  }
  const all = tool.result ? tool.result.split("\n") : [];
  if (!all.length) {
    section.appendChild(el("div", "tool-empty", "（空）"));
    return section;
  }

  label.appendChild(el("span", "tool-count", `${all.length} 行`));
  const colored = /<diff>|^@@ .*@@$/m.test(tool.result ?? "");
  const clipped = all.length > RESULT_PREVIEW_LINES;
  const pre = el("pre", "tool-result");
  fillResult(pre, clipped ? all.slice(0, RESULT_PREVIEW_LINES) : all, colored);
  section.appendChild(pre);
  if (clipped) {
    const more = el("button", "tool-more", `展开全部 ${all.length} 行`);
    more.onclick = () => {
      pre.replaceChildren();
      fillResult(pre, all, colored);
      more.remove();
    };
    section.appendChild(more);
  }
  return section;
}

/** Subagent chain: what the child did, summarised per call. */
function subCallSummary(call) {
  try {
    return toolSummary({ name: call.name, input: JSON.parse(call.inputPreview), result: call.result ?? "" });
  } catch {
    return call.inputPreview || "";
  }
}

/**
 * Subagent chain as a call-stack tree:
 *   task
 *   └ 第 1 轮 · 3 次
 *      ├ 01 read_file  src/llm.ts · 1–160
 *      └ 02 grep       "resolveSettings" · 12 处
 *   └ 第 2 轮 · 2 次
 * Each row still expands to its arguments and result.
 */
function renderSubChain(calls, openSet) {
  const section = el("div", "tool-section sub-chain");
  const label = el("div", "tool-label");
  label.appendChild(el("span", "", "调用链"));
  label.appendChild(el("span", "tool-count", `${calls.length} 次`));
  section.appendChild(label);

  // Group by the subagent's own model round, keeping first-seen order.
  const groups = [];
  const indexOf = new Map();
  calls.forEach((call, i) => {
    indexOf.set(call, i);
    const key = call.round ?? null;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, calls: [] };
      groups.push(group);
    }
    group.calls.push(call);
  });

  const tree = el("div", "sub-tree");
  groups.forEach((group, gi) => {
    const roundEl = el("div", "sub-round");
    const rhead = el("div", "sub-round-head");
    rhead.appendChild(el("span", "sub-rail", gi === groups.length - 1 ? "└" : "├"));
    rhead.appendChild(el("span", "sub-round-label", group.key ? `第 ${group.key} 轮` : "调用"));
    rhead.appendChild(el("span", "sub-round-count", `${group.calls.length} 次`));
    roundEl.appendChild(rhead);

    group.calls.forEach((call, ci) => {
      const i = indexOf.get(call) ?? 0;
      const item = el("div", "sub-item " + (call.ok === false ? "err" : "ok"));
      if (openSet?.has(i)) item.classList.add("open");

      const head = el("div", "sub-head");
      head.appendChild(el("span", "sub-rail", ci === group.calls.length - 1 ? "└" : "├"));
      head.appendChild(el("span", "sub-index", String(i + 1).padStart(2, "0")));
      head.appendChild(el("span", "sub-name", call.name));
      head.appendChild(el("span", "sub-sum", subCallSummary(call)));
      head.appendChild(el("span", "sub-caret", "▸"));

      const body = el("div", "sub-body");
      let parsed = null;
      try {
        parsed = JSON.parse(call.inputPreview);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object") body.appendChild(renderArgs(parsed));
      else if (call.inputPreview) {
        const raw = el("pre", "arg-value");
        raw.textContent = call.inputPreview;
        body.appendChild(raw);
      }
      if (call.result) {
        const pre = el("pre", "sub-result");
        pre.textContent = call.result;
        body.appendChild(pre);
      }

      head.onclick = () => {
        const open = item.classList.toggle("open");
        if (!openSet) return;
        if (open) openSet.add(i);
        else openSet.delete(i);
      };

      item.appendChild(head);
      item.appendChild(body);
      roundEl.appendChild(item);
    });

    tree.appendChild(roundEl);
  });

  section.appendChild(tree);
  return section;
}

function renderToolInto(card, tool) {
  card.replaceChildren();
  card.appendChild(renderToolHead(card, tool));
  const body = el("div", "tool-body");

  const argsSection = el("div", "tool-section");
  argsSection.appendChild(el("div", "tool-label", "参数"));
  argsSection.appendChild(renderArgs(tool.input));
  body.appendChild(argsSection);

  body.appendChild(renderResult(tool));
  if (tool.subCalls?.length) {
    // Remember which rows the user expanded so a live refresh does not close them.
    card._openSubs ??= new Set();
    body.appendChild(renderSubChain(tool.subCalls, card._openSubs));
  } else if (tool.name === "task" && /finished after \d+ tool calls/.test(tool.result ?? "")) {
    // Older sessions were recorded before chains were persisted.
    body.appendChild(el("div", "tool-empty", "（这次没有记录到子代理调用链）"));
  }

  card.appendChild(body);
}

function makeToolCard(tool) {
  const card = el("div", "tool-card");
  card._tool = tool;
  renderToolInto(card, tool);
  return card;
}

function refreshToolCard(card) {
  if (!card || !card._tool) return;
  const open = card.classList.contains("open");
  renderToolInto(card, card._tool);
  card.classList.toggle("open", open);
}

/* ---- round groups: one model response + the tools it asked for ---- */

function makeToolGroup(round) {
  const wrap = el("div", "tool-group");
  const head = el("div", "tool-group-head");
  head.appendChild(el("span", "tg-caret", "▾"));
  head.appendChild(el("span", "tg-label", `第 ${round} 轮`));
  const meta = el("span", "tg-meta", "");
  head.appendChild(meta);
  head.onclick = () => wrap.classList.toggle("collapsed");
  const body = el("div", "tool-group-body");
  wrap.appendChild(head);
  wrap.appendChild(body);
  wrap._round = round;
  wrap._body = body;
  wrap._meta = meta;
  wrap._tools = 0;
  updateGroupMeta(wrap);
  return wrap;
}

function updateGroupMeta(wrap, ms) {
  const parts = [`${wrap._tools} 个调用`];
  if (ms !== undefined) parts.push(`${(ms / 1000).toFixed(1)}s`);
  wrap._meta.textContent = parts.join(" · ");
}

function groupAddTool(wrap, card) {
  wrap._body.appendChild(card);
  wrap._tools += 1;
  updateGroupMeta(wrap);
}

/* ---- thinking card ---- */

/**
 * Thinking is the model's inner voice, not tool output: same head shape as a
 * tool card, but the body is rendered as Markdown behind a quiet left rail so
 * it reads as prose instead of a log dump.
 */
function renderThinkingInto(card) {
  const text = card._text ?? "";
  const live = !!card._live;

  card.replaceChildren();
  const head = el("div", "tool-head");
  head.appendChild(el("span", "tool-status " + (live ? "running" : "done")));
  head.appendChild(el("span", "tool-name", "思考"));
  head.appendChild(el("span", "tool-preview", firstLine(text) || "…"));
  head.appendChild(el("span", "tool-state", live ? "思考中…" : `${text.split("\n").length} 行`));
  head.onclick = () => card.classList.toggle("open");

  const body = el("div", "tool-body");
  const md = el("div", "thinking-body md");
  renderMarkdown(md, text);
  body.appendChild(md);

  card.appendChild(head);
  card.appendChild(body);
}

function makeThinkingCard(text, open, live) {
  const card = el("div", "tool-card thinking-card" + (open ? " open" : ""));
  card._text = text;
  card._live = live;
  renderThinkingInto(card);
  return card;
}

function firstLine(text) {
  const line = (text ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

/** Update text/state; markdown rendering is coalesced to one frame. */
function refreshThinkingCard(card, text, live) {
  if (!card) return;
  card._text = text;
  if (live !== undefined) card._live = live;
  if (card._queued) return;
  card._queued = true;
  requestAnimationFrame(() => {
    card._queued = false;
    const open = card.classList.contains("open");
    renderThinkingInto(card);
    card.classList.toggle("open", open);
    const body = card.querySelector(".tool-body");
    if (open && body) body.scrollTop = body.scrollHeight;
  });
}

/* Scroll ownership: streaming appends only pin the viewport while the user is
   already at the bottom. Any real scroll away (wheel, touch, scrollbar, keys)
   detaches — growth never steals the viewport — until the user returns to the
   bottom or clicks the jump button. Our own scrollBottom() sets `lock` so the
   scroll handler can tell its event from a user scroll. */
const BOTTOM_SLACK = 32;
const follow = { on: true, lock: false };
const jumpBottom = $("#jump-bottom");

function distanceFromBottom() {
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
}

function updateJumpButton() {
  jumpBottom.classList.toggle("hidden", follow.on);
}

function scrollBottom() {
  if (follow.on) {
    follow.lock = true;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  updateJumpButton();
}

transcriptEl.addEventListener("scroll", () => {
  const nearBottom = distanceFromBottom() <= BOTTOM_SLACK;
  if (follow.lock && nearBottom) {
    follow.lock = false;
    return;
  }
  follow.lock = false;
  follow.on = nearBottom;
  updateJumpButton();
});

jumpBottom.onclick = () => {
  follow.on = true;
  scrollBottom();
};

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

/* Live streaming: one segment per model round (thinking + text bubble), with
   that round's tool cards appended right after it — so the stream stays in
   conversation order instead of piling every tool under a single text bubble. */
let liveNodes = null; // {rounds: Map<round, seg>, toolEls: Map<id, card>, groups: Map<round, wrap>, waitEl}

function mountLive() {
  unmountLive();
  if (!state.liveTurn) return;
  liveNodes = { rounds: new Map(), toolEls: new Map(), groups: new Map() };

  const lt = state.liveTurn;
  // A reconnecting tab gets per-round text from the snapshot; older payloads
  // fall back to the accumulated text in a single segment.
  const rounds = lt.rounds?.length ? lt.rounds : [{ round: lt.round ?? 1, text: lt.text ?? "", thinking: lt.thinking ?? "" }];

  for (const r of rounds) {
    const seg = makeLiveSegment(r.round);
    seg.text = r.text ?? "";
    seg.thinking = r.thinking ?? "";
    if (seg.thinking) {
      seg.thinkEl = makeThinkingCard(seg.thinking, true, true);
      transcriptEl.insertBefore(seg.thinkEl, seg.textEl);
    }
    for (const t of lt.tools.filter((x) => (x.round ?? 1) === r.round)) {
      const card = makeToolCard(t);
      liveNodes.toolEls.set(t.id, card);
      liveToolGroup(r.round).appendChild(card);
    }
    if (seg.text.trim()) {
      seg.textEl.classList.remove("hidden");
      renderMarkdown(seg.mdEl, seg.text);
    }
  }

  if (!lt.text && !lt.thinking && !lt.tools.length) {
    liveNodes.waitEl = makeWaitIndicator();
    transcriptEl.appendChild(liveNodes.waitEl);
  }
  updateWelcome();
}

/** A round's own text bubble, appended at the current end of the transcript. */
function makeLiveSegment(round) {
  const seg = { round, text: "", thinking: "", renderQueued: false };
  seg.textEl = el("div", "msg assistant hidden");
  seg.mdEl = el("div", "md streaming");
  seg.textEl.appendChild(seg.mdEl);
  transcriptEl.appendChild(seg.textEl);
  liveNodes.rounds.set(round, seg);
  return seg;
}

function liveSegment(round) {
  return liveNodes?.rounds.get(round) ?? (liveNodes ? makeLiveSegment(round) : null);
}

function renderSegment(seg) {
  if (!seg || seg.renderQueued) return;
  seg.renderQueued = true;
  requestAnimationFrame(() => {
    seg.renderQueued = false;
    renderMarkdown(seg.mdEl, seg.text);
    seg.mdEl.classList.add("streaming");
    seg.textEl.classList.toggle("hidden", !seg.text.trim());
    scrollBottom();
  });
}

/** Body of the (possibly new) round group for a live tool card. */
function liveToolGroup(round) {
  let wrap = liveNodes.groups.get(round);
  if (!wrap) {
    wrap = makeToolGroup(round);
    liveNodes.groups.set(round, wrap);
    transcriptEl.appendChild(wrap);
  }
  wrap._tools += 1;
  updateGroupMeta(wrap);
  return wrap._body;
}

function unmountLive() {
  if (!liveNodes) return;
  for (const seg of liveNodes.rounds.values()) {
    seg.thinkEl?.remove();
    seg.textEl.remove();
  }
  liveNodes.waitEl?.remove();
  for (const group of liveNodes.groups.values()) group.remove();
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

function finalizeLive() {
  if (!liveNodes) return;
  // Close the timing of the round that was running when the turn ended.
  const lt = state.liveTurn;
  if (lt?.round && lt.roundStartAt) {
    const group = liveNodes.groups.get(lt.round);
    if (group) updateGroupMeta(group, performance.now() - lt.roundStartAt);
  }
  for (const seg of liveNodes.rounds.values()) {
    seg.mdEl.classList.remove("streaming");
    // Collapse thinking once the turn is done; keep it expandable.
    seg.thinkEl?.classList.remove("open");
  }
  liveNodes = null;
}

/* ---------------- full redraw (initial load / reconnect) ---------------- */

async function refreshState() {
  const s = await api("/api/state");
  state.busy = s.busy;
  state.planMode = s.planMode;
  state.mode = s.mode;
  state.sessionId = s.sessionId;
  // A full redraw must not yank a detached viewport back to the stream tail.
  const keepScroll = follow.on ? null : transcriptEl.scrollTop;
  transcriptEl.replaceChildren();
  // Consecutive tool cards from the same model round are collected into one group.
  let group = null;
  let groupRound = 0;
  for (const item of s.transcript) {
    if (item.kind === "user") {
      group = null;
      appendItem(makeUserItem(item.text, item.images ?? 0));
    } else if (item.kind === "assistant") {
      group = null;
      appendItem(makeAssistantItem(item.text));
    } else if (item.kind === "thinking") {
      group = null;
      appendItem(makeThinkingCard(item.text, false));
    } else if (item.kind === "tool") {
      const round = item.tool.round ?? 1;
      if (!group || groupRound !== round) {
        group = makeToolGroup(round);
        groupRound = round;
        appendItem(group);
      }
      groupAddTool(group, makeToolCard(item.tool));
    }
  }
  state.liveTurn = s.liveTurn ?? null;
  mountLive();
  updateWelcome();
  if (keepScroll !== null) transcriptEl.scrollTop = keepScroll;
  else scrollBottom();
  // The redraw dropped the find highlights; re-apply them if the bar is open.
  if (!findBar.classList.contains("hidden") && findInput.value) runFind();
  if (Array.isArray(s.customCommands)) customCmds = s.customCommands;
  todoSyncEpoch++; // invalidate any todo-only refresh that started earlier
  state.todos = Array.isArray(s.todos) ? s.todos : [];
  renderTodos();
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
  state.cwd = s.cwd ?? "";
  state.model = s.model ?? "";
  const name = baseName(state.cwd);
  $("#crumb-cwd").textContent = name || "选择工作空间";
  $("#open-project").title = state.cwd ? `切换工作目录 · ${state.cwd}` : "切换工作目录";
  $("#model-logo").textContent = (s.provider ?? "").charAt(0) || "·";
  syncPermissionUi(s);
}

/** 权限下拉显示当前生效的那一档（PLAN 优先于 mode），并高亮对应菜单项。 */
function syncPermissionUi(s) {
  state.planMode = !!s.planMode;
  state.mode = s.mode ?? state.mode;
  $("#perm-label").textContent = state.planMode ? "计划模式" : (MODE_LABELS[state.mode] ?? state.mode);
  document.querySelectorAll("#perm-pop .pop-item").forEach((b) => {
    const on = state.planMode ? b.dataset.plan === "1" : !b.dataset.plan && b.dataset.mode === state.mode;
    b.classList.toggle("on", on);
  });
}

/** 工具行右端的 mono 元信息；空项连同它前面的分隔线一起隐藏。 */
function updateStatus(s) {
  const pct = s.contextWindow > 0 ? Math.min(100, Math.round((s.tokenEstimate / s.contextWindow) * 100)) : 0;
  setMeta("#meta-session", null, s.sessionId ?? "");
  setMeta("#meta-ctx", "#sep-ctx", `上下文 ${pct}%`);
  setMeta("#meta-cost", "#sep-cost", compactCost(s.cost));
}

/** 终端 /cost 是多行报告；工具行只需要一个短数字。 */
function compactCost(raw) {
  const line = String(raw ?? "").split("\n")[0].trim();
  if (!line || line.startsWith("no API calls")) return "$0";
  return line.replace(/^total:\s*/, "");
}

function setMeta(sel, sepSel, text) {
  const node = $(sel);
  node.textContent = text;
  node.classList.toggle("hidden", !text);
  if (sepSel) $(sepSel).classList.toggle("hidden", !text);
}

function updateComposer() {
  // Send stays visible while busy: mid-turn submissions steer the running
  // turn instead of bouncing off.
  $("#send").classList.remove("hidden");
  $("#stop").classList.toggle("hidden", !state.busy);
  $("#send").disabled = !input.value.trim() && !state.images.length;
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

  on("command_start", () => {
    state.busy = true;
    updateComposer();
  });

  on("command_end", async (d) => {
    state.busy = false;
    updateComposer();
    if (d.sessionChanged) await refreshState();
    if (d.sidebarChanged) loadSessions();
    if (d.text) appendItem(makeSystemItem(d.text, d.kind, d.highlight));
  });

  on("steer", (d) => {
    // Queued mid-turn input; the agent applies it at the next round boundary.
    if (d.text) appendItem(makeUserItem(d.text, 0));
  });

  on("turn_start", (d) => {
    finalizeLive();
    if (d.user) appendItem(makeUserItem(d.user, d.images ?? 0));
    state.busy = true;
    state.liveTurn = {
      turnId: d.turnId,
      text: "",
      thinking: "",
      tools: [],
      round: 1,
      roundStartAt: performance.now(),
      rounds: [],
    };
    mountLive();
    updateComposer();
  });

  on("round_start", (d) => {
    if (!state.liveTurn) return;
    const now = performance.now();
    const prev = state.liveTurn.round;
    if (prev && state.liveTurn.roundStartAt && liveNodes) {
      const group = liveNodes.groups.get(prev);
      if (group) updateGroupMeta(group, now - state.liveTurn.roundStartAt);
    }
    state.liveTurn.round = d.round;
    state.liveTurn.roundStartAt = now;
    (state.liveTurn.rounds ??= []).push({ round: d.round, text: "", thinking: "" });
    // Create this round's bubble now so it lands after the previous round's tools.
    liveSegment(d.round);
  });

  on("thinking_delta", (d) => {
    if (!state.liveTurn) return;
    state.liveTurn.thinking += d.d;
    const seg = liveSegment(state.liveTurn.round ?? 1);
    if (!seg) return;
    seg.thinking += d.d;
    if (!seg.thinkEl) {
      seg.thinkEl = makeThinkingCard(seg.thinking, true, true);
      transcriptEl.insertBefore(seg.thinkEl, seg.textEl);
    } else {
      refreshThinkingCard(seg.thinkEl, seg.thinking, true);
    }
    dismissWait();
    scrollBottom();
  });

  on("text_delta", (d) => {
    if (!state.liveTurn) return;
    state.liveTurn.text += d.d;
    const seg = liveSegment(state.liveTurn.round ?? 1);
    if (seg) {
      seg.text += d.d;
      renderSegment(seg);
    }
    dismissWait();
  });

  on("tool_use_start", (d) => {
    // The model started a tool call; render its card immediately (args still streaming).
    if (!state.liveTurn) return;
    if (state.liveTurn.tools.some((t) => t.id === d.id)) return;
    const tool = { id: d.id, name: d.name, round: d.round ?? state.liveTurn.round ?? 1, inputPreview: "" };
    state.liveTurn.tools.push(tool);
    if (liveNodes) {
      dismissWait();
      const card = makeToolCard(tool);
      liveNodes.toolEls.set(tool.id, card);
      liveToolGroup(tool.round).appendChild(card);
      scrollBottom();
    }
  });

  on("tool_start", (d) => {
    if (!state.liveTurn) return;
    let t = state.liveTurn.tools.find((x) => x.id === d.id);
    if (t) {
      t.inputPreview = d.inputPreview;
      if (d.input) t.input = d.input;
      if (d.round) t.round = d.round;
    } else {
      t = {
        id: d.id,
        name: d.name,
        round: d.round ?? state.liveTurn.round ?? 1,
        inputPreview: d.inputPreview,
        input: d.input,
      };
      state.liveTurn.tools.push(t);
    }
    let card = liveNodes?.toolEls.get(d.id);
    if (card) {
      dismissWait();
      refreshToolCard(card);
    } else if (liveNodes) {
      dismissWait();
      card = makeToolCard(t);
      liveNodes.toolEls.set(t.id, card);
      liveToolGroup(t.round).appendChild(card);
      scrollBottom();
    }
  });

  on("tool_end", (d) => {
    if (d.name === "todo_write") void refreshTodos();
    if (!state.liveTurn) return;
    const t = state.liveTurn.tools.find((x) => x.id === d.id);
    if (t) {
      t.result = d.result ?? d.preview;
      t.ok = d.ok;
    }
    const card = liveNodes?.toolEls.get(d.id);
    if (card) refreshToolCard(card);
  });

  on("sub_tool", (d) => {
    // A subagent ran one of its own tools — append it to the parent task card.
    if (!state.liveTurn) return;
    const t = state.liveTurn.tools.find((x) => x.id === d.id);
    if (!t) return;
    (t.subCalls ??= []).push({
      name: d.name,
      inputPreview: d.inputPreview,
      ok: d.ok,
      result: d.preview,
      round: d.round,
    });
    refreshToolCard(liveNodes?.toolEls.get(d.id));
    scrollBottom();
  });

  on("turn_end", () => {
    finalizeLive();
    notifyUser("回合完成", (state.liveTurn?.text || "").trim().slice(0, 140) || "模型已回复完毕。");
    state.liveTurn = null;
    state.busy = false;
    updateComposer();
    // refreshState picks up the token/cost numbers and, when this was the first
    // message of a fresh window, the session id the agent just created.
    refreshState()
      .then(loadSessions)
      .catch(() => {});
  });

  on("turn_error", (d) => {
    finalizeLive();
    if (!d.aborted) notifyUser("回合出错", (d.message || "未知错误").slice(0, 140));
    state.liveTurn = null;
    state.busy = false;
    updateComposer();
    // refreshState redraws the transcript from the server snapshot, so the
    // error line must land after it or the redraw erases it.
    refreshState()
      .then(loadSessions)
      .catch(() => {})
      .finally(() => {
        if (!d.aborted && d.message) appendItem(makeSystemItem("错误: " + d.message, "error"));
        if (d.aborted) appendItem(makeSystemItem("（已中断）"));
      });
  });

  on("usage", () => {
    api("/api/state").then(updateStatus).catch(() => {});
  });

  on("model_meta", () => {
    // The endpoint's context window changed (or arrived): refresh the readout.
    api("/api/state").then(updateStatus).catch(() => {});
  });

  on("cost_warning", (d) => appendItem(makeSystemItem("⚠ " + d.message, "error")));
  on("compacting", () => appendItem(makeSystemItem("… 正在压缩上下文 …")));
  on("compacted", (d) => appendItem(makeSystemItem(`上下文: ${d.before.toLocaleString()} → ${d.after.toLocaleString()} tokens`)));
  on("retry", (d) => {
    const why =
      d.reason === "rate-limit"
        ? "限流"
        : d.reason === "timeout"
          ? "请求超时"
          : d.reason === "server"
            ? `服务端错误 ${d.status ?? ""}`.trim()
            : "连接失败";
    appendItem(makeSystemItem(`… ${Math.round(d.delayMs / 100) / 10} 秒后重试（${d.attempt}/${d.maxAttempts} · ${why}）`));
  });
  on("hook", (d) => appendItem(makeSystemItem(`[hook ${d.event}] ${d.message}`)));
  on("plan_approved", () => {
    syncPermissionUi({ planMode: false, mode: state.mode });
    appendItem(makeSystemItem("计划已批准 — 进入执行模式"));
  });
  on("system", (d) => appendItem(makeSystemItem(d.text, d.kind, d.highlight)));

  on("project_changed", async () => {
    await refreshState();
    loadSessions();
    loadBackground(true); // switching projects kills the old project's tasks
    // MCP servers, permission rules, and the session budget are project-scoped.
    if (!$("#manage-modal").classList.contains("hidden")) void loadManagement();
    if (!$("#usage-modal").classList.contains("hidden")) void loadUsage();
  });

  on("cron_changed", async () => {
    if ($("#manage-modal").classList.contains("hidden")) return;
    if ($("#cron-pane").classList.contains("hidden")) return;
    try {
      cronData = await api("/api/cron");
      renderCron();
    } catch {
      /* the modal may have closed mid-flight */
    }
  });

  on("permission_request", (d) => {
    state.perms.push(d);
    showPermission();
    notifyUser("等待权限批准", String(d.description || "").slice(0, 140));
  });
}

/* ---------------- permission modal ---------------- */

/* Edit previews arrive as unified diffs (renderDiff in editMatch.ts, git diff
   for git tools); render them as numbered rows like a code review. Non-diff
   previews (plans, command lines) keep the plain colored pre. */
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_HEADER_RE = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|rename |similarity )/;

function looksLikeDiff(text) {
  return HUNK_RE.test(text) || /^diff --git /m.test(text);
}

function renderDiffPreview(container, text) {
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk || DIFF_HEADER_RE.test(line) || line.startsWith("\\") || line.startsWith("[...")) {
      if (hunk) {
        oldNo = parseInt(hunk[1], 10);
        newNo = parseInt(hunk[2], 10);
      }
      container.appendChild(el("div", "diff-meta", line));
      continue;
    }
    const row = el("div", "diff-row");
    const oldCell = el("span", "diff-num");
    const newCell = el("span", "diff-num");
    if (line.startsWith("+")) {
      newCell.textContent = newNo++;
      row.classList.add("add");
    } else if (line.startsWith("-")) {
      oldCell.textContent = oldNo++;
      row.classList.add("del");
    } else {
      oldCell.textContent = oldNo++;
      newCell.textContent = newNo++;
      line = line.slice(1); // context lines carry a leading space
    }
    row.append(oldCell, newCell, el("span", "diff-code", line));
    container.appendChild(row);
  }
}

function showPermission() {
  if (!state.perms.length || !$("#perm-modal").classList.contains("hidden")) return;
  const p = state.perms[0];
  $("#perm-risk").textContent = p.risk === "high" ? "高危" : p.risk === "medium" ? "写入" : "低风险";
  $("#perm-risk").className = "badge " + p.risk;
  $("#perm-desc").textContent = p.description;
  const preview = $("#perm-preview");
  preview.replaceChildren();
  if (p.preview && looksLikeDiff(p.preview)) {
    renderDiffPreview(preview, p.preview);
  } else if (p.preview) {
    for (const line of p.preview.split("\n")) {
      const span = el("span", line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "", line + "\n");
      preview.appendChild(span);
    }
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

/* ---------------- narrow-screen drawer ---------------- */

const sidebarEl = $("#sidebar");
const sidebarToggle = $("#sidebar-toggle");
const sidebarOverlay = $("#sidebar-overlay");
const narrowQuery = window.matchMedia("(max-width: 860px)");

function setSidebarOpen(open) {
  const wasOpen = sidebarEl.classList.contains("open");
  const next = !!open && narrowQuery.matches;
  sidebarEl.classList.toggle("open", next);
  sidebarOverlay.classList.toggle("hidden", !next);
  $("#main").inert = next;
  document.body.classList.toggle("drawer-locked", next);
  sidebarToggle.setAttribute("aria-expanded", String(next));
  sidebarToggle.setAttribute("aria-label", next ? "关闭侧栏" : "打开侧栏");
  sidebarToggle.title = next ? "关闭侧栏" : "打开侧栏";
  if (next) {
    setBackgroundOpen(false);
    setTodosOpen(false);
    // Keep keyboard focus out of the page area the overlay covers.
    if (!wasOpen) $("#new-session").focus({ preventScroll: true });
  } else if (wasOpen && narrowQuery.matches && !document.querySelector(".modal:not(.hidden)")) {
    sidebarToggle.focus({ preventScroll: true });
  }
}

sidebarToggle.onclick = () => setSidebarOpen(!sidebarEl.classList.contains("open"));
sidebarOverlay.onclick = () => setSidebarOpen(false);
narrowQuery.addEventListener("change", () => setSidebarOpen(false));

// On phones the drawer would otherwise cover the conversation after navigating.
sidebarEl.addEventListener("click", (e) => {
  if (e.target.closest(".session-item") && !e.target.closest(".session-actions")) setSidebarOpen(false);
  else if (e.target.closest("#new-session, #help-btn, #llm-config, #quit")) setSidebarOpen(false);
});

// Edge swipe: open from the left edge, close with a left flick. Passive
// listeners keep vertical scrolling smooth; text fields are ignored so
// selecting text in the search box cannot close the drawer.
let swipeStartX = 0;
let swipeStartY = 0;
let swipeStartAt = 0;
let swipeBlocked = false;
document.addEventListener(
  "touchstart",
  (e) => {
    swipeStartAt = 0;
    if (!narrowQuery.matches || e.touches.length !== 1) return;
    const t = e.touches[0];
    swipeStartX = t.clientX;
    swipeStartY = t.clientY;
    swipeStartAt = Date.now();
    swipeBlocked = e.target instanceof Element && !!e.target.closest("input, textarea, select, [contenteditable]");
  },
  { passive: true },
);
document.addEventListener(
  "touchend",
  (e) => {
    const startedAt = swipeStartAt;
    swipeStartAt = 0;
    if (!startedAt || !narrowQuery.matches || swipeBlocked || document.querySelector(".modal:not(.hidden)")) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - swipeStartX;
    const dy = t.clientY - swipeStartY;
    if (Date.now() - startedAt > 600 || Math.abs(dy) > 50 || Math.abs(dx) < 60) return;
    const open = sidebarEl.classList.contains("open");
    if (!open && dx > 0 && swipeStartX <= 24) setSidebarOpen(true);
    else if (open && dx < 0) setSidebarOpen(false);
  },
  { passive: true },
);

/* ---------------- shortcut help ---------------- */

let helpReturnFocus = null;

function openHelp() {
  helpReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  hidePalette();
  setBackgroundOpen(false);
  setTodosOpen(false);
  $("#help-modal").classList.remove("hidden");
  $("#help-close").focus({ preventScroll: true });
}

function closeHelp() {
  $("#help-modal").classList.add("hidden");
  const back = helpReturnFocus;
  helpReturnFocus = null;
  if (back && back.isConnected && back.getClientRects().length) back.focus({ preventScroll: true });
  else $("#input").focus({ preventScroll: true });
}

function isTypingTarget(target) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
  );
}

$("#help-btn").onclick = () => {
  setSidebarOpen(false);
  openHelp();
};
$("#help-close").onclick = closeHelp;

/* ---------------- composer ---------------- */

const input = $("#input");

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(200, input.scrollHeight) + "px";
  updateComposer();
  updatePalette();
});

input.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return; // Enter/Escape belong to the IME while composing
  if (!$("#perm-modal").classList.contains("hidden")) return; // modal owns keys
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
    return;
  }
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
  input.value = "";
  input.style.height = "auto";
  hidePalette();
  // A new user message is an explicit "show me the latest" — reattach even if
  // the user was reading earlier output.
  follow.on = true;
  updateJumpButton();
  const images = state.images;
  state.images = [];
  renderAttachments();
  updateComposer();
  try {
    const body = { text, images: images.length ? images : undefined };
    // 插话模式: mid-turn input injects into the running turn instead of
    // queuing as a follow-up turn.
    if (state.steerMode && state.busy) body.steer = true;
    const r = await api("/api/chat", body);
    if (r.error === "busy") toast("智能体正忙", true);
    if (r.queued === "pending") toast("已排队，将在当前回合结束后作为新回合执行");
    else if (r.queued) toast("已加入本轮插话，将在下个间隙生效");
  } catch (err) {
    toast("发送失败: " + err.message, true);
  }
}

/* 插话模式: while busy, send injects into the running turn instead of queuing */
$("#steer-toggle").onclick = () => {
  state.steerMode = !state.steerMode;
  $("#steer-toggle").classList.toggle("on", state.steerMode);
};

$("#send").onclick = send;
$("#stop").onclick = () => api("/api/abort", {});

/* welcome quick-start: fill the composer (don't auto-send — approval flow stays in the user's hands) */
document.querySelectorAll("#welcome .hint").forEach((b) => {
  b.onclick = () => {
    input.value = b.dataset.prompt ?? "";
    input.focus();
    input.dispatchEvent(new Event("input"));
  };
});

/* attachments */
$("#attach").onclick = () => $("#file-input").click();
$("#file-input").onchange = (e) => {
  for (const file of e.target.files) addImageFile(file);
  e.target.value = "";
};

function addImageFile(file) {
  if (file.size > 5 * 1024 * 1024) {
    toast(`图片 ${file.name} 超过 5MB 上限`, true);
    return false;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = dataUrl.split(",")[1];
    state.images.push({ type: "image", source: { type: "base64", media_type: file.type, data: base64 } });
    renderAttachments();
    updateComposer();
  };
  reader.readAsDataURL(file);
  return true;
}

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
      updateComposer();
    };
    chip.appendChild(im);
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

/* ---------------- drag & drop ---------------- */

const TEXT_FILE_RE =
  /\.(txt|md|markdown|json|jsonc|json5|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html?|xml|svg|ya?ml|toml|ini|cfg|conf|env|log|csv|tsv|py|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|zsh|ps1|bat|sql|gradle|swift|lua|vue|svelte|dockerfile|gitignore)$/i;
const MAX_DROP_TEXT = 200 * 1024;

let dragDepth = 0;

function fileDrag(e) {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

function endDrag() {
  dragDepth = 0;
  $("#composer").classList.remove("dragover");
  $("#drop-hint").classList.add("hidden");
}

/** Relative path when the dropped file lives under the project, else "". */
function relativeToCwd(abs) {
  const cwd = (state.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const norm = abs.replace(/\\/g, "/");
  if (!cwd) return "";
  const lower = norm.toLowerCase();
  const base = cwd.toLowerCase();
  if (!lower.startsWith(base + "/")) return "";
  return norm.slice(cwd.length + 1);
}

function insertComposerText(text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const pad = before && !/\s$/.test(before) ? " " : "";
  input.value = before + pad + text + after;
  const pos = before.length + pad.length + text.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  input.dispatchEvent(new Event("input"));
}

async function addDroppedFiles(files) {
  let added = 0;
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      if (addImageFile(file)) added++;
      continue;
    }
    // Electron: resolve the real path so the agent can read the file with @path.
    const abs = window.mojo?.getPathForFile?.(file) || "";
    const rel = abs ? relativeToCwd(abs) : "";
    if (rel) {
      insertComposerText(`@${/[\s"(),;]/.test(rel) ? `"${rel}"` : rel} `);
      added++;
      continue;
    }
    if (!file.type.startsWith("text/") && !TEXT_FILE_RE.test(file.name)) {
      toast(`${file.name} 不在当前项目内，且不是文本文件，无法插入`, true);
      continue;
    }
    if (file.size > MAX_DROP_TEXT) {
      toast(`${file.name} 超过 200KB，未插入`, true);
      continue;
    }
    try {
      const content = await file.text();
      insertComposerText(`\n<file name="${file.name.replace(/"/g, "'")}">\n${content}\n</file>\n`);
      added++;
    } catch {
      toast(`无法读取 ${file.name}`, true);
    }
  }
  if (added) toast(`已添加 ${added} 个附件`);
}

window.addEventListener("dragenter", (e) => {
  if (!fileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  $("#composer").classList.add("dragover");
  $("#drop-hint").classList.remove("hidden");
});

window.addEventListener("dragover", (e) => {
  if (!fileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (e) => {
  if (!fileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) endDrag();
});

window.addEventListener("drop", (e) => {
  if (!fileDrag(e)) return;
  // Always stop the browser from navigating to the file.
  e.preventDefault();
  endDrag();
  if (document.querySelector(".modal:not(.hidden)")) return;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) void addDroppedFiles(files);
});

/* command palette */
const BUILTIN_CMDS = [
  ["/help", "命令列表"],
  ["/doctor", "诊断体检"],
  ["/model", "查看/切换模型"],
  ["/compact", "压缩上下文"],
  ["/context", "上下文占用明细"],
  ["/cost", "费用与预算"],
  ["/plan", "切换 Plan 模式"],
  ["/auto", "切换自动批准"],
  ["/yolo", "切换 YOLO"],
  ["/review ", "代码审查"],
  ["/undo", "撤销文件修改"],
  ["/rewind ", "工作区回滚到检查点 <id|latest>"],
  ["/sessions", "会话列表"],
  ["/search ", "跨会话全文检索 <词>"],
  ["/resume ", "恢复会话 <id>"],
  ["/fork ", "从当前会话分叉"],
  ["/rename ", "给当前会话改名"],
  ["/tag ", "设置会话标签 <标签…>"],
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

/* ---------------- 命令中心（Ctrl/Cmd + P） ----------------
   与输入框里的 "/" 内联补全互补：这里是全局面板，不用先聚焦输入框。
   无参命令直接经 composer 发送（与手输完全同一条链路）；带参命令
   （BUILTIN_CMDS 里名字以空格结尾的约定）只预填输入框。 */

const CMDK_ACTIONS = [
  ["新建会话", "开始全新会话", "#new-session"],
  ["会话搜索", "查找并切换历史会话", () => {
    setSidebarOpen(true); // 宽屏下侧栏常开，此调用为 no-op
    sessionSearch.focus();
    sessionSearch.select();
  }],
  ["切换项目", "选择其它工作目录", "#open-project"],
  ["LLM 配置", "提供商 / Key / Base URL / 模型", "#llm-config"],
  ["权限模式", "切换批准策略", "#perm-btn"],
  ["待办面板", "查看任务进度", "#todo-btn"],
  ["后台任务", "仍在运行的命令", "#background-btn"],
  ["用量仪表盘", "跨会话费用与缓存", "#usage-btn"],
  ["MCP 与权限管理", "管理面板", "#manage-btn"],
  ["快捷键", "打开快捷键清单", "#help-btn"],
];

let cmdkReturnFocus = null;
let cmdkEntries = [];

function cmdkOpen() {
  return !$("#cmdk-modal").classList.contains("hidden");
}

function openCommandCenter() {
  if (document.querySelector(".modal:not(#cmdk-modal):not(.hidden)")) return;
  cmdkReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  hidePalette();
  closePops();
  $("#cmdk-modal").classList.remove("hidden");
  $("#cmdk-input").value = "";
  renderCmdk("");
  $("#cmdk-input").focus();
}

function closeCommandCenter() {
  $("#cmdk-modal").classList.add("hidden");
  cmdkReturnFocus?.focus({ preventScroll: true });
  cmdkReturnFocus = null;
}

function renderCmdk(q) {
  const needle = q.trim().toLowerCase();
  const sources = [];
  for (const [name, desc] of BUILTIN_CMDS) {
    sources.push({ kind: "cmd", name: name.trim(), desc, prefill: name.endsWith(" ") });
  }
  for (const c of customCmds) {
    sources.push({ kind: "cmd", name: "/" + c.name, desc: c.description || "自定义命令", prefill: true });
  }
  for (const [name, desc, target] of CMDK_ACTIONS) sources.push({ kind: "action", name, desc, target });
  cmdkEntries = sources.filter((s) => !needle || (s.name + " " + s.desc).toLowerCase().includes(needle));

  const list = $("#cmdk-list");
  list.replaceChildren();
  if (!cmdkEntries.length) {
    list.appendChild(el("div", "cmdk-empty", "无匹配项"));
    return;
  }
  cmdkEntries.slice(0, 50).forEach((entry, i) => {
    const item = el("div", "cmdk-item" + (i === 0 ? " active" : ""));
    item.appendChild(el("span", "cmdk-kind", entry.kind === "cmd" ? "命令" : "操作"));
    item.appendChild(el("span", "cmdk-name", entry.name));
    item.appendChild(el("span", "cmdk-desc", entry.desc));
    item.onclick = () => runCmdk(entry);
    list.appendChild(item);
  });
}

function cmdkMove(dir) {
  const items = [...$("#cmdk-list").children];
  if (!items.length || items[0].classList.contains("cmdk-empty")) return;
  const idx = items.findIndex((i) => i.classList.contains("active"));
  items[idx]?.classList.remove("active");
  const next = items[(idx + dir + items.length) % items.length];
  next.classList.add("active");
  next.scrollIntoView({ block: "nearest" });
}

function cmdkActive() {
  return cmdkEntries[([...$("#cmdk-list").children].findIndex((i) => i.classList.contains("active")))] ?? cmdkEntries[0];
}

function runCmdk(entry) {
  if (!entry) return;
  closeCommandCenter();
  if (entry.kind === "action") {
    if (typeof entry.target === "function") entry.target();
    else document.querySelector(entry.target)?.click();
    return;
  }
  if (entry.prefill) {
    input.value = entry.name + " ";
    input.focus();
    input.dispatchEvent(new Event("input"));
    return;
  }
  input.value = entry.name;
  void send();
}

$("#cmdk-btn").onclick = openCommandCenter;
$("#cmdk-input").addEventListener("input", () => renderCmdk($("#cmdk-input").value));
$("#cmdk-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); cmdkMove(1); return; }
  if (e.key === "ArrowUp") { e.preventDefault(); cmdkMove(-1); return; }
  if (e.key === "Enter") { e.preventDefault(); runCmdk(cmdkActive()); return; }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCommandCenter(); }
});
$("#cmdk-modal").addEventListener("click", (e) => {
  if (e.target.id === "cmdk-modal") closeCommandCenter();
});

/* ---------------- 卡片下方工具行：权限模式 / 工作空间 ---------------- */

/** 极简浮层开合：点按钮切换，点别处收起。 */
function togglePop(id) {
  const pop = document.getElementById(id);
  const willOpen = pop.classList.contains("hidden");
  closePops();
  if (!willOpen) return;
  if (id === "ws-pop") renderWorkspaceMenu(); // 菜单内容跟着最新的会话列表走
  pop.classList.remove("hidden");
}

function closePops() {
  document.querySelectorAll(".pop").forEach((p) => p.classList.add("hidden"));
}

$("#perm-btn").onclick = (e) => {
  e.stopPropagation();
  togglePop("perm-pop");
};

$("#open-project").onclick = (e) => {
  e.stopPropagation();
  togglePop("ws-pop");
};

/* 权限下拉：三档 mode + PLAN（= 只读计划模式），选哪个就是哪种权限 */
$("#perm-pop").addEventListener("click", async (e) => {
  const btn = e.target.closest(".pop-item");
  if (!btn) return;
  closePops();
  if (state.busy) return toast("请先停止当前回合", true);
  if (btn.dataset.plan === "1") {
    const r = await api("/api/settings", { planMode: true });
    return syncPermissionUi({ planMode: r.planMode, mode: state.mode });
  }
  const r = await api("/api/settings", { mode: btn.dataset.mode, planMode: false });
  syncPermissionUi({ planMode: r.planMode, mode: r.mode });
});

/* 点别处收起浮层（浮层与工具行内部的点击不算） */
document.addEventListener("click", (e) => {
  if (!e.target.closest(".pop") && !e.target.closest(".tb-item")) closePops();
});

$("#model-select").onchange = async () => {
  const model = $("#model-select").value;
  if (!model) return;
  const r = await api("/api/command", { line: "/model " + model });
  toast(r.text ?? "已切换");
  refreshState().catch(() => {});
  loadModelOptions();
};

/**
 * 模型下拉 = 当前生效的模型 + 当前端点返回的模型。
 * 未启用的配置不在这里出现——切换配置请在「⚙ 模型配置」里做。
 */
async function loadModelOptions() {
  const sel = $("#model-select");
  const models = await api("/api/models").catch(() => null);

  sel.replaceChildren();

  // 当前生效的模型（value 为空，选它不会触发切换）
  if (state.model) {
    const current = el("option", "", state.model);
    current.value = "";
    current.selected = true;
    sel.appendChild(current);
  } else {
    const placeholder = el("option", "", "选择模型…");
    placeholder.value = "";
    sel.appendChild(placeholder);
  }

  if (Array.isArray(models)) {
    for (const m of models.slice(0, 200)) {
      if (m === state.model) continue; // 已经作为当前项列在上面了
      const o = el("option", "", m);
      o.value = m;
      sel.appendChild(o);
    }
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
  state.sessions = Array.isArray(list) ? list : [];
  const box = $("#session-list");
  box.replaceChildren();
  if (!Array.isArray(list)) return;
  if (!list.length) {
    box.appendChild(el("div", "s-empty", "还没有会话"));
    return;
  }
  for (const s of list.slice(0, 50)) {
    const item = el("div", "session-item" + (s.id === state.sessionId ? " active" : ""));
    const title = el("div", "s-title");
    // 徽标放在标题前面：标题过长被省略号截断时它不会被一起吃掉
    if (s.id === state.sessionId) title.appendChild(el("span", "s-badge", "当前"));
    title.appendChild(document.createTextNode(s.title || s.preview || s.id));
    item.appendChild(title);
    if (s.tags?.length) item.appendChild(el("div", "s-tags", s.tags.map((t) => "#" + t).join(" ")));
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
    const tagBtn = el("button", "", "🏷");
    tagBtn.title = "标签";
    tagBtn.onclick = async (e) => {
      e.stopPropagation();
      const raw = await promptText("标签（空格分隔，留空清除全部）", (s.tags ?? []).join(" "));
      if (raw === null) return;
      const tags = raw.trim().split(/\s+/).filter(Boolean);
      const r = await api("/api/session/tags", { id: s.id, tags });
      if (r.error) return toast("标签保存失败: " + r.error, true);
      loadSessions();
    };
    const delBtn = el("button", "del", "🗑");
    delBtn.title = "删除";
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const isActive = s.id === state.sessionId;
      const label = s.title ? `“${s.title}”` : s.id;
      const msg = isActive
        ? `删除当前打开的会话 ${label}？删除后当前对话清空，下一条消息才会新建会话。`
        : `删除会话 ${label}？此操作不可撤销。`;
      if (!(await confirmText(msg))) return;
      const r = await api("/api/session/delete", { id: s.id });
      if (r.error) return toast(r.error === "busy" ? "请先停止当前回合" : "删除失败: " + r.error, true);
      if (r.activeCleared) {
        toast("当前会话已删除，下条消息会新建会话");
        await refreshState();
      }
      loadSessions();
    };
    actions.appendChild(renameBtn);
    actions.appendChild(tagBtn);
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
    item.appendChild(el("div", "s-title", (h.titleMatch ? "标题 · " : "") + (s.title || s.preview || s.id) + (s.tags?.length ? "  " + s.tags.map((t) => "#" + t).join(" ") : "")));
    if (h.snippet) item.appendChild(el("div", "s-snippet", h.snippet));
    const meta = el("div", "s-meta");
    meta.appendChild(el("span", "s-sub", h.matches ? `${h.matches} 条命中` : h.titleMatch ? "标题命中" : "标签命中"));
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
function promptText(title, value, maxLength = 80) {
  return new Promise((resolve) => {
    $("#input-title").textContent = title;
    const field = $("#input-field");
    const prevMax = field.maxLength;
    field.maxLength = maxLength;
    field.value = value ?? "";
    $("#input-modal").classList.remove("hidden");
    field.focus();
    field.select();
    const finish = (result) => {
      $("#input-modal").classList.add("hidden");
      field.maxLength = prevMax;
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
function confirmText(message, okLabel = "删除") {
  return new Promise((resolve) => {
    $("#input-title").textContent = message;
    $("#input-field").value = "";
    $("#input-field").style.display = "none";
    $("#input-modal").classList.remove("hidden");
    $("#input-ok").textContent = okLabel;
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

/* 工作目录菜单：最近目录（从会话列表里的 cwd 推出来）+ 打开文件夹… */

function renderWorkspaceMenu() {
  const pop = $("#ws-pop");
  pop.replaceChildren();
  pop.appendChild(el("div", "pop-head", "最近目录"));

  const seen = new Set();
  let added = 0;
  for (const s of state.sessions) {
    if (!s.cwd || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    const cur = samePath(s.cwd, state.cwd);
    const btn = el("button", "pop-item" + (cur ? " on" : ""));
    btn.title = s.cwd;
    btn.appendChild(el("span", "p-ico", "▸"));
    const text = el("span", "p-text");
    text.appendChild(el("span", "p-name", s.cwd));
    btn.appendChild(text);
    btn.appendChild(el(cur ? "p-cur" : "p-when", "", cur ? "当前" : relTime(s.updatedAt)));
    btn.onclick = () => switchProject(s.cwd);
    pop.appendChild(btn);
    if (++added >= 5) break;
  }
  if (!added) pop.appendChild(el("div", "s-empty", "还没有其他目录"));

  pop.appendChild(el("div", "pop-sep"));
  const pick = el("button", "pop-item");
  pick.appendChild(el("span", "p-ico", "📂"));
  const text = el("span", "p-text");
  text.appendChild(el("span", "p-name", "打开文件夹…"));
  text.appendChild(el("span", "p-desc", "选择本机任意目录"));
  pick.appendChild(text);
  pick.onclick = pickProjectFolder;
  pop.appendChild(pick);
}

async function switchProject(cwd) {
  closePops();
  if (state.busy) return toast("请先停止当前回合", true);
  const r = await api("/api/project", { cwd });
  if (r.error) return toast("切换失败: " + r.error, true);
  await refreshState();
  await loadSessions();
  toast("已切换到 " + r.cwd);
}

/* Electron 走原生目录选择框，浏览器版走路径输入 */
async function pickProjectFolder() {
  closePops();
  if (state.busy) return toast("请先停止当前回合", true);
  const cur = state.cwd || "";
  let dir = null;
  try {
    if (window.mojo?.pickProject) dir = await window.mojo.pickProject(cur);
    else dir = await promptText("工作目录（绝对路径，或相对当前目录）", cur, 260);
  } catch (err) {
    return toast("打开目录失败: " + (err instanceof Error ? err.message : String(err)), true);
  }
  if (!dir) return;
  await switchProject(dir);
}

/* ---------------- LLM 配置面板（侧栏「模型配置」） ---------------- */

const cfgState = { profiles: [], activeId: "", editing: null };

function openLlmModal() {
  $("#llm-modal").classList.remove("hidden");
  hideCfgForm();
  loadLlmProfiles();
}

function closeLlmModal() {
  $("#llm-modal").classList.add("hidden");
}

async function loadLlmProfiles() {
  const data = await api("/api/llm/profiles");
  if (data.error) return toast("读取 LLM 配置失败: " + data.error, true);
  cfgState.profiles = data.profiles ?? [];
  cfgState.activeId = data.activeId ?? "";
  renderLlmList(!!data.projectOverrides);
}

/** 1048576 → "1M", 128000 → "128k". */
function shortTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function renderLlmList(projectOverrides) {
  const box = $("#cfg-list");
  box.replaceChildren();
  const active = cfgState.profiles.find((p) => p.id === cfgState.activeId);
  $("#cfg-active").textContent = active ? `生效中：${active.name}` : "";
  $("#cfg-active").title = projectOverrides ? "当前目录的 .node-agent/config.json 里有配置，重启后会以它为准" : "";

  if (!cfgState.profiles.length) {
    box.appendChild(el("div", "cfg-empty", "还没有配置。点右上角「＋ 新增」，填好格式、Base URL、API Key 和模型即可。"));
    return;
  }

  for (const p of cfgState.profiles) {
    const row = el("div", "cfg-item" + (p.id === cfgState.activeId ? " active" : ""));
    const main = el("div", "cfg-item-main");
    const title = el("div", "cfg-item-title");
    title.appendChild(el("span", "cfg-item-name", p.name));
    title.appendChild(el("span", "cfg-badge", p.provider === "openai" ? "OpenAI 兼容" : "Anthropic"));
    if (p.id === cfgState.activeId) title.appendChild(el("span", "cfg-badge on", "生效中"));
    main.appendChild(title);
    main.appendChild(el("div", "cfg-item-model", p.model));
    const ctx = p.contextWindow ? ` · ctx ${shortTokens(p.contextWindow)}` : "";
    main.appendChild(
      el("div", "cfg-item-sub", `${p.baseURL || "官方默认地址"} · ${p.hasKey ? "Key " + p.keyMasked : "未填 Key"}${ctx}`),
    );
    row.appendChild(main);

    const actions = el("div", "cfg-item-actions");
    const isOn = p.id === cfgState.activeId;
    const toggle = el("button", isOn ? "warn" : "", isOn ? "禁用" : "启用");
    toggle.title = isOn
      ? "停用这条配置（重启后回落到环境变量 / 默认配置）"
      : "启用这条配置：写入全局 config.json 并立即切换";
    toggle.onclick = () => (isOn ? disableLlmProfile(p) : activateLlmProfile(p.id));
    actions.appendChild(toggle);
    const edit = el("button", "", "✎");
    edit.title = "编辑";
    edit.onclick = () => showCfgForm(p);
    const del = el("button", "del", "🗑");
    del.title = "删除";
    del.onclick = async () => {
      if (!(await confirmText(`删除配置「${p.name}」？`))) return;
      const r = await api("/api/llm/profile/delete", { id: p.id });
      if (r.error) return toast("删除失败: " + r.error, true);
      if (cfgState.editing === p.id) hideCfgForm();
      await loadLlmProfiles();
    };
    actions.appendChild(edit);
    actions.appendChild(del);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

/** 清除上一次「拉取列表」的候选（换配置 / 换地址后不再适用）。 */
function resetCfgModelSuggestions() {
  $("#cfg-model-list").replaceChildren();
}

function showCfgForm(p) {
  cfgState.editing = p?.id ?? null;
  $("#cfg-form").classList.remove("hidden");
  $("#cfg-name").value = p?.name ?? "";
  $("#cfg-provider").value = p?.provider ?? "anthropic";
  $("#cfg-baseurl").value = p?.baseURL ?? "";
  $("#cfg-key").value = "";
  $("#cfg-key").placeholder = p?.hasKey ? `留空沿用已保存的 Key（${p.keyMasked}）` : "粘贴 API Key";
  $("#cfg-model").value = p?.model ?? "";
  $("#cfg-ctx").value = p?.contextWindow ? String(p.contextWindow) : "";
  resetCfgModelSuggestions();
  setCfgNote("");
  $("#cfg-name").focus();
}

function hideCfgForm() {
  cfgState.editing = null;
  $("#cfg-form").classList.add("hidden");
}

function cfgDraft() {
  const ctxRaw = $("#cfg-ctx").value.trim();
  const ctx = ctxRaw ? Number(ctxRaw) : NaN;
  return {
    id: cfgState.editing ?? undefined,
    name: $("#cfg-name").value.trim(),
    provider: $("#cfg-provider").value,
    baseURL: $("#cfg-baseurl").value.trim(),
    apiKey: $("#cfg-key").value.trim(),
    model: $("#cfg-model").value.trim(),
    contextWindow: Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : undefined,
  };
}

function setCfgNote(text, isError) {
  const note = $("#cfg-note");
  note.textContent = text;
  note.classList.toggle("error", !!isError);
  note.classList.toggle("hidden", !text);
}

async function saveCfgProfile() {
  const draft = cfgDraft();
  if (!draft.model) return setCfgNote("请填写模型名（可以先点「拉取列表」看看端点提供哪些）", true);
  const r = await api("/api/llm/profile/save", draft);
  if (r.error) return setCfgNote("保存失败: " + r.error, true);
  cfgState.editing = r.id;
  await loadLlmProfiles();
  hideCfgForm();
  toast("已保存");
}

/** 停用：清掉生效标记（以及它写进全局 config 的值），运行中的会话保持不变。 */
async function disableLlmProfile(p) {
  const r = await api("/api/llm/profile/disable", { id: p.id });
  if (r.error) return toast("禁用失败: " + r.error, true);
  await loadLlmProfiles();
  toast(`已禁用 ${p.name}`);
}

async function activateLlmProfile(id) {
  const r = await api("/api/llm/profile/activate", { id });
  if (r.error) {
    const msg = r.error === "busy" ? "请先停止当前回合再切换配置" : "启用失败: " + r.error;
    // Clicking 启用 inside the list leaves the form hidden — toast then.
    if ($("#cfg-form").classList.contains("hidden")) return toast(msg, true);
    return setCfgNote(msg, true);
  }
  hideCfgForm();
  await loadLlmProfiles();
  await refreshState();
  await loadModelOptions();
  toast(`已启用 ${r.provider}:${r.model}` + (r.warning ? " · " + r.warning : ""));
}

/** 「拉取列表」：拿草稿里的地址与 Key 问端要点模型 id，填进模型框自带的候选。 */
async function fetchCfgModels() {
  setCfgNote("正在拉取模型列表…");
  resetCfgModelSuggestions();
  const r = await api("/api/llm/models", cfgDraft());
  if (!r.models) {
    return setCfgNote(`拉取失败: ${r.error ?? "未知错误"}。不少端点不提供模型列表，可以直接在模型框手填。`, true);
  }

  const list = $("#cfg-model-list");
  for (const m of r.models.slice(0, 300)) {
    const opt = document.createElement("option");
    opt.value = m;
    list.appendChild(opt);
  }

  // 只有一个候选才自动填；多个时保持输入框为空——datalist 会按输入框内容过滤，
  // 一旦填了第一个，其余候选就看不到了。
  if (!$("#cfg-model").value.trim() && r.models.length === 1) $("#cfg-model").value = r.models[0];
  setCfgNote((r.note ? r.note + " · " : "") + `${r.models.length} 个模型`);
  $("#cfg-model").focus();
}

$("#llm-config").onclick = openLlmModal;
$("#cfg-close").onclick = closeLlmModal;
$("#cfg-new").onclick = () => showCfgForm(null);
$("#cfg-cancel").onclick = hideCfgForm;
$("#cfg-fetch").onclick = fetchCfgModels;
$("#cfg-form").addEventListener("submit", (e) => {
  e.preventDefault();
  saveCfgProfile();
});

/* ---------------- usage dashboard ---------------- */

const fmtUsd = (usd) => {
  const v = Number(usd) || 0;
  if (v >= 1) return "$" + v.toFixed(2);
  if (v > 0) return "$" + v.toFixed(4);
  return "$0.00";
};

const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1) + "k";
  return String(v);
};

async function openUsage() {
  $("#usage-modal").classList.remove("hidden");
  await loadUsage();
}

async function loadUsage() {
  let data;
  try {
    data = await api("/api/usage");
  } catch {
    toast("读取用量失败", true);
    return;
  }
  if (data.error) return toast("读取用量失败: " + data.error, true);
  renderUsage(data);
}

function renderUsage(data) {
  const total = data.totals ?? {};
  const session = data.session ?? {};

  const cards = [
    {
      cls: "accent",
      label: "累计花费",
      value: fmtUsd(total.usd),
      sub: `${(total.requests ?? 0).toLocaleString()} 次请求 · ${total.sessions ?? 0} 个会话 · ${total.days ?? 0} 天`,
    },
    {
      cls: "green",
      label: "缓存命中率",
      value: ((total.cacheShare ?? 0) * 100).toFixed(1) + "%",
      sub: `读 ${fmtTokens(total.cacheRead)} · 写 ${fmtTokens(total.cacheWrite)}`,
    },
    {
      label: "输入 tokens",
      value: fmtTokens(total.input),
      sub: "未命中缓存的输入",
    },
    {
      label: "输出 tokens",
      value: fmtTokens(total.output),
      sub: total.unpriced ? `${total.unpriced} 次请求无定价` : "全部请求已定价",
    },
  ];
  const cardBox = $("#usage-cards");
  cardBox.replaceChildren();
  for (const c of cards) {
    const card = el("div", "usage-stat" + (c.cls ? " " + c.cls : ""));
    card.appendChild(el("div", "u-label", c.label));
    card.appendChild(el("div", "u-value", c.value));
    card.appendChild(el("div", "u-sub", c.sub));
    cardBox.appendChild(card);
  }

  const budget = session.budgetUsd;
  if (document.activeElement !== $("#budget-input")) $("#budget-input").value = budget != null ? String(budget) : "";
  const used = budget ? Math.min(999, Math.round(((session.usd ?? 0) / budget) * 100)) : 0;
  $("#budget-note").textContent =
    `本会话 ${fmtUsd(session.usd)} · ${session.requests ?? 0} 次请求` + (budget != null ? ` · 已用 ${used}%` : " · 未设上限");

  const models = data.byModel ?? [];
  renderUsageRows("#usage-models", models, { empty: "还没有用量记录。", label: (r) => r.key });
  $("#usage-models-count").textContent = `${models.length} 个模型`;

  const days = [...(data.byDay ?? [])].sort((a, b) => String(b.key).localeCompare(String(a.key))).slice(0, 14);
  renderUsageRows("#usage-days", days, { empty: "还没有按天记录。", label: (r) => r.key });

  const sessions = data.bySession ?? [];
  renderUsageRows("#usage-sessions", sessions, {
    empty: "还没有会话记录。",
    label: (r) => r.title || String(r.key).slice(0, 14),
  });
  $("#usage-sessions-count").textContent = `${sessions.length} 个会话`;

  $("#usage-ledger").textContent =
    `账本: ${data.ledger}` + (total.unpriced ? ` · ${total.unpriced} 次请求没有定价，费用被低估` : "");
}

function renderUsageRows(selector, rows, opts) {
  const box = $(selector);
  box.replaceChildren();
  if (!rows.length) {
    box.appendChild(el("div", "usage-empty", opts.empty));
    return;
  }
  const maxUsd = Math.max(...rows.map((r) => Number(r.usd) || 0), 0);
  for (const row of rows.slice(0, 20)) {
    const line = el("div", "usage-row");
    line.title = `${row.requests} 次请求 · 输入 ${row.input} · 输出 ${row.output} · 缓存读 ${row.cacheRead} · 缓存写 ${row.cacheWrite}`;
    line.appendChild(el("span", "u-name", opts.label(row)));
    const bar = el("span", "u-bar");
    const fill = document.createElement("i");
    fill.style.width = maxUsd > 0 && row.usd > 0 ? Math.max(2, Math.round((row.usd / maxUsd) * 100)) + "%" : "0";
    bar.appendChild(fill);
    line.appendChild(bar);
    const tokens = (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);
    line.appendChild(el("span", "u-num", `${fmtTokens(tokens)} tok · ${row.requests} 次`));
    line.appendChild(el("span", "u-usd", fmtUsd(row.usd)));
    box.appendChild(line);
  }
  if (rows.length > 20) box.appendChild(el("div", "usage-empty", `仅显示前 20 条，共 ${rows.length} 条`));
}

async function saveBudget(usd) {
  let r;
  try {
    r = await api("/api/usage/budget", { usd });
  } catch {
    return toast("预算保存失败", true);
  }
  if (r.error) return toast("预算保存失败: " + r.error, true);
  toast(usd == null ? "已清除会话预算" : `会话预算已设为 ${fmtUsd(usd)}`);
  await loadUsage();
}

$("#usage-btn").onclick = () => void openUsage();
$("#usage-close").onclick = () => $("#usage-modal").classList.add("hidden");
$("#budget-save").onclick = () => {
  const raw = $("#budget-input").value.trim();
  if (!raw) return toast("请输入预算金额，或点“清除”", true);
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) return toast("预算需为正数", true);
  void saveBudget(usd);
};
$("#budget-clear").onclick = () => {
  $("#budget-input").value = "";
  void saveBudget(null);
};

/* ---------------- MCP & permission management ---------------- */

let mcpData = { servers: [], disabled: false };
let mcpEditing = null;
let permData = { global: [], project: [], mode: "default" };
let cronData = { tasks: [], disabled: false, scheduler: { running: false, owner: false }, error: null };
let cronEditing = null;

const manageError = (error) => (error === "busy" ? "请先停止当前回合" : error);

function switchManageTab(tab) {
  document.querySelectorAll("#manage-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#mcp-pane").classList.toggle("hidden", tab !== "mcp");
  $("#perm-pane").classList.toggle("hidden", tab !== "perm");
  $("#cron-pane").classList.toggle("hidden", tab !== "cron");
  if (tab !== "mcp") $("#mcp-editor").classList.add("hidden");
  if (tab !== "perm") $("#perm-editor").classList.add("hidden");
  if (tab !== "cron") $("#cron-editor").classList.add("hidden");
}

async function openManage(tab = "mcp") {
  $("#manage-modal").classList.remove("hidden");
  $("#mcp-editor").classList.add("hidden");
  $("#perm-editor").classList.add("hidden");
  $("#cron-editor").classList.add("hidden");
  mcpEditing = null;
  cronEditing = null;
  switchManageTab(tab);
  await loadManagement();
}

async function loadManagement() {
  try {
    const [mcp, perms, cron] = await Promise.all([api("/api/mcp"), api("/api/permissions"), api("/api/cron")]);
    if (mcp?.error) toast("读取 MCP 配置失败: " + mcp.error, true);
    else {
      mcpData = mcp;
      renderMcp();
    }
    if (perms?.error) toast("读取权限规则失败: " + perms.error, true);
    else renderPermissions(perms);
    if (cron?.error && !cron.tasks?.length) toast("读取定时任务失败: " + cron.error, true);
    else {
      cronData = cron;
      renderCron();
    }
  } catch {
    toast("读取管理数据失败", true);
  }
}

function renderMcp() {
  const list = $("#mcp-list");
  list.replaceChildren();
  const off = !!mcpData.disabled;
  const untrusted = mcpData.untrustedProject;
  $("#mcp-note").textContent = off
    ? "本次以 --no-mcp 启动：服务器不会连接，也无法在这里保存或重连。"
    : untrusted
      ? `项目 MCP 配置尚未信任，其中的服务器不会连接：${untrusted.file}。确认来源可信后点击“信任项目配置”。`
      : "项目 .mcp.json 中的同名服务器会覆盖全局配置。保存后会自动重连。";
  $("#mcp-add").disabled = off;
  $("#mcp-reload").disabled = off;
  $("#mcp-trust").classList.toggle("hidden", !untrusted || off);
  $("#mcp-trust").disabled = off;

  const servers = Array.isArray(mcpData.servers) ? mcpData.servers : [];
  if (!servers.length) {
    list.appendChild(el("div", "profile-empty", "还没有 MCP 服务器。点击“添加”连接 stdio 或远程 HTTP/SSE 服务。"));
    return;
  }
  for (const server of servers) {
    const row = el("div", "profile-row" + (server.disabled ? " muted" : ""));
    row.appendChild(el("span", "status-dot " + server.status));
    const main = el("div", "profile-main");
    const name = el("div", "profile-name");
    name.appendChild(document.createTextNode(server.name));
    name.appendChild(el("span", "profile-badge", server.scope === "project" ? "项目" : "全局"));
    if (server.url) name.appendChild(el("span", "profile-badge", "远程"));
    if (server.oauth) name.appendChild(el("span", "profile-badge", "OAuth"));
    if (server.disabled) name.appendChild(el("span", "profile-badge danger", "停用"));
    if (server.untrusted) name.appendChild(el("span", "profile-badge danger", "未信任"));
    if (server.shadowed) name.appendChild(el("span", "profile-badge", "被覆盖"));
    main.appendChild(name);
    main.appendChild(el("div", "profile-meta", server.url || [server.command, ...(server.args ?? [])].join(" ")));
    const statusText =
      server.status === "connected"
        ? `已连接 · ${server.toolCount} 个工具${server.kind ? ` · ${String(server.kind).toUpperCase()}` : ""}`
        : server.status === "failed"
          ? "连接失败"
          : server.status === "disabled"
            ? "已停用"
            : "未连接";
    main.appendChild(el("div", "profile-meta", statusText));
    if (server.error) main.appendChild(el("div", "mcp-error", server.error));
    row.appendChild(main);

    const actions = el("div", "profile-actions");
    const edit = el("button", "", "编辑");
    edit.type = "button";
    edit.onclick = () => openMcpEditor(server);
    const del = el("button", "del", "删除");
    del.type = "button";
    del.onclick = () => void deleteMcpServer(server);
    actions.append(edit, del);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function openMcpEditor(server) {
  mcpEditing = server ? { name: server.name, scope: server.scope } : null;
  $("#mcp-name").value = server?.name ?? "";
  $("#mcp-name").disabled = !!server;
  $("#mcp-scope").value = server?.scope ?? "global";
  $("#mcp-scope").disabled = !!server;
  $("#mcp-command").value = server?.command ?? "";
  $("#mcp-url").value = server?.url ?? "";
  $("#mcp-transport").value = server?.type ?? "";
  $("#mcp-headers").value = Object.entries(server?.headers ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
  $("#mcp-oauth").checked = !!server?.oauth;
  $("#mcp-args").value = (server?.args ?? []).join("\n");
  $("#mcp-env").value = Object.entries(server?.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
  $("#mcp-disabled").checked = !!server?.disabled;
  $("#mcp-edit-note").textContent = server
    ? "改名或切换作用域：请删除后重新添加。保存会立即重连全部 MCP 服务器。"
    : "全局写入 ~/.node-agent/mcp.json，项目写入 <项目>/.mcp.json；含凭据的 env/headers 均以 0600 权限保存。";
  $("#mcp-editor").classList.remove("hidden");
  $("#mcp-url").focus();
}

async function deleteMcpServer(server) {
  const scopeText = server.scope === "project" ? "项目" : "全局";
  if (!(await confirmText(`删除${scopeText} MCP 服务器「${server.name}」？`))) return;
  try {
    const r = await api("/api/mcp/delete", { name: server.name, scope: server.scope });
    if (r.error) return toast("删除失败: " + manageError(r.error), true);
    mcpData = r;
    renderMcp();
    toast(r.reloadError ? `已删除；重连失败: ${r.reloadError}` : `已删除 ${server.name}`, !!r.reloadError);
  } catch (err) {
    toast("删除失败: " + (err instanceof Error ? err.message : String(err)), true);
  }
}

async function trustMcpProject() {
  const btn = $("#mcp-trust");
  btn.disabled = true;
  try {
    const r = await api("/api/mcp/trust", {});
    if (r.error) return toast("信任失败: " + manageError(r.error), true);
    mcpData = r;
    renderMcp();
    toast(r.reloadError ? `已信任；重连失败: ${r.reloadError}` : "已信任项目 MCP 配置并重连", !!r.reloadError);
  } catch (err) {
    toast("信任失败: " + (err instanceof Error ? err.message : String(err)), true);
  } finally {
    btn.disabled = !!mcpData.disabled;
  }
}

async function reloadMcpServers() {
  const btn = $("#mcp-reload");
  btn.disabled = true;
  try {
    const r = await api("/api/mcp/reload", {});
    if (r.error) return toast("重连失败: " + manageError(r.error), true);
    mcpData = r;
    renderMcp();
    toast(r.reloadError ? `重连失败: ${r.reloadError}` : "已重新连接 MCP 服务器", !!r.reloadError);
  } catch (err) {
    toast("重连失败: " + (err instanceof Error ? err.message : String(err)), true);
  } finally {
    btn.disabled = !!mcpData.disabled;
  }
}

function renderPermissions(data) {
  permData = data ?? { global: [], project: [], mode: "default" };
  const list = $("#perm-list");
  list.replaceChildren();
  const modes = { default: "默认（逐次询问）", auto: "自动批准", yolo: "YOLO（跳过询问）" };
  $("#perm-note").textContent = `当前模式：${modes[permData.mode] ?? permData.mode}。项目规则优先于全局规则，改动立即生效。`;

  const rows = [
    ...(permData.project ?? []).map((rule, index) => ({ ...rule, scope: "project", index })),
    ...(permData.global ?? []).map((rule, index) => ({ ...rule, scope: "global", index })),
  ];
  if (!rows.length) {
    list.appendChild(el("div", "profile-empty", "还没有规则。非只读操作会按当前模式询问。"));
    return;
  }
  for (const rule of rows) {
    const row = el("div", "profile-row");
    row.appendChild(el("span", "perm-rule-badge " + rule.decision, rule.decision === "allow" ? "允许" : "拒绝"));
    const main = el("div", "profile-main");
    main.appendChild(el("div", "perm-match", rule.match));
    main.appendChild(
      el(
        "div",
        "profile-meta",
        rule.scope === "project" ? "项目 · .node-agent/permissions.json" : "全局 · ~/.node-agent/permissions.json",
      ),
    );
    row.appendChild(main);
    const del = el("button", "link-btn danger", "删除");
    del.type = "button";
    del.onclick = () => void deleteRule(rule);
    row.appendChild(del);
    list.appendChild(row);
  }
}

async function deleteRule(rule) {
  const scopeText = rule.scope === "project" ? "项目" : "全局";
  if (!(await confirmText(`删除${scopeText}规则「${rule.match}」？`))) return;
  try {
    const r = await api("/api/permissions/delete", { scope: rule.scope, index: rule.index });
    if (r.error) return toast("删除失败: " + manageError(r.error), true);
    renderPermissions(r);
    toast("规则已删除");
  } catch (err) {
    toast("删除失败: " + (err instanceof Error ? err.message : String(err)), true);
  }
}

function renderCron() {
  const list = $("#cron-list");
  list.replaceChildren();
  const off = !!cronData.disabled;
  const sched = cronData.scheduler ?? {};
  $("#cron-note").textContent = off
    ? "本次以 --no-cron 启动：任务不会自动触发，也不能立即运行；编辑仍会保存。"
    : !sched.running
      ? "调度器未在此进程运行。"
      : sched.owner
        ? "调度器在本进程运行。任务以无头 agent 会话执行，输出记录在 ~/.node-agent/cron-runs。"
        : "调度器由另一个 agent 进程持有，本进程待命；任务仍可编辑和立即运行。";

  if (cronData.error) {
    list.appendChild(el("div", "profile-empty", "读取任务失败: " + cronData.error));
    return;
  }
  const tasks = Array.isArray(cronData.tasks) ? cronData.tasks : [];
  if (!tasks.length) {
    list.appendChild(el("div", "profile-empty", "还没有定时任务。点击“添加”，用 5 段 cron 表达式安排一次自包含的 agent 运行。"));
    return;
  }
  for (const task of tasks) {
    const row = el("div", "profile-row" + (task.enabled ? "" : " muted"));
    const dot = task.running || task.lastStatus === "ok" ? "connected" : task.lastStatus === "error" ? "failed" : "stopped";
    row.appendChild(el("span", "status-dot " + dot));
    const main = el("div", "profile-main");
    const name = el("div", "profile-name");
    name.appendChild(document.createTextNode(task.name));
    name.appendChild(el("span", "profile-badge", task.cron));
    if (task.running) name.appendChild(el("span", "profile-badge", "运行中"));
    else if (!task.enabled) name.appendChild(el("span", "profile-badge danger", "已暂停"));
    else if (task.lastStatus === "error") name.appendChild(el("span", "profile-badge danger", "上次失败"));
    main.appendChild(name);
    const next = task.enabled ? new Date(task.nextRunAt).toLocaleString() : "暂停中";
    main.appendChild(el("div", "profile-meta", `下次 ${next} · 已运行 ${task.runCount} 次 · ${task.cwd}`));
    const last = task.lastRunAt
      ? `上次 ${new Date(task.lastRunAt).toLocaleString()}${task.lastStatus === "error" && task.lastError ? ` · ${task.lastError}` : ""}`
      : "从未运行";
    main.appendChild(el("div", "profile-meta", last));
    row.appendChild(main);

    const actions = el("div", "profile-actions");
    const run = el("button", "", "运行");
    run.type = "button";
    run.disabled = off || !!task.running;
    run.onclick = () => void runCronTask(task);
    const toggle = el("button", "", task.enabled ? "暂停" : "启用");
    toggle.type = "button";
    toggle.onclick = () => void toggleCronTask(task, !task.enabled);
    const edit = el("button", "", "编辑");
    edit.type = "button";
    edit.onclick = () => openCronEditor(task);
    const del = el("button", "del", "删除");
    del.type = "button";
    del.onclick = () => void deleteCronTask(task);
    actions.append(run, toggle, edit, del);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function openCronEditor(task) {
  cronEditing = task ? { id: task.id } : null;
  $("#cron-name").value = task?.name ?? "";
  $("#cron-expr").value = task?.cron ?? "";
  $("#cron-cwd").value = task?.cwd ?? state.cwd ?? "";
  $("#cron-prompt").value = task?.prompt ?? "";
  $("#cron-enabled").checked = task ? !!task.enabled : true;
  $("#cron-edit-note").textContent = task
    ? "保存后按新的表达式重新计算下一次运行；工作目录必须是绝对路径。"
    : "表达式使用本机时区，例如 0 9 * * 1-5 表示工作日 09:00；每次运行都会新开一轮无头会话。";
  $("#cron-editor").classList.remove("hidden");
  $("#cron-expr").focus();
}

async function runCronTask(task) {
  try {
    const r = await api("/api/cron/run", { id: task.id });
    if (r.error) return toast("运行失败: " + r.error, true);
    cronData = r;
    renderCron();
    toast(`已启动「${task.name}」，完成后状态会刷新`);
  } catch (err) {
    toast("运行失败: " + (err instanceof Error ? err.message : String(err)), true);
  }
}

async function toggleCronTask(task, enabled) {
  try {
    const r = await api("/api/cron/toggle", { id: task.id, enabled });
    if (r.error) return toast("操作失败: " + r.error, true);
    cronData = r;
    renderCron();
    toast(enabled ? `已启用「${task.name}」` : `已暂停「${task.name}」`);
  } catch (err) {
    toast("操作失败: " + (err instanceof Error ? err.message : String(err)), true);
  }
}

async function deleteCronTask(task) {
  if (!(await confirmText(`删除定时任务「${task.name}」？后续将不再运行。`))) return;
  try {
    const r = await api("/api/cron/delete", { id: task.id });
    if (r.error) return toast("删除失败: " + r.error, true);
    cronData = r;
    renderCron();
    toast(`已删除「${task.name}」`);
  } catch (err) {
    toast("删除失败: " + (err instanceof Error ? err.message : String(err)), true);
  }
}

$("#manage-btn").onclick = () => void openManage();
$("#manage-close").onclick = () => $("#manage-modal").classList.add("hidden");
document.querySelectorAll("#manage-tabs button").forEach((b) => (b.onclick = () => switchManageTab(b.dataset.tab)));
$("#mcp-add").onclick = () => openMcpEditor(null);
$("#mcp-cancel").onclick = () => {
  $("#mcp-editor").classList.add("hidden");
  mcpEditing = null;
};
$("#mcp-reload").onclick = () => void reloadMcpServers();
$("#mcp-trust").onclick = () => void trustMcpProject();

$("#mcp-save").onclick = async () => {
  if (mcpData.disabled) return toast("本次以 --no-mcp 启动，无法保存", true);
  const editing = mcpEditing;
  const name = editing?.name ?? $("#mcp-name").value.trim();
  const scope = editing?.scope ?? $("#mcp-scope").value;
  const url = $("#mcp-url").value.trim();
  if (!name) return toast("请填写名称", true);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) return toast("名称只能包含字母、数字、. _ -（≤40 字符）", true);

  const disabled = $("#mcp-disabled").checked;
  let config;
  if (url) {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return toast("远程 URL 无效", true);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return toast("远程 URL 只支持 http:// 或 https://", true);
    }
    const headers = {};
    for (const line of $("#mcp-headers").value.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      const eq = text.indexOf("=");
      if (eq <= 0) return toast(`Header 格式应为 KEY=VALUE：${text}`, true);
      headers[text.slice(0, eq).trim()] = text.slice(eq + 1);
    }
    const type = $("#mcp-transport").value;
    config = { url, headers, disabled, oauth: $("#mcp-oauth").checked, ...(type ? { type } : {}) };
  } else {
    const command = $("#mcp-command").value.trim();
    if (!command) return toast("请填写启动命令或远程 URL", true);
    const args = $("#mcp-args")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const env = {};
    for (const line of $("#mcp-env").value.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      const eq = text.indexOf("=");
      if (eq <= 0) return toast(`环境变量格式应为 KEY=VALUE：${text}`, true);
      env[text.slice(0, eq).trim()] = text.slice(eq + 1);
    }
    config = { command, args, env, disabled };
  }

  const btn = $("#mcp-save");
  btn.disabled = true;
  try {
    const r = await api("/api/mcp/save", { name, scope, config });
    if (r.error) return toast("保存失败: " + manageError(r.error), true);
    mcpData = r;
    mcpEditing = null;
    $("#mcp-editor").classList.add("hidden");
    renderMcp();
    toast(r.reloadError ? `已保存；重连失败: ${r.reloadError}` : `已保存 ${name}`, !!r.reloadError);
  } catch (err) {
    toast("保存失败: " + (err instanceof Error ? err.message : String(err)), true);
  } finally {
    btn.disabled = false;
    $("#mcp-add").disabled = !!mcpData.disabled;
  }
};

$("#perm-add").onclick = () => {
  $("#perm-match").value = "";
  $("#perm-decision").value = "allow";
  $("#perm-scope").value = "project";
  $("#perm-editor").classList.remove("hidden");
  $("#perm-match").focus();
};
$("#perm-cancel").onclick = () => $("#perm-editor").classList.add("hidden");
$("#perm-save").onclick = async () => {
  const match = $("#perm-match").value.trim();
  if (!match) return toast("请填写匹配模式", true);
  const btn = $("#perm-save");
  btn.disabled = true;
  try {
    const r = await api("/api/permissions/add", {
      scope: $("#perm-scope").value,
      match,
      decision: $("#perm-decision").value,
    });
    if (r.error) return toast("添加失败: " + manageError(r.error), true);
    renderPermissions(r);
    $("#perm-editor").classList.add("hidden");
    toast("规则已添加");
  } catch (err) {
    toast("添加失败: " + (err instanceof Error ? err.message : String(err)), true);
  } finally {
    btn.disabled = false;
  }
};

$("#cron-add").onclick = () => openCronEditor(null);
$("#cron-cancel").onclick = () => {
  $("#cron-editor").classList.add("hidden");
  cronEditing = null;
};
$("#cron-save").onclick = async () => {
  const name = $("#cron-name").value.trim();
  const cron = $("#cron-expr").value.trim().replace(/\s+/g, " ");
  const prompt = $("#cron-prompt").value.trim();
  const cwd = $("#cron-cwd").value.trim();
  const enabled = $("#cron-enabled").checked;
  if (!cron) return toast("请填写执行时间表达式", true);
  if (cron.split(" ").length !== 5) return toast("cron 需要 5 段：分 时 日 月 周", true);
  if (!prompt) return toast("请填写提示词", true);
  if (cwd && !/^([A-Za-z]:[\\/]|\/)/.test(cwd)) return toast("工作目录需要绝对路径", true);

  const btn = $("#cron-save");
  btn.disabled = true;
  try {
    const r = await api("/api/cron/save", { ...(cronEditing ? { id: cronEditing.id } : {}), name, cron, prompt, cwd, enabled });
    if (r.error) return toast("保存失败: " + r.error, true);
    cronData = r;
    cronEditing = null;
    $("#cron-editor").classList.add("hidden");
    renderCron();
    toast("定时任务已保存");
  } catch (err) {
    toast("保存失败: " + (err instanceof Error ? err.message : String(err)), true);
  } finally {
    btn.disabled = false;
  }
};

/* ---------------- notifications ---------------- */

/* Surface turn/permission/background events while the window is unfocused:
   a system notification when permitted, and always a title-bar badge that
   clears on focus. Hidden windows are the only audience — visible ones see
   the stream live. */

const notifyState = { unseen: 0 };

function resetTitleBadge() {
  notifyState.unseen = 0;
  document.title = "mojo";
}

function flashTitle() {
  notifyState.unseen += 1;
  document.title = `(${notifyState.unseen}) mojo`;
}

window.addEventListener("focus", resetTitleBadge);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) resetTitleBadge();
});

function notifyUser(title, body) {
  if (!document.hidden) return;
  flashTitle();
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      const n = new Notification(title, { body, tag: "mojo" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } else if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch {
    /* the title badge is the fallback */
  }
}

/* ---------------- background tasks ---------------- */

let bgTimer = null;
let bgPrevRunning = new Set();

async function loadBackground(silent = false) {
  try {
    renderBackground(await api("/api/background"));
  } catch {
    if (!silent) toast("读取后台任务失败", true);
  }
}

function bgElapsed(startedAt) {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function renderBackground(data) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const running = tasks.filter((t) => t.running).length;
  const badge = $("#bg-count");
  badge.textContent = String(running);
  badge.classList.toggle("hidden", running === 0);

  // Tasks seen running last poll and gone now (not killed) finished on their own.
  const nowRunning = new Set(tasks.filter((t) => t.running).map((t) => t.id));
  for (const t of tasks) {
    if (!t.running && bgPrevRunning.has(t.id) && !t.killed) {
      const failed = typeof t.exitCode === "number" && t.exitCode !== 0;
      notifyUser(failed ? "后台任务失败" : "后台任务结束", String(t.command || "").slice(0, 140));
    }
  }
  bgPrevRunning = nowRunning;

  const list = $("#bg-list");
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  if (!tasks.length) {
    list.appendChild(
      el("div", "bg-empty", "暂无后台任务。模型用 bash run_in_background 启动的进程会显示在这里。"),
    );
    return;
  }
  for (const t of tasks) {
    const row = el("div", "bg-row");
    const main = el("div", "bg-main");
    main.appendChild(el("div", "bg-cmd", t.command));
    const meta = el("div", "bg-meta");
    const stateText = t.running
      ? `运行中 · ${bgElapsed(t.startedAt)}`
      : `已结束${typeof t.exitCode === "number" ? ` · exit ${t.exitCode}` : ""}${t.killed ? " · 已终止" : ""}`;
    meta.appendChild(el("span", "bg-state " + (t.running ? "running" : t.killed ? "killed" : "done"), stateText));
    meta.appendChild(el("span", "bg-id", t.id));
    main.appendChild(meta);
    row.appendChild(main);
    if (t.running) {
      const kill = el("button", "link-btn danger", "终止");
      kill.type = "button";
      kill.onclick = async () => {
        kill.disabled = true;
        const r = await api("/api/background/kill", { id: t.id });
        if (r.error) toast("终止失败: " + r.error, true);
        loadBackground(true);
      };
      row.appendChild(kill);
    }
    list.appendChild(row);
  }
  list.scrollTop = scrollTop;
}

function setBackgroundOpen(open) {
  $("#background-pop").classList.toggle("hidden", !open);
  $("#background-btn").setAttribute("aria-expanded", String(open));
  clearInterval(bgTimer);
  bgTimer = null;
  if (open) {
    setTodosOpen(false);
    loadBackground(true);
    bgTimer = setInterval(() => loadBackground(true), 3000);
  }
}

$("#background-btn").onclick = (e) => {
  e.stopPropagation();
  setBackgroundOpen($("#background-pop").classList.contains("hidden"));
};
$("#bg-close").onclick = () => setBackgroundOpen(false);

/* ---------------- conversation find ---------------- */

/* Ctrl+F search over the transcript. Matching is per top-level transcript
   block (a message, a thinking card, or a whole tool group) — text-level
   highlighting inside rendered Markdown DOM is not worth the fragility, so
   hits get an outline and Enter/Shift+Enter walk through them. */

const findBar = $("#find-bar");
const findInput = $("#find-input");
const findCount = $("#find-count");
let findHits = [];
let findIndex = -1;

function clearFind() {
  for (const node of transcriptEl.querySelectorAll(".find-hit, .find-current")) {
    node.classList.remove("find-hit", "find-current");
  }
  findHits = [];
  findIndex = -1;
  findCount.textContent = "";
}

function runFind() {
  clearFind();
  const q = findInput.value.trim().toLowerCase();
  if (!q) return;
  for (const node of transcriptEl.children) {
    if ((node.textContent || "").toLowerCase().includes(q)) {
      node.classList.add("find-hit");
      findHits.push(node);
    }
  }
  updateFindCount();
  if (findHits.length) gotoFind(0);
}

function updateFindCount() {
  findCount.textContent = findHits.length ? `${findIndex + 1} / ${findHits.length}` : "无结果";
}

function gotoFind(i) {
  if (!findHits.length) return;
  if (findIndex >= 0 && findHits[findIndex]) findHits[findIndex].classList.remove("find-current");
  findIndex = ((i % findHits.length) + findHits.length) % findHits.length;
  const node = findHits[findIndex];
  node.classList.add("find-current");
  updateFindCount();
  // Detaching via a real scroll event is fine: scrollIntoView lands away from
  // the bottom, so the scroll handler flips follow.on on its own.
  node.scrollIntoView({ block: "center" });
}

function setFindOpen(open) {
  findBar.classList.toggle("hidden", !open);
  if (open) {
    findInput.focus();
    findInput.select();
    runFind();
  } else {
    clearFind();
  }
}

$("#find-close").onclick = () => setFindOpen(false);
$("#find-next").onclick = () => gotoFind(findIndex + 1);
$("#find-prev").onclick = () => gotoFind(findIndex - 1);
findInput.addEventListener("input", runFind);
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    gotoFind(e.shiftKey ? findIndex - 1 : findIndex + 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    setFindOpen(false);
    input.focus();
  }
});

/* ---------------- todos ---------------- */

function renderTodos() {
  const todos = state.todos;
  const done = todos.filter((t) => t.status === "completed").length;
  const open = todos.length - done;
  const badge = $("#todo-count");
  badge.textContent = String(open);
  badge.classList.toggle("hidden", open === 0);
  $("#todo-summary").textContent = todos.length ? `${done}/${todos.length} 已完成` : "";

  const list = $("#todo-list");
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  if (!todos.length) {
    list.appendChild(el("div", "bg-empty", "暂无待办。模型用 todo_write 制定的计划会显示在这里。"));
    return;
  }
  for (const t of todos) {
    const row = el("div", "todo-row " + t.status);
    row.appendChild(el("span", "todo-check", t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"));
    row.appendChild(el("span", "todo-text", t.content));
    list.appendChild(row);
  }
  list.scrollTop = scrollTop;
}

async function refreshTodos() {
  const seq = ++todoSyncSeq;
  const epoch = todoSyncEpoch;
  try {
    const s = await api("/api/state");
    // A newer todo refresh or a full state sync already applied its snapshot.
    if (seq !== todoSyncSeq || epoch !== todoSyncEpoch) return;
    state.todos = Array.isArray(s.todos) ? s.todos : [];
    renderTodos();
    updateStatus(s);
  } catch {
    /* transient failure — turn_end does a full refresh */
  }
}

function setTodosOpen(open) {
  renderTodos();
  $("#todo-pop").classList.toggle("hidden", !open);
  $("#todo-btn").setAttribute("aria-expanded", String(open));
  if (open) setBackgroundOpen(false);
}

$("#todo-btn").onclick = (e) => {
  e.stopPropagation();
  setTodosOpen($("#todo-pop").classList.contains("hidden"));
};
$("#todo-close").onclick = () => setTodosOpen(false);

document.addEventListener("click", (e) => {
  if (
    !$("#background-pop").classList.contains("hidden") &&
    !e.target.closest("#background-pop") &&
    !e.target.closest("#background-btn")
  ) {
    setBackgroundOpen(false);
  }
  if (
    !$("#todo-pop").classList.contains("hidden") &&
    !e.target.closest("#todo-pop") &&
    !e.target.closest("#todo-btn")
  ) {
    setTodosOpen(false);
  }
});

/* ---------------- global keys ---------------- */

document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (document.querySelector(".modal:not(.hidden)")) return; // the open dialog owns keys
    hidePalette();
    setSidebarOpen(true); // no-op on wide screens where the sidebar is always visible
    sessionSearch.focus();
    sessionSearch.select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    if (document.querySelector(".modal:not(.hidden)")) return;
    openCommandCenter();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    if (document.querySelector(".modal:not(.hidden)")) return;
    setFindOpen(true);
    return;
  }
  if (
    e.key === "?" &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !isTypingTarget(e.target) &&
    !document.querySelector(".modal:not(.hidden)")
  ) {
    e.preventDefault();
    openHelp();
    return;
  }
  if (!$("#perm-modal").classList.contains("hidden")) {
    const k = e.key.toLowerCase();
    const map = { y: "yes", s: "session", p: "project", a: "always", n: "no", d: "always_deny" };
    if (map[k]) {
      e.preventDefault();
      answerPermission(map[k]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      answerPermission("yes");
    }
  } else if (!$("#input-modal").classList.contains("hidden")) {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      $(e.key === "Escape" ? "#input-cancel" : "#input-ok").click();
    }
  } else if (e.key === "Escape" && !$("#help-modal").classList.contains("hidden")) {
    e.preventDefault();
    closeHelp();
  } else if (e.key === "Escape" && !$("#background-pop").classList.contains("hidden")) {
    e.preventDefault();
    setBackgroundOpen(false);
  } else if (e.key === "Escape" && !$("#todo-pop").classList.contains("hidden")) {
    e.preventDefault();
    setTodosOpen(false);
  } else if (e.key === "Escape" && !findBar.classList.contains("hidden")) {
    e.preventDefault();
    setFindOpen(false);
  } else if (e.key === "Escape" && !$("#usage-modal").classList.contains("hidden")) {
    e.preventDefault();
    $("#usage-modal").classList.add("hidden");
  } else if (e.key === "Escape" && !$("#manage-modal").classList.contains("hidden")) {
    e.preventDefault();
    if (!$("#mcp-editor").classList.contains("hidden") || !$("#perm-editor").classList.contains("hidden")) {
      $("#mcp-editor").classList.add("hidden");
      $("#perm-editor").classList.add("hidden");
      mcpEditing = null;
    } else {
      $("#manage-modal").classList.add("hidden");
    }
  } else if (e.key === "Escape" && sidebarEl.classList.contains("open")) {
    e.preventDefault();
    setSidebarOpen(false);
  } else if (e.key === "Escape") {
    closePops();
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
  loadBackground(true);
  // Poll even when hidden so unfocused windows learn about task completion.
  setInterval(() => loadBackground(true), 10_000);
})();
