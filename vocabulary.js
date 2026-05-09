const state = {
  entries: [],
  filteredEntries: []
};

const elements = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindEvents();
  await loadEntries();
});

function bindElements() {
  elements.count = document.getElementById("vocab-count");
  elements.searchInput = document.getElementById("search-input");
  elements.languageFilter = document.getElementById("language-filter");
  elements.sortOrder = document.getElementById("sort-order");
  elements.exportButton = document.getElementById("export-csv");
  elements.emptyState = document.getElementById("empty-state");
  elements.list = document.getElementById("vocab-list");
  elements.exportDialog = document.getElementById("export-dialog");
  elements.exportOptions = document.getElementById("export-options");
  elements.confirmExport = document.getElementById("confirm-export");
}

function bindEvents() {
  elements.searchInput.addEventListener("input", render);
  elements.languageFilter.addEventListener("change", render);
  elements.sortOrder.addEventListener("change", render);
  elements.exportButton.addEventListener("click", openExportDialog);
  elements.confirmExport.addEventListener("click", exportSelectedRange);
}

async function loadEntries() {
  const response = await sendRuntimeMessage({ type: "GET_ENTRIES" });
  state.entries = response?.ok && Array.isArray(response.entries) ? response.entries : [];
  renderLanguageFilter();
  render();
}

function renderLanguageFilter() {
  const languages = getStarredEntries()
    .map((entry) => entry.lang)
    .filter(Boolean)
    .filter((lang, index, list) => list.indexOf(lang) === index)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

  const currentValue = elements.languageFilter.value;
  elements.languageFilter.replaceChildren(createOption("", "全部语言"));

  for (const lang of languages) {
    elements.languageFilter.appendChild(createOption(lang, lang));
  }

  if (languages.includes(currentValue)) {
    elements.languageFilter.value = currentValue;
  }
}

function render() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase();
  const language = elements.languageFilter.value;
  const sortOrder = elements.sortOrder.value;

  state.filteredEntries = getStarredEntries()
    .filter((entry) => {
      const matchesQuery = !query ||
        entry.word.toLocaleLowerCase().includes(query) ||
        entry.meaning.toLocaleLowerCase().includes(query);
      const matchesLanguage = !language || entry.lang === language;
      return matchesQuery && matchesLanguage;
    })
    .sort((a, b) => compareEntries(a, b, sortOrder));

  elements.count.textContent = `${getStarredEntries().length} 条生词`;
  elements.emptyState.hidden = state.filteredEntries.length > 0;
  elements.list.replaceChildren(...state.filteredEntries.map(createEntryNode));
}

function createEntryNode(entry) {
  const details = document.createElement("details");
  details.className = "vocab-item";

  const summary = document.createElement("summary");
  summary.className = "vocab-summary";

  const main = document.createElement("div");
  main.className = "vocab-main";

  const wordLine = document.createElement("div");
  wordLine.className = "word-line";

  const word = document.createElement("span");
  word.className = "word";
  word.textContent = entry.word;
  wordLine.appendChild(word);

  if (entry.translit) {
    const translit = document.createElement("span");
    translit.className = "translit";
    translit.textContent = entry.translit;
    wordLine.appendChild(translit);
  }

  const meaning = document.createElement("div");
  meaning.className = "meaning";
  meaning.textContent = entry.meaning || "暂无词义";

  const tag = document.createElement("span");
  tag.className = "lang-tag";
  tag.textContent = entry.lang || "未知语言";

  main.append(wordLine, meaning, tag);

  const actions = document.createElement("div");
  actions.className = "vocab-actions";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger-button";
  deleteButton.textContent = "🗑 删除";
  deleteButton.title = "从生词本移除";
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    unstarEntry(entry.id);
  });
  actions.appendChild(deleteButton);

  summary.append(main, actions);

  const body = document.createElement("div");
  body.className = "details-body";
  body.append(
    createDetailRow("完整词义", entry.meaning || "暂无"),
    createDetailRow("词源", entry.etymology || "暂无"),
    createDetailRow("句中作用", entry.form || "暂无"),
    createDetailRow("上下文", entry.context || "暂无")
  );

  details.append(summary, body);
  return details;
}

async function unstarEntry(id) {
  const response = await sendRuntimeMessage({
    type: "TOGGLE_STAR",
    id,
    starred: false
  });

  if (!response?.ok) {
    window.alert(response?.error?.message || "删除失败");
    return;
  }

  state.entries = state.entries.map((entry) => (
    entry.id === id ? { ...entry, starred: false } : entry
  ));
  renderLanguageFilter();
  render();
}

function openExportDialog() {
  const starredEntries = getStarredEntries();
  if (starredEntries.length === 0) {
    window.alert("生词本为空，暂无可导出的记录。");
    return;
  }

  const languages = starredEntries
    .map((entry) => entry.lang)
    .filter(Boolean)
    .filter((lang, index, list) => list.indexOf(lang) === index)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

  elements.exportOptions.replaceChildren(createRadioOption("", "全部生词", true));
  for (const lang of languages) {
    elements.exportOptions.appendChild(createRadioOption(lang, `仅${lang}`));
  }

  if (typeof elements.exportDialog.showModal === "function") {
    elements.exportDialog.showModal();
  } else {
    exportSelectedRange();
  }
}

function exportSelectedRange() {
  const selected = elements.exportOptions.querySelector("input[name='export-range']:checked");
  const language = selected?.value || "";
  const entries = getStarredEntries().filter((entry) => !language || entry.lang === language);

  if (entries.length === 0) {
    window.alert("当前范围没有可导出的生词。");
    return;
  }

  downloadCsv(entries);
  elements.exportDialog.close();
  window.alert(`CSV已导出。在Anki中导入步骤：
1. 打开Anki桌面版
2. 文件 → 导入 → 选择此CSV
3. Note Type 选"基础"，字段映射：第1列→正面，第2列→背面，第3列→标签
4. 点击导入即可`);
}

function downloadCsv(entries) {
  const lines = [
    "#separator:tab",
    "#html:true",
    ...entries.map((entry) => [
      sanitizeCsvField(createFrontHtml(entry)),
      sanitizeCsvField(createBackHtml(entry)),
      sanitizeCsvField(languageToTag(entry.lang))
    ].join("\t"))
  ];
  const blob = new Blob([lines.join("\n")], {
    type: "text/tab-separated-values;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vocabulary_${formatDate(new Date())}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function createFrontHtml(entry) {
  return `<div style="font-size:22px; line-height:1.6; padding:20px; text-align:center;">${highlightWord(entry.context, entry.word)}</div>`;
}

function createBackHtml(entry) {
  const highlightedContext = highlightWord(entry.context, entry.word);
  return `<div style="font-size:18px; line-height:1.8; padding:20px;">
  <div style="font-size:20px; text-align:center; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #ddd;">
    ${highlightedContext}
  </div>
  <div style="margin:8px 0;">📖 <b>${escapeHtml(entry.translit)}</b></div>
  <div style="margin:8px 0;">💡 ${escapeHtml(entry.meaning)}</div>
  <div style="margin:8px 0;">🌱 ${escapeHtml(entry.etymology)}</div>
  <div style="margin:8px 0;">📍 ${escapeHtml(entry.form)}</div>
</div>`;
}

function highlightWord(context, word) {
  const text = String(context || word || "");
  const target = String(word || "");
  const index = findTargetWordIndex(text, target);

  if (!target || index < 0) {
    return escapeHtml(text);
  }

  return [
    escapeHtml(text.slice(0, index)),
    `<b style="color:#d97706;">${escapeHtml(text.slice(index, index + target.length))}</b>`,
    escapeHtml(text.slice(index + target.length))
  ].join("");
}

function findTargetWordIndex(text, word) {
  if (!word) {
    return -1;
  }

  let index = text.indexOf(word);
  while (index >= 0) {
    const before = text[index - 1] || "";
    const after = text[index + word.length] || "";
    if (isWordBoundary(before) && isWordBoundary(after)) {
      return index;
    }
    index = text.indexOf(word, index + word.length);
  }

  return -1;
}

function isWordBoundary(char) {
  return !char || /[\s\u200c.,،，;؛:：!?؟۔。！？"'“”‘’«»《》（）()[\]{}<>]/u.test(char);
}

function createDetailRow(label, value) {
  const row = document.createElement("div");
  row.className = "detail-row";

  const labelNode = document.createElement("div");
  labelNode.className = "detail-label";
  labelNode.textContent = label;

  const valueNode = document.createElement("div");
  valueNode.className = "detail-value";
  valueNode.textContent = value;

  row.append(labelNode, valueNode);
  return row;
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function createRadioOption(value, label, checked = false) {
  const labelNode = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "export-range";
  input.value = value;
  input.checked = checked;
  labelNode.append(input, document.createTextNode(label));
  return labelNode;
}

function compareEntries(a, b, sortOrder) {
  if (sortOrder === "oldest") {
    return a.timestamp - b.timestamp;
  }

  if (sortOrder === "language") {
    return a.lang.localeCompare(b.lang, "zh-Hans-CN") || b.timestamp - a.timestamp;
  }

  return b.timestamp - a.timestamp;
}

function getStarredEntries() {
  return state.entries.filter((entry) => entry.starred);
}

function sanitizeCsvField(value) {
  return String(value ?? "")
    .replace(/\t/g, " ")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function languageToTag(lang) {
  const tags = {
    波斯语: "Persian",
    俄语: "Russian",
    阿拉伯语: "Arabic",
    土耳其语: "Turkish"
  };
  return tags[lang] || String(lang || "Unknown").trim().replace(/\s+/g, "_");
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}
