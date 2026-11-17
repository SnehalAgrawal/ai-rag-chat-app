// The page: collections and documents on the left, the conversation on the right.
// Document text is only ever inserted as text (textContent), never as HTML.

const $ = (selector) => document.querySelector(selector);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
};

const state = { collection: null, histories: new Map(), documentTexts: new Map(), busy: false };

const remember = {
  get: () => {
    try {
      return localStorage.getItem("collection");
    } catch {
      return null;
    }
  },
  set: (value) => {
    try {
      localStorage.setItem("collection", value);
    } catch {
      // private mode: not remembered
    }
  },
};

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}
const collectionPath = (name) => `/api/collections/${encodeURIComponent(name)}`;

// --- Status, collections, documents ------------------------------------------------

async function loadStatus() {
  try {
    const s = await api("/api/status");
    $("#models").textContent = `Answers: ${s.llm} · reranker: ${s.reranker ?? "none"} · embeddings: ${s.embeddings}`;
  } catch (error) {
    $("#models").textContent = `Server not reachable: ${error.message}`;
  }
}

async function loadCollections(select) {
  const collections = await api("/api/collections");
  const picker = $("#collection");
  picker.replaceChildren(...collections.map((c) => el("option", { value: c.name, textContent: `${c.name} (${c.documents})` })));
  const wanted = select ?? state.collection ?? remember.get();
  const chosen = collections.find((c) => c.name === wanted)?.name ?? collections[0]?.name ?? null;
  if (!chosen) {
    $("#new-collection-form").hidden = false;
    $("#new-collection-name").focus();
  }
  if (chosen) picker.value = chosen;
  await selectCollection(chosen);
}

async function selectCollection(name) {
  state.collection = name;
  if (name) remember.set(name);
  renderThread();
  await loadDocuments();
}

async function loadDocuments() {
  const list = $("#documents");
  if (!state.collection) {
    list.replaceChildren(el("li", { className: "muted", textContent: "Create a collection first." }));
    updateEmpty();
    return;
  }
  const documents = await api(`${collectionPath(state.collection)}/documents`);
  list.replaceChildren(
    ...documents.map((d) =>
      el(
        "li",
        {},
        el("span", { className: "name", textContent: d.name, title: `${d.chunks} chunks, added ${new Date(d.added_at).toLocaleString()}` }),
        el("button", { type: "button", className: "secondary", textContent: "Remove", ariaLabel: `Remove ${d.name}`, onclick: () => removeDocument(d.name) }),
      ),
    ),
  );
  if (!documents.length) list.append(el("li", { className: "muted", textContent: "No documents yet." }));
  state.documentCount = documents.length;
  updateEmpty();
}

async function uploadFiles(files) {
  if (!state.collection || !files.length) return;
  const status = $("#upload-status");
  for (const file of files) {
    status.textContent = `Adding ${file.name}…`;
    try {
      const result = await api(`${collectionPath(state.collection)}/documents/${encodeURIComponent(file.name)}`, { method: "PUT", body: file });
      status.textContent = `${file.name}: ${result.outcome}, ${result.chunks} chunks.`;
    } catch (error) {
      status.textContent = `${file.name}: ${error.message}`;
    }
    state.documentTexts.delete(`${state.collection}/${file.name}`);
  }
  await loadCollections(state.collection);
}

async function removeDocument(name) {
  if (!confirm(`Remove ${name} from ${state.collection}?`)) return;
  try {
    await api(`${collectionPath(state.collection)}/documents/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.documentTexts.delete(`${state.collection}/${name}`);
    $("#upload-status").textContent = `Removed ${name}.`;
  } catch (error) {
    $("#upload-status").textContent = error.message;
  }
  await loadCollections(state.collection);
}

// --- The conversation -----------------------------------------------------------------

const history = () => {
  if (!state.histories.has(state.collection)) state.histories.set(state.collection, []);
  return state.histories.get(state.collection);
};

function renderThread() {
  const thread = $("#thread");
  thread.replaceChildren();
  for (const turn of history()) thread.append(turn.node);
  updateEmpty();
}

function updateEmpty() {
  $("#empty").hidden = history().length > 0;
}

async function ask(question) {
  if (state.busy || !state.collection) return;
  state.busy = true;
  $("#send").disabled = true;
  const previous = history().map(({ role, content }) => ({ role, content }));
  const userNode = el("li", { className: "turn-user", textContent: question });
  const stage = el("p", { className: "stage", textContent: "Searching your documents…" });
  const assistantNode = el("li", { className: "turn-assistant" }, stage);
  history().push({ role: "user", content: question, node: userNode });
  $("#thread").append(userNode, assistantNode);
  updateEmpty();
  assistantNode.scrollIntoView({ block: "end" });

  let content = "";
  try {
    const response = await fetch(`${collectionPath(state.collection)}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, history: previous }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
    for await (const event of ndjson(response)) {
      if (event.type === "stage") stage.textContent = stageText(event, question);
      else if (event.type === "error") throw new Error(event.error);
      else if (event.type === "answer") {
        assistantNode.replaceChildren(...renderAnswer(event, question));
        content = event.status === "not-found" ? "I couldn't find that in the documents." : event.answer;
      }
    }
  } catch (error) {
    assistantNode.replaceChildren(el("p", { className: "warning", textContent: `Something went wrong: ${error.message}` }));
    content = "";
  } finally {
    history().push({ role: "assistant", content, node: assistantNode });
    state.busy = false;
    $("#send").disabled = false;
    assistantNode.scrollIntoView({ block: "nearest" });
  }
}

async function* ndjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
    if (done) break;
  }
}

function stageText(event, question) {
  if (event.stage === "rewriting") return "Reading the conversation…";
  if (event.stage === "retrieving") return event.question && event.question !== question ? `Searching for: ${event.question}` : "Searching your documents…";
  if (event.stage === "retrieved") return `Reading ${event.retrieved.length} excerpt${event.retrieved.length === 1 ? "" : "s"}…`;
  if (event.stage === "answering") return "Answering…";
  return "";
}

function renderAnswer(answer, asked) {
  const parts = [];
  if (answer.status === "not-found") {
    parts.push(el("p", { className: "notice", textContent: answer.declinedBy === "gate" ? "No passage in these documents is relevant enough to answer from." : "I couldn't find this in your documents." }));
  } else {
    parts.push(el("p", { className: "answer", textContent: answer.answer }));
    if (answer.status === "uncited") parts.push(el("p", { className: "warning", textContent: "This answer didn't cite a passage that could be checked. Treat it with care." }));
    if (answer.citations.length) {
      parts.push(
        el(
          "ul",
          { className: "citations", ariaLabel: "Sources" },
          ...answer.citations.map((c) =>
            el("li", {}, el("button", { type: "button", className: "cite", textContent: `[${c.number}] ${c.document}`, title: `Open the passage (${c.label})`, onclick: () => openPassage(c) })),
          ),
        ),
      );
    }
  }
  parts.push(whyThisAnswer(answer, asked));
  return parts;
}

function whyThisAnswer(answer, asked) {
  const cited = new Set(answer.citations.map((c) => c.number));
  const score = (c) => [c.rerankScore !== undefined ? `reranker ${c.rerankScore.toFixed(2)}` : null, c.vectorScore !== undefined ? `similarity ${c.vectorScore.toFixed(3)}` : null].filter(Boolean).join(" · ");
  const t = answer.timings ?? {};
  const ms = (v) => (v === undefined ? null : `${Math.round(v)} ms`);
  const timing = [
    t.rewriteMs > 1 ? `rewrite ${ms(t.rewriteMs)}` : null,
    `embed ${ms(t.embedMs)}`,
    t.rerankMs !== undefined ? `rerank ${ms(t.rerankMs)}` : null,
    t.answerMs !== undefined ? `answer ${ms(t.answerMs)}` : null,
  ].filter(Boolean).join(" · ");
  return el(
    "details",
    { className: "why" },
    el("summary", { textContent: "Why this answer" }),
    // Only when the follow-up was rewritten into a different question.
    answer.question && answer.question !== asked ? el("p", {}, "Searched for: ", el("em", { textContent: answer.question })) : null,
    el(
      "ol",
      {},
      ...answer.retrieved.map((c) =>
        el(
          "li",
          {},
          el("button", { type: "button", className: "cite", textContent: `[${c.number}] ${c.document}${cited.has(c.number) ? " · cited" : ""}`, onclick: () => openPassage(c) }),
          " ",
          el("span", { className: "excerpt-meta", textContent: `${c.label} · ${c.tokens} tokens · ${score(c)}` }),
        ),
      ),
    ),
    el("p", { className: "excerpt-meta", textContent: `${timing} · prompt ${answer.promptVersion}${answer.declinedBy ? ` · declined by the ${answer.declinedBy}` : ""}` }),
  );
}

// --- The passage viewer ---------------------------------------------------------------

async function openPassage({ document: name, start, end }) {
  const dialog = $("#viewer");
  const pre = $("#viewer-text");
  $("#viewer-title").textContent = name;
  pre.textContent = "Loading…";
  dialog.showModal();
  const key = `${state.collection}/${name}`;
  try {
    if (!state.documentTexts.has(key)) {
      state.documentTexts.set(key, (await api(`${collectionPath(state.collection)}/documents/${encodeURIComponent(name)}`)).text);
    }
    const text = state.documentTexts.get(key);
    const mark = el("mark", { textContent: text.slice(start, end) });
    pre.replaceChildren(text.slice(0, start), mark, text.slice(end));
    mark.scrollIntoView({ block: "center" });
  } catch (error) {
    pre.textContent = `Couldn't open ${name}: ${error.message}`;
  }
}

// --- Wiring -----------------------------------------------------------------------------

$("#collection").addEventListener("change", (e) => selectCollection(e.target.value));
$("#new-collection").addEventListener("click", () => {
  const form = $("#new-collection-form");
  form.hidden = !form.hidden;
  if (!form.hidden) $("#new-collection-name").focus();
});
$("#new-collection-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#new-collection-name").value.trim();
  try {
    await api("/api/collections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    $("#new-collection-form").hidden = true;
    $("#new-collection-name").value = "";
    await loadCollections(name);
  } catch (error) {
    $("#upload-status").textContent = error.message;
  }
});
$("#files").addEventListener("change", (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
});
const dropzone = $("#dropzone");
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("over");
  uploadFiles([...e.dataTransfer.files]);
});
$("#ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const question = $("#question").value.trim();
  if (!question) return;
  $("#question").value = "";
  ask(question);
});
$("#question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#ask").requestSubmit();
  }
});
$("#new-chat").addEventListener("click", () => {
  state.histories.set(state.collection, []);
  renderThread();
});
$("#viewer-close").addEventListener("click", () => $("#viewer").close());

loadStatus();
loadCollections();
