(function () {
  const CARD_ID = "mlwa-card-root";
  const CARD_WIDTH = 300;
  const MAX_SELECTED_WORDS = 2;
  const QUERY_DELAY_MS = 30;

  let activeRequestId = 0;
  let activeCard = null;
  let outsideClickHandler = null;
  let currentLookup = null;

  document.addEventListener("mouseup", handleMouseUp, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCard();
    }
  });

  function handleMouseUp(event) {
    if (activeCard?.contains(event.target)) {
      return;
    }

    window.setTimeout(() => {
      const selectionInfo = readSelection();
      if (!selectionInfo) {
        return;
      }

      const { word, sentence, rect } = selectionInfo;
      const requestId = ++activeRequestId;
      currentLookup = { word, sentence, id: null, starred: false };

      showLoadingCard(word, rect);

      sendRuntimeMessage({
        type: "LOOKUP_WORD",
        word,
        sentence,
        useCache: true
      })
        .then((response) => {
          if (requestId !== activeRequestId) {
            return;
          }

          if (!response?.ok) {
            showError(response?.error || { type: "unknown", message: "查询失败" }, word, rect);
            return;
          }

          currentLookup = {
            word,
            sentence,
            id: response.id || response.data?.id || null,
            starred: Boolean(response.data?.starred)
          };
          renderResult(response.data, {
            cached: Boolean(response.cached),
            rect
          });
        })
        .catch((error) => {
          if (requestId !== activeRequestId) {
            return;
          }

          showError(
            {
              type: "runtime_error",
              message: error.message || "扩展通信失败"
            },
            word,
            rect
          );
        });
    }, QUERY_DELAY_MS);
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const rawText = selection.toString();
    const word = cleanSelectedText(rawText);

    if (!word || getWordCount(word) > MAX_SELECTED_WORDS) {
      closeCard();
      return null;
    }

    const rect = getRangeRect(range);
    if (!rect) {
      return null;
    }

    return {
      word,
      sentence: extractSentence(selection, range, rawText, word),
      rect
    };
  }

  function cleanSelectedText(text) {
    return text
      .replace(/\u00a0/g, " ")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^[\s"'“”‘’«»《》（）()[\]{}<>.,，、:：;؛.!?。！？؟۔]+/u, "")
      .replace(/[\s"'“”‘’«»《》（）()[\]{}<>.,，、:：;؛.!?。！？؟۔]+$/u, "");
  }

  function getWordCount(text) {
    return text.split(/[\s\u200c]+/u).filter(Boolean).length;
  }

  function getRangeRect(range) {
    const directRect = range.getBoundingClientRect();
    if (directRect && (directRect.width || directRect.height)) {
      return directRect;
    }

    const rects = range.getClientRects();
    return rects.length ? rects[0] : null;
  }

  function extractSentence(selection, range, rawSelectedText, cleanWord) {
    const textNodeContext = getTextNodeContext(range.startContainer, range.startOffset);
    if (textNodeContext) {
      return findSentenceAroundIndex(
        textNodeContext.text,
        textNodeContext.offset,
        rawSelectedText,
        cleanWord
      );
    }

    const anchorText = getNodeText(selection.anchorNode);
    const anchorSentence = findSentenceByText(anchorText, rawSelectedText, cleanWord);
    if (anchorSentence) {
      return anchorSentence;
    }

    const commonText = getNodeText(range.commonAncestorContainer);
    const commonSentence = findSentenceByText(commonText, rawSelectedText, cleanWord);
    if (commonSentence) {
      return commonSentence;
    }

    return cleanSelectedText(rawSelectedText) || cleanWord;
  }

  function getTextNodeContext(node, offset) {
    if (!node || node.nodeType !== Node.TEXT_NODE || typeof node.textContent !== "string") {
      return null;
    }

    return {
      text: node.textContent,
      offset: Math.max(0, Math.min(offset, node.textContent.length))
    };
  }

  function getNodeText(node) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || "";
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node.closest?.("p, li, blockquote, td, th, figcaption, article, section, div");
      return element?.innerText || node.textContent || "";
    }

    return node.textContent || "";
  }

  function findSentenceByText(text, rawSelectedText, cleanWord) {
    if (!text) {
      return "";
    }

    const rawIndex = rawSelectedText ? text.indexOf(rawSelectedText) : -1;
    if (rawIndex >= 0) {
      return findSentenceAroundIndex(text, rawIndex, rawSelectedText, cleanWord);
    }

    const cleanIndex = cleanWord ? text.indexOf(cleanWord) : -1;
    if (cleanIndex >= 0) {
      return findSentenceAroundIndex(text, cleanIndex, rawSelectedText, cleanWord);
    }

    return "";
  }

  function findSentenceAroundIndex(text, index, rawSelectedText, cleanWord) {
    if (!text) {
      return cleanWord;
    }

    let targetIndex = index;
    if (targetIndex < 0) {
      targetIndex = rawSelectedText ? text.indexOf(rawSelectedText) : -1;
    }
    if (targetIndex < 0) {
      targetIndex = cleanWord ? text.indexOf(cleanWord) : -1;
    }
    if (targetIndex < 0) {
      return trimSentence(text);
    }

    const start = findPreviousSentenceBoundary(text, targetIndex);
    const end = findNextSentenceBoundary(text, targetIndex);
    return trimSentence(text.slice(start, end));
  }

  function findPreviousSentenceBoundary(text, index) {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (isSentenceBoundary(text[i])) {
        return i + 1;
      }
    }
    return 0;
  }

  function findNextSentenceBoundary(text, index) {
    for (let i = index; i < text.length; i += 1) {
      if (isSentenceBoundary(text[i])) {
        return i + 1;
      }
    }
    return text.length;
  }

  function isSentenceBoundary(char) {
    return /[.!?。！？؟۔\n\r]/u.test(char);
  }

  function trimSentence(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= 500) {
      return normalized;
    }

    return `${normalized.slice(0, 500)}...`;
  }

  function showLoadingCard(word, rect) {
    const card = ensureCard(rect);
    card.replaceChildren(
      createHeader(word, "", true),
      createStatus("分析中...")
    );
    positionCard(card, rect);
  }

  function renderResult(data, options = {}) {
    const card = ensureCard(options.rect);
    const showRefresh = Boolean(options.cached);
    if (data?.id && currentLookup) {
      currentLookup.id = data.id;
      currentLookup.starred = Boolean(data.starred);
    }

    card.replaceChildren(
      createHeader(data.word || "", data.translit || "", true, {
        id: data.id,
        starred: Boolean(data.starred)
      }),
      createLangTag(data.lang || "未知语言"),
      createField("💡", "词义", data.meaning || "暂无"),
      createField("🌱", "词源", data.etymology || "暂无"),
      createField("📍", "句中作用", data.form || "暂无"),
      createFooter(showRefresh)
    );

    if (options.rect) {
      positionCard(card, options.rect);
    }
  }

  function showError(error, word, rect) {
    const card = ensureCard(rect);
    const friendlyMessage = getFriendlyErrorMessage(error);

    if (error?.type === "invalid_json" && error.rawResponse) {
      console.warn("[多语言查词助手] DeepSeek返回非法JSON：", error.rawResponse);
    }

    card.replaceChildren(
      createHeader(word || "查询失败", "", true),
      createStatus(friendlyMessage, true),
      error?.type === "missing_key" ? createOpenOptionsButton() : createRetryHint()
    );

    if (rect) {
      positionCard(card, rect);
    }
  }

  function ensureCard(rect) {
    if (!activeCard) {
      activeCard = document.createElement("div");
      activeCard.id = CARD_ID;
      activeCard.className = "mlwa-card";
      activeCard.addEventListener("mousedown", (event) => event.stopPropagation());
      document.documentElement.appendChild(activeCard);
      bindOutsideClick();
    }

    if (rect) {
      positionCard(activeCard, rect);
    }

    return activeCard;
  }

  function positionCard(card, rect) {
    const margin = 12;
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const maxLeft = scrollX + window.innerWidth - CARD_WIDTH - margin;
    const left = Math.max(scrollX + margin, Math.min(scrollX + rect.left, maxLeft));
    const belowTop = scrollY + rect.bottom + 8;
    const aboveTop = scrollY + rect.top - card.offsetHeight - 8;
    const estimatedHeight = card.offsetHeight || 190;
    const wouldOverflowBottom = belowTop + estimatedHeight > scrollY + window.innerHeight - margin;
    const top = wouldOverflowBottom && aboveTop > scrollY + margin
      ? aboveTop
      : belowTop;

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(Math.max(scrollY + margin, top))}px`;
  }

  function createHeader(word, translit, withClose, starState = null) {
    const header = document.createElement("div");
    header.className = "mlwa-header";

    const title = document.createElement("div");
    title.className = "mlwa-title";

    const wordNode = document.createElement("span");
    wordNode.className = "mlwa-word";
    wordNode.textContent = word;
    title.appendChild(wordNode);

    if (translit) {
      const translitNode = document.createElement("span");
      translitNode.className = "mlwa-translit";
      translitNode.textContent = translit;
      title.appendChild(translitNode);
    }

    header.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "mlwa-header-actions";

    if (starState?.id) {
      actions.appendChild(createStarButton(starState.starred));
    }

    if (withClose) {
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "mlwa-close";
      closeButton.textContent = "×";
      closeButton.title = "关闭";
      closeButton.addEventListener("click", closeCard);
      actions.appendChild(closeButton);
    }

    header.appendChild(actions);
    return header;
  }

  function createStarButton(starred) {
    const starButton = document.createElement("button");
    starButton.type = "button";
    starButton.className = starred ? "mlwa-star is-starred" : "mlwa-star";
    starButton.textContent = starred ? "⭐" : "☆";
    starButton.title = starred ? "从生词本移除" : "加入生词本";
    starButton.setAttribute("aria-label", starButton.title);
    starButton.addEventListener("click", handleStarClick);
    return starButton;
  }

  function createLangTag(lang) {
    const row = document.createElement("div");
    row.className = "mlwa-tag-row";

    const tag = document.createElement("span");
    tag.className = "mlwa-lang-tag";
    tag.textContent = lang;
    row.appendChild(tag);

    return row;
  }

  function createField(icon, label, value) {
    const row = document.createElement("div");
    row.className = "mlwa-field";

    const iconNode = document.createElement("span");
    iconNode.className = "mlwa-field-icon";
    iconNode.textContent = icon;
    row.appendChild(iconNode);

    const content = document.createElement("div");
    content.className = "mlwa-field-content";

    const labelNode = document.createElement("span");
    labelNode.className = "mlwa-field-label";
    labelNode.textContent = label;
    content.appendChild(labelNode);

    const valueNode = document.createElement("span");
    valueNode.className = "mlwa-field-value";
    valueNode.textContent = value;
    content.appendChild(valueNode);

    row.appendChild(content);
    return row;
  }

  function createStatus(message, isError = false) {
    const status = document.createElement("div");
    status.className = isError ? "mlwa-status mlwa-status-error" : "mlwa-status";
    status.textContent = message;
    return status;
  }

  function createFooter(showRefresh) {
    const footer = document.createElement("div");
    footer.className = "mlwa-footer";

    if (!showRefresh) {
      return footer;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "mlwa-secondary-button";
    button.textContent = "重新分析句中作用";
    button.addEventListener("click", handleReanalyzeClick);
    footer.appendChild(button);

    return footer;
  }

  function createOpenOptionsButton() {
    const footer = document.createElement("div");
    footer.className = "mlwa-footer";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "mlwa-primary-button";
    button.textContent = "打开设置页";
    button.addEventListener("click", () => {
      sendRuntimeMessage({ type: "OPEN_OPTIONS" });
    });
    footer.appendChild(button);

    return footer;
  }

  function createRetryHint() {
    const hint = document.createElement("div");
    hint.className = "mlwa-hint";
    hint.textContent = "可以稍后重新选中单词再试。";
    return hint;
  }

  function handleReanalyzeClick(event) {
    const button = event.currentTarget;
    if (!currentLookup?.word) {
      return;
    }

    button.disabled = true;
    button.textContent = "分析中...";

    sendRuntimeMessage({
      type: "REANALYZE_FORM",
      word: currentLookup.word,
      sentence: currentLookup.sentence,
      id: currentLookup.id
    })
      .then((response) => {
        if (!response?.ok) {
          showError(response?.error || { type: "unknown", message: "查询失败" }, currentLookup.word);
          return;
        }

        currentLookup.id = response.id || response.data?.id || currentLookup.id;
        currentLookup.starred = Boolean(response.data?.starred);
        renderResult(response.data, {
          cached: true
        });
      })
      .catch((error) => {
        showError(
          {
            type: "runtime_error",
            message: error.message || "扩展通信失败"
          },
          currentLookup.word
        );
      });
  }

  function handleStarClick(event) {
    event.stopPropagation();

    const button = event.currentTarget;
    if (!currentLookup?.id) {
      return;
    }

    button.disabled = true;

    sendRuntimeMessage({
      type: "TOGGLE_STAR",
      id: currentLookup.id
    })
      .then((response) => {
        if (!response?.ok) {
          button.disabled = false;
          showError(response?.error || { type: "unknown", message: "星标更新失败" }, currentLookup.word);
          return;
        }

        currentLookup.starred = Boolean(response.data?.starred);
        updateStarButton(button, currentLookup.starred);
      })
      .catch((error) => {
        button.disabled = false;
        showError(
          {
            type: "runtime_error",
            message: error.message || "星标更新失败"
          },
          currentLookup.word
        );
      });
  }

  function updateStarButton(button, starred) {
    button.disabled = false;
    button.classList.toggle("is-starred", starred);
    button.textContent = starred ? "⭐" : "☆";
    button.title = starred ? "从生词本移除" : "加入生词本";
    button.setAttribute("aria-label", button.title);
  }

  function bindOutsideClick() {
    removeOutsideClick();
    outsideClickHandler = (event) => {
      if (activeCard && !activeCard.contains(event.target)) {
        closeCard();
      }
    };
    document.addEventListener("mousedown", outsideClickHandler, true);
  }

  function removeOutsideClick() {
    if (outsideClickHandler) {
      document.removeEventListener("mousedown", outsideClickHandler, true);
      outsideClickHandler = null;
    }
  }

  function closeCard() {
    activeRequestId += 1;
    currentLookup = null;
    if (activeCard) {
      activeCard.remove();
      activeCard = null;
    }
    removeOutsideClick();
  }

  function getFriendlyErrorMessage(error) {
    switch (error?.type) {
      case "missing_key":
        return "请先在扩展设置中配置DeepSeek API Key";
      case "invalid_key":
        return "API Key无效";
      case "insufficient_balance":
        return "DeepSeek账户余额不足";
      case "network":
        return "网络错误，请重试";
      case "timeout":
        return "请求超时，请重试";
      case "invalid_json":
        return "解析失败";
      default:
        return error?.message || "查询失败";
    }
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
})();
