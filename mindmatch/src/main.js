import "./style.css";
import { packs, defaultPacks, questions } from "./questions";
import { configured, rpc, subscribe } from "./backend";
import { demoCreate, demoAct } from "./demo";
const app = document.querySelector("#app"),
  head = document.querySelector("#header-actions"),
  modal = document.querySelector("#modal");
const safeStore = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};
let room = null,
  demo = false,
  judgeView = false,
  busy = false,
  error = "",
  status = "syncing",
  stop = null,
  poll = null,
  refreshing = false,
  settings = { rounds: 5, packs: [...defaultPacks] },
  name = safeStore.get("mm-name") || "",
  code = new URLSearchParams(location.search).get("room") || "",
  draft = { own: "", guess: "" },
  viewKey = "",
  installPrompt;
const e = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const btn = (label, action, cls = "primary", extra = "") =>
  `<button class="${cls}" data-action="${action}" ${extra} ${busy ? "disabled" : ""}>${label}</button>`;
const isHost = () => room?.me === room?.host;
const isJudge = () => (demo ? judgeView : room?.me === room?.moderator);
const isPlayer = (p) => room.dualRole || !p.isModerator;
const pname = (id) => room.players.find((p) => p.id === id)?.name || "Player";
function toast(text) {
  const el = document.querySelector("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3500);
}
function rounds(value) {
  return `<div class="rounds" role="group" aria-label="Number of rounds">${[3, 5, 8, 10, 15, 20].map((n) => btn(String(n), "round", " " + (n === value ? "selected" : ""), `data-value="${n}" aria-pressed="${n === value}"`)).join("")}</div>`;
}
function packSummary() {
  const p = room ? room.packs : settings.packs;
  return `<div class="pack-summary"><span>${p.length} question packs <span class="subtle">· ${questions.filter((q) => p.includes(q.pack)).length} questions</span></span>${btn("Choose", "packs", "link")}</div>`;
}
function people() {
  return `<aside><h2>${room.stage === "lobby" ? "In the room" : "Players"}</h2><div class="people">${room.players.map((p) => `<div class="person"><span class="avatar" aria-hidden="true">${e(p.name[0]?.toUpperCase())}</span><div><div class="name">${e(p.name)}${p.id === room.me ? ' <span class="subtle">(you)</span>' : ""}</div><div class="meta">${p.isModerator ? (room.dualRole ? "Host · player · moderator" : "Moderator") : p.isHost ? "Host · player" : "Player"}${!p.online ? " · away" : ""}</div></div><div class="right">${room.stage === "lobby" ? "" : !isPlayer(p) ? "" : room.stage === "answering" ? (p.submitted ? "Submitted" : "Thinking…") : `<span class="points">${p.score}</span>`}</div></div>`).join("")}</div></aside>`;
}
function saveDraft() {
  if (!room) return;
  try {
    sessionStorage.setItem(
      `mm-draft-${room.id}-${room.round}`,
      JSON.stringify(draft),
    );
  } catch {}
}
function accept(next) {
  if (!next) return;
  if (room && next.id === room.id && next.revision < room.revision) return;
  const k = `${next.id}-${next.round}`;
  if (k !== viewKey) {
    viewKey = k;
    draft = { own: "", guess: "" };
    try {
      draft = JSON.parse(sessionStorage.getItem("mm-draft-" + k)) || draft;
    } catch {}
    judgeView = false;
  }
  room = next;
  if (next.answers.some((a) => a.uid === next.me)) {
    try {
      sessionStorage.removeItem("mm-draft-" + k);
    } catch {}
    draft = { own: "", guess: "" };
  }
  render();
}
function render() {
  const active = document.activeElement?.id,
    selection = document.activeElement?.selectionStart;
  head.innerHTML = `${room ? `<span class="status ${status === "live" && !demo ? "live" : ""}">${demo ? "Demo" : status === "live" ? "Connected" : status === "offline" ? "Offline" : "Reconnecting"}</span>` : ""}${btn("Help", "help", "link")}`;
  const network = document.querySelector("#network");
  network.hidden = navigator.onLine && status !== "offline";
  network.textContent =
    "Connection lost. Your answers are kept on this device. Reconnecting…";
  if (!room) {
    app.innerHTML = `<h1 class="home-title">How well do you<br>know your people?</h1><div class="home-grid"><section class="sheet"><span class="section-number">01 / HOST</span><h2>Start a session</h2><form id="create-form"><div class="field"><label for="host-name">Your name</label><input id="host-name" name="name" autocomplete="given-name" maxlength="24" required value="${e(name)}" placeholder="Name"></div><div class="field"><label>Rounds</label>${rounds(settings.rounds)}</div>${packSummary()}<button class="primary wide" ${busy ? "disabled" : ""}>${busy ? "Connecting…" : "Create room"}</button></form></section><section class="join-panel"><span class="section-number">02 / JOIN</span><h2>Join your friends</h2><form id="join-form"><div class="field"><label for="join-name">Your name</label><input id="join-name" autocomplete="given-name" maxlength="24" value="${e(name)}" placeholder="Name" required></div><div class="field"><label for="code">Room code</label><input id="code" class="join-code" maxlength="8" value="${e(code)}" required pattern="[A-Fa-f0-9]{8}" placeholder="8-character code" autocapitalize="characters" spellcheck="false" autocomplete="off"></div><button class="secondary wide" ${busy ? "disabled" : ""}>Join room</button></form><div class="demo-link">${btn("Try a demo", "demo", "link")}<span class="subtle">No setup</span></div></section></div>${error ? `<p role="alert" class="error">${e(error)}</p>` : ""}`;
  } else {
    let content = "";
    const heading =
      room.stage === "lobby"
        ? "Your room"
        : room.stage === "finished"
          ? "Final scores"
          : room.stage === "closed"
            ? "Session ended"
            : `Round ${room.round} <span class="subtle">/ ${room.rounds}</span>`;
    if (room.stage === "lobby") {
      content = `<section class="sheet"><h2>Session</h2><div class="lobby-settings"><div class="field"><label for="moderator">Moderator</label><select id="moderator" ${!isHost() || demo || busy || room.players.length === 2 ? "disabled" : ""}><option value="">Choose a friend</option>${room.players.map((p) => `<option value="${e(p.id)}" ${p.id === (room.players.length === 2 ? room.host : room.moderator) ? "selected" : ""}>${e(p.name)}</option>`).join("")}</select></div><div class="field"><label>Rounds</label>${isHost() ? rounds(room.rounds) : `<p>${room.rounds}</p>`}</div></div><div class="spaced">${isHost() ? packSummary() : `<p class="subtle">${room.packs.length} question packs</p>`}</div>${isHost() ? btn("Start game", "start", "primary wide", room.players.length === 2 || (room.players.filter(isPlayer).length >= 2 && room.moderator) ? "" : "disabled") : '<p class="subtle">Waiting for the host to start.</p>'}${room.players.length === 2 ? '<p class="subtle spaced">Both people play. The host also moderates after both answers are submitted.</p>' : room.players.length < 2 ? '<p class="subtle spaced">Waiting for another player.</p>' : ""}</section>`;
    }
    if (["answering", "judging"].includes(room.stage)) {
      content = `<section class="question-card"><div class="question-meta">${e(packs[room.question.pack]?.name || "Question")}</div><h1>${e(room.question.text)}</h1></section>`;
      const mine = room.answers.find((a) => a.uid === room.me);
      if (room.stage === "answering" && (room.dualRole || !isJudge()) && !mine) {
        content += `<form id="answer-form"><div class="answer-grid"><div class="field"><label for="own">Your first thought</label><textarea id="own" maxlength="180" required>${e(draft.own)}</textarea></div><div class="field"><label for="guess">What would ${e(pname(room.target))} say?</label><textarea id="guess" maxlength="180" required>${e(draft.guess)}</textarea></div></div><button class="primary wide" ${busy ? "disabled" : ""}>${busy ? "Submitting…" : "Submit answers"}</button></form>`;
      } else if (room.stage === "judging" && isJudge()) {
        content += room.players
          .filter(isPlayer)
          .map((p) => {
            const a = room.answers.find((a) => a.uid === p.id),
              actual = room.answers.find((x) => x.uid === a.target);
            return `<section class="answer-review"><div class="row"><h3>${e(p.name)}’s guess</h3><span class="subtle">about ${e(pname(a.target))}</span></div><div class="comparison"><div><label>Guess</label>${e(a.guess)}</div><div><label>${e(pname(a.target))}’s answer</label>${e(actual?.own)}</div></div><div class="score-buttons" role="group" aria-label="Score ${e(p.name)}">${["0 · No match", "1 · Close", "2 · Match"].map((label, n) => btn(label, "score", a.points === n ? "selected" : "", `data-id="${e(p.id)}" data-points="${n}" aria-pressed="${a.points === n}"`)).join("")}</div></section>`;
          })
          .join("");
        content += btn(
          "Reveal scores",
          "publish",
          "primary wide spaced",
          room.answers.some((a) => a.points === null) ? "disabled" : "",
        );
      } else {
        content += `<section class="empty"><h2>${room.stage === "judging" ? "With the moderator" : isJudge() ? "Waiting for answers" : "Answers submitted"}</h2><p class="subtle">${room.stage === "judging" ? `${e(pname(room.moderator))} is scoring this round.` : `${room.players.filter((p) => p.submitted).length} of ${room.players.filter(isPlayer).length} players submitted.`}</p>${demo && room.stage === "judging" ? btn("Open moderator view", "judge", "secondary spaced") : ""}</section>`;
      }
    }
    if (room.stage === "reveal") {
      content = `<h1>Round scores</h1>${room.players
        .filter(isPlayer)
        .map((p) => {
          const a = room.answers.find((a) => a.uid === p.id),
            actual = room.answers.find((x) => x.uid === a.target);
          return `<section class="answer-review"><div class="row"><h3>${e(p.name)}</h3><span class="score-line">+${a.points} ${a.points === 1 ? "point" : "points"}</span></div><div class="comparison"><div><label>Guessed ${e(pname(a.target))}</label>${e(a.guess)}</div><div><label>Actual answer</label>${e(actual?.own)}</div></div></section>`;
        })
        .join("")}`;
      content +=
        isHost() || isJudge()
          ? btn(
              room.round === room.rounds ? "Final scores" : "Next round",
              "next",
              "primary wide spaced",
            )
          : '<p class="subtle spaced">Waiting for the next round.</p>';
    }
    if (room.stage === "finished") {
      const players = room.players
          .filter(isPlayer)
          .sort((a, b) => b.score - a.score),
        winners = players.filter((p) => p.score === players[0].score);
      content = `<section class="winner"><span class="section-number">${winners.length > 1 ? "JOINT WINNERS" : "WINNER"}</span><h1>${winners.map((p) => e(p.name)).join(" & ")}</h1><div class="score">${players[0].score} <small>points</small></div></section><section class="standings">${players.map((p, i) => `<div class="person"><span class="subtle">${players.findIndex((x) => x.score === p.score) + 1}.</span><div class="name">${e(p.name)}</div><span class="right points">${p.score}</span></div>`).join("")}</section>${isHost() ? btn("Play again", "restart", "primary wide") : ""}`;
    }
    if (room.stage === "closed")
      content = `<div class="empty">${btn("Back to start", "exit")}</div>`;
    app.innerHTML = `<div class="room-heading"><h1>${heading}</h1><div class="row"><span class="room-code">${e(room.code)}</span>${room.stage === "lobby" && !demo ? btn("Copy invite", "invite", "link") : ""}${btn("Exit", "exit", "link")}</div></div><div class="room-grid"><div>${content}${error ? `<p role="alert" class="error">${e(error)}</p>` : ""}</div>${people()}</div>`;
  }
  if (active) {
    const el = document.getElementById(active);
    if (el) {
      el.focus({ preventScroll: true });
      if (typeof selection === "number" && el.setSelectionRange)
        try {
          el.setSelectionRange(selection, selection);
        } catch {}
    }
  }
}
async function run(fn) {
  if (busy) return;
  busy = true;
  error = "";
  render();
  try {
    await fn();
  } catch (err) {
    error = err.message || "Could not connect. Please try again.";
    if (!navigator.onLine) status = "offline";
  } finally {
    busy = false;
    render();
  }
}
async function act(action, payload = {}) {
  if (demo) {
    accept(demoAct(action, payload));
    return;
  }
  accept(
    await rpc("mm_action", {
      p_room: room.id,
      p_action: action,
      p_round: room.round,
      p_payload: payload,
    }),
  );
}
async function refresh() {
  if (!room || demo || refreshing || busy || document.hidden) return;
  refreshing = true;
  const id = room.id;
  try {
    const next = await rpc("mm_state", { p_room: id });
    if (room?.id === id) {
      status = "live";
      error = "";
      if (JSON.stringify(next) !== JSON.stringify(room)) accept(next);
      else renderStatus();
    }
  } catch (err) {
    if (room?.id === id) {
      status = "offline";
      error = err.message;
      renderStatus();
    }
  } finally {
    refreshing = false;
  }
}
function renderStatus() {
  head.querySelector(".status")?.classList.toggle("live", status === "live");
  const el = head.querySelector(".status");
  if (el) el.textContent = status === "live" ? "Connected" : "Reconnecting";
  const n = document.querySelector("#network");
  n.hidden = status === "live" && navigator.onLine;
  n.textContent =
    "Connection lost. Your answers are kept on this device. Reconnecting…";
}
function connect(next) {
  stop?.();
  clearInterval(poll);
  safeStore.set("mm-room", next.id);
  status = "live";
  accept(next);
  stop = subscribe(
    next.id,
    () => refresh(),
    (s) => {
      if (s === "live") {
        status = "live";
        refresh();
      } else {
        status = "syncing";
      }
      renderStatus();
    },
  );
  poll = setInterval(refresh, 5000);
}
function exit() {
  stop?.();
  stop = null;
  clearInterval(poll);
  room = null;
  demo = false;
  judgeView = false;
  error = "";
  safeStore.remove("mm-room");
  history.replaceState(null, "", location.pathname);
  render();
}
function openDialog(html) {
  modal.innerHTML = html;
  modal.showModal();
}
function packDialog() {
  const selected = room ? room.packs : settings.packs;
  openDialog(
    `<div class="row"><h2>Question packs</h2>${btn("Close", "close", "link")}</div><div class="checks">${Object.entries(
      packs,
    )
      .map(
        ([id, p]) =>
          `<label class="check"><input type="checkbox" name="pack" value="${id}" ${selected.includes(id) ? "checked" : ""}>${e(p.name)} <span class="subtle">20</span></label>`,
      )
      .join(
        "",
      )}</div><p class="subtle">Questions are shuffled, without repeats in a session.</p>${btn("Save selection", "save-packs", "primary wide")}`,
  );
}
function help() {
  openDialog(
    `<div class="row"><h2>Mindmatch</h2>${btn("Close", "close", "link")}</div><div class="help-text"><p>With two people, both play and the host also moderates after both submit. With three to nine people, choose a separate moderator; the others play.</p><p>Write your first thought, then guess the named friend’s answer. In larger groups, your target changes each round.</p><p>The moderator gives each guess 0, 1, or 2 points. Highest total wins; equal totals share the win.</p><p><strong>Install</strong><br>iPhone: open in Safari, then Share → Add to Home Screen.<br>Android: use your browser’s Install app or Add to Home screen option.</p><p>Online play needs a connection. Keep the same browser to resume your room; rooms expire after 24 hours. If someone is away, wait for them or end the session and create another.</p>${demo ? "<p>This demo uses simulated answers.</p>" : ""}${!configured ? "<p>Online setup is not configured. Follow SETUP.md in the source package, or try the demo.</p>" : ""}</div>${installPrompt ? btn("Install app", "install", "secondary wide") : ""}${room && isHost() && !demo ? btn("End session", "end", "secondary wide spaced") : ""}${
      room?.stage === "lobby" && isHost() && !demo
        ? `<details><summary>Remove a player</summary><div class="stack">${room.players
            .filter((p) => p.id !== room.me)
            .map((p) =>
              btn(
                `Remove ${e(p.name)}`,
                "remove",
                "secondary",
                `data-id="${e(p.id)}"`,
              ),
            )
            .join("")}</div></details>`
        : ""
    }`,
  );
}
document.addEventListener("input", (ev) => {
  const { id, value } = ev.target;
  if (id === "host-name" || id === "join-name") name = value;
  if (id === "code") code = value;
  if (id === "own" || id === "guess") {
    draft[id] = value;
    saveDraft();
  }
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "moderator")
    run(() => act("moderator", { id: ev.target.value }));
});
document.addEventListener("submit", (ev) => {
  if (!["create-form", "join-form", "answer-form"].includes(ev.target.id))
    return;
  ev.preventDefault();
  const form = ev.target;
  run(async () => {
    if (form.id === "answer-form") {
      if (!draft.own.trim() || !draft.guess.trim())
        throw Error("Enter both answers.");
      await act("submit", { ...draft });
      return;
    }
    if (!name.trim()) throw Error("Enter your name.");
    safeStore.set("mm-name", name.trim());
    const next =
      form.id === "create-form"
        ? await rpc("mm_create", {
            p_name: name.trim(),
            p_rounds: settings.rounds,
            p_packs: settings.packs,
          })
        : await rpc("mm_join", {
            p_code: code.trim().toUpperCase(),
            p_name: name.trim(),
          });
    demo = false;
    connect(next);
  });
});
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a === "close") {
    modal.close();
    return;
  }
  if (a === "help") {
    help();
    return;
  }
  if (a === "packs") {
    packDialog();
    return;
  }
  if (a === "demo") {
    stop?.();
    clearInterval(poll);
    demo = true;
    error = "";
    accept(
      demoCreate(name.trim() || "Farhan", settings.rounds, settings.packs),
    );
    return;
  }
  if (a === "judge") {
    judgeView = true;
    render();
    return;
  }
  if (a === "exit") {
    if (demo || room?.stage === "closed") {
      exit();
      return;
    }
    openDialog(
      `<h2>Exit this room?</h2><p class="help-text">The game stays open for your friends. You can rejoin with the same code in this browser.</p><div class="button-row">${btn("Exit", "confirm-exit")}${btn("Stay", "close", "secondary")}</div>`,
    );
    return;
  }
  if (a === "confirm-exit") {
    modal.close();
    exit();
    return;
  }
  if (a === "end") {
    openDialog(
      `<h2>End this session?</h2><p class="help-text">This ends the game for everyone.</p><div class="button-row">${btn("End session", "confirm-end")}${btn("Cancel", "close", "secondary")}</div>`,
    );
    return;
  }
  if (a === "invite") {
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("room", room.code);
    (navigator.clipboard
      ? navigator.clipboard.writeText(url.href)
      : Promise.reject()
    )
      .then(() => toast("Invite link copied"))
      .catch(() =>
        openDialog(
          `<h2>Invite link</h2><input readonly value="${e(url.href)}" onclick="this.select()">${btn("Close", "close", "link")}`,
        ),
      );
    return;
  }
  if (a === "install") {
    installPrompt?.prompt();
    installPrompt = null;
    modal.close();
    return;
  }
  run(async () => {
    if (a === "round") {
      const n = Number(el.dataset.value);
      if (room) await act("settings", { rounds: n, packs: room.packs });
      else settings.rounds = n;
      return;
    }
    if (a === "save-packs") {
      const selected = [...modal.querySelectorAll("input:checked")].map(
        (x) => x.value,
      );
      if (!selected.length) {
        toast("Choose at least one pack.");
        return;
      }
      if (room) await act("settings", { rounds: room.rounds, packs: selected });
      else settings.packs = selected;
      modal.close();
      return;
    }
    if (a === "score")
      return act("score", {
        id: el.dataset.id,
        points: Number(el.dataset.points),
      });
    if (a === "remove") {
      await act("remove", { id: el.dataset.id });
      modal.close();
      return;
    }
    if (a === "confirm-end") {
      await act("end");
      modal.close();
      return;
    }
    if (["start", "publish", "next", "restart"].includes(a)) {
      await act(a);
      window.scrollTo(0, 0);
    }
  });
});
window.addEventListener("online", () => {
  status = "syncing";
  refresh();
});
window.addEventListener("offline", () => {
  status = "offline";
  renderStatus();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
window.addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault();
  installPrompt = ev;
});
if ("serviceWorker" in navigator && import.meta.env.PROD)
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}),
  );
render();
const previous = safeStore.get("mm-room");
if (previous && configured && !code)
  run(async () => {
    try {
      connect(await rpc("mm_state", { p_room: previous }));
    } catch (err) {
      safeStore.remove("mm-room");
      throw err;
    }
  });
