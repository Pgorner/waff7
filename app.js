(() => {
  const Store = window.SachkundeStore;
  const dataset = Store.datasetFromWindow();
  let state = Store.loadState(dataset);
  let batch = null;
  let currentQuestion = null;
  let view = {
    mode: 'question',
    selectedKeys: [],
    pendingCorrect: null
  };

  const el = {};
  const ids = [
    'progressLabel', 'progressFill',
    'questionId', 'questionType', 'questionPrompt', 'questionSection',
    'questionInteraction', 'feedbackBox',
    'btnSubmit', 'btnReveal', 'btnMarkWrong', 'btnMarkRight', 'btnBackToQuestion', 'btnNext',
    'studyCard', 'summaryScreen', 'summaryTitle', 'summarySubtitle',
    'summaryFirstPass', 'summaryAccuracy', 'summaryRecycled', 'summaryRounds', 'summaryNote', 'btnNextBatch'
  ];

  function $(id) { return document.getElementById(id); }
  function cache() { ids.forEach(id => el[id] = $(id)); }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function questionMap() { return Store.getQuestionMap(dataset); }

  function getCurrentQuestion() {
    if (!batch || !batch.currentQuestionId) return null;
    return questionMap().get(batch.currentQuestionId) || null;
  }

  function resetViewState() {
    view = {
      mode: 'question',
      selectedKeys: [],
      pendingCorrect: null
    };
  }

  function startNextBatch() {
    batch = Store.createBatch(dataset, state, { queue: 'all', type: 'all', chapter: 'all', section: 'all', search: '' }, 12);
    state.currentBatch = batch;
    state.session.currentBatchId = batch ? batch.id : null;
    Store.saveState(dataset, state);
    resetViewState();
    render();
  }

  function ensureBatch() {
    if (state.currentBatch && !state.currentBatch.completed) {
      batch = state.currentBatch;
    } else {
      startNextBatch();
    }
  }

  function setFeedback(kind, html) {
    el.feedbackBox.className = `feedback-box ${kind}`;
    el.feedbackBox.innerHTML = html;
  }

  function hideFeedback() {
    el.feedbackBox.className = 'feedback-box hidden';
    el.feedbackBox.innerHTML = '';
  }

  function updateTopProgress() {
    if (!batch || !currentQuestion) {
      el.progressLabel.textContent = 'Frage – / –';
      el.progressFill.style.width = '0%';
      return;
    }
    const baseCount = batch.questionIds.length || 12;
    const current = Math.min((batch.currentIndex || 0) + 1, baseCount);
    el.progressLabel.textContent = `Frage ${current} / ${baseCount}`;
    el.progressFill.style.width = `${Math.max(0, Math.min(100, ((current - 1) / baseCount) * 100))}%`;
  }

  function renderQuestionMeta() {
    el.questionId.textContent = currentQuestion?.id || '–';
    el.questionType.textContent = currentQuestion?.type === 'multiple_choice' ? 'Multiple Choice' : 'Textantwort';
    el.questionPrompt.textContent = currentQuestion?.prompt || 'Keine Frage verfügbar';
    el.questionSection.textContent = currentQuestion
      ? [currentQuestion.chapter, currentQuestion.section].filter(Boolean).join(' · ')
      : '';
  }

  function renderMCQuestion() {
    const selected = new Set(view.selectedKeys);
    const options = currentQuestion.options || [];
    el.questionInteraction.innerHTML = options.map(opt => {
      const isSelected = selected.has(opt.key);
      let stateClass = '';
      if (view.mode === 'answered') {
        if (opt.correct) stateClass = ' is-correct';
        else if (isSelected && !opt.correct) stateClass = ' is-wrong';
      } else if (isSelected) {
        stateClass = ' is-selected';
      }
      return `
        <button type="button" class="option-card flash-option${stateClass}" data-key="${escapeHtml(opt.key)}">
          <span class="option-indicator">${escapeHtml(opt.key.toUpperCase())}</span>
          <span class="option-text">${escapeHtml(opt.text)}</span>
        </button>
      `;
    }).join('');

    el.questionInteraction.querySelectorAll('[data-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (view.mode === 'answered') return;
        const key = btn.dataset.key;
        const next = new Set(view.selectedKeys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        view.selectedKeys = [...next];
        renderQuestionInteraction();
      });
    });
  }

  function renderTextQuestion() {
    const answer = currentQuestion.answer_text || 'Keine hinterlegte Antwort.';
    if (view.mode === 'question') {
      el.questionInteraction.innerHTML = '<div class="flash-text-hint muted">Überlege dir zuerst die Antwort und decke sie dann auf.</div>';
      return;
    }

    el.questionInteraction.innerHTML = `
      <div class="flash-answer-card">
        <div class="eyebrow">Antwort</div>
        <div class="flash-answer-text">${escapeHtml(answer)}</div>
      </div>
    `;
  }

  function renderButtons() {
    const isMC = currentQuestion?.type === 'multiple_choice';
    el.btnSubmit.classList.toggle('hidden', !(isMC && view.mode !== 'answered'));
    el.btnReveal.classList.toggle('hidden', !(!isMC && view.mode === 'question'));
    el.btnMarkWrong.classList.toggle('hidden', !(!isMC && view.mode === 'revealed'));
    el.btnMarkRight.classList.toggle('hidden', !(!isMC && view.mode === 'revealed'));
    el.btnBackToQuestion.classList.toggle('hidden', !(!isMC && view.mode === 'revealed'));
    el.btnNext.classList.toggle('hidden', !(view.mode === 'answered'));
    if (isMC) el.btnSubmit.disabled = view.selectedKeys.length === 0;
  }

  function renderQuestionInteraction() {
    // hard reset to prevent carry-over of checkmarks from previous questions
    el.questionInteraction.replaceChildren();
    hideFeedback();

    if (!currentQuestion) {
      el.questionInteraction.innerHTML = '<div class="muted">Keine Frage verfügbar.</div>';
      renderButtons();
      return;
    }

    if (currentQuestion.type === 'multiple_choice') renderMCQuestion();
    else renderTextQuestion();

    renderButtons();
  }

  function handleSubmitMC() {
    const selected = new Set(view.selectedKeys);
    const correctKeys = new Set((currentQuestion.options || []).filter(o => o.correct).map(o => o.key));
    const isCorrect = selected.size === correctKeys.size && [...selected].every(k => correctKeys.has(k));

    view.mode = 'answered';
    view.pendingCorrect = isCorrect;
    renderQuestionInteraction();
    setFeedback(
      isCorrect ? 'success' : 'danger',
      isCorrect
        ? 'Richtig. Die Auswahl stimmt.'
        : 'Nicht korrekt. Grün markiert sind die richtigen Antworten, rot deine falschen Markierungen.'
    );
  }

  function handleRevealText() {
    view.mode = 'revealed';
    renderQuestionInteraction();
  }

  function finalizeAnswer(correct) {
    if (!currentQuestion || !batch) return;
    Store.updateQuestionAfterAnswer(dataset, state, currentQuestion, correct);
    const result = Store.advanceBatch(dataset, state, batch, currentQuestion.id, correct);
    state = Store.loadState(dataset);
    batch = state.currentBatch;

    if (result.status === 'completed') {
      showSummary(result.summary);
      return;
    }

    resetViewState();
    currentQuestion = getCurrentQuestion();
    render();
  }

  function showSummary(summary) {
    view.mode = 'summary';
    el.studyCard.classList.add('hidden');
    el.summaryScreen.classList.remove('hidden');

    const total = summary.totalQuestions || 0;
    const firstPassCorrect = summary.firstPassCorrect || 0;
    const accuracy = summary.totalAttempts ? summary.totalQuestions / summary.totalAttempts : 1;

    el.summaryTitle.textContent = `${total} / ${total} gemeistert`;
    el.summarySubtitle.textContent = 'Alle Fragen dieses Batches wurden mindestens einmal korrekt beantwortet.';
    el.summaryFirstPass.textContent = `${firstPassCorrect} / ${total}`;
    el.summaryAccuracy.textContent = Store.formatPct(accuracy);
    el.summaryRecycled.textContent = String(summary.recycled || 0);
    el.summaryRounds.textContent = String(summary.rounds || 1);

    const missed = Math.max(0, total - firstPassCorrect);
    el.summaryNote.innerHTML = missed
      ? `${missed} Frage${missed === 1 ? '' : 'n'} war${missed === 1 ? '' : 'en'} in der ersten Runde noch unsicher und wurde${missed === 1 ? '' : 'n'} erneut abgefragt.`
      : 'Starker Durchgang: alle Fragen waren direkt in der ersten Runde korrekt.';
  }

  function render() {
    currentQuestion = getCurrentQuestion();
    updateTopProgress();

    if (view.mode === 'summary') return;

    el.summaryScreen.classList.add('hidden');
    el.studyCard.classList.remove('hidden');
    renderQuestionMeta();
    renderQuestionInteraction();
  }

  function bindEvents() {
    el.btnSubmit.addEventListener('click', handleSubmitMC);
    el.btnReveal.addEventListener('click', handleRevealText);
    el.btnMarkWrong.addEventListener('click', () => finalizeAnswer(false));
    el.btnMarkRight.addEventListener('click', () => finalizeAnswer(true));
    el.btnBackToQuestion.addEventListener('click', () => {
      view.mode = 'question';
      renderQuestionInteraction();
    });
    el.btnNext.addEventListener('click', () => finalizeAnswer(Boolean(view.pendingCorrect)));
    el.btnNextBatch.addEventListener('click', () => {
      state = Store.loadState(dataset);
      startNextBatch();
    });

    document.addEventListener('keydown', (event) => {
      if (view.mode === 'summary') {
        if (event.key === 'Enter') {
          event.preventDefault();
          el.btnNextBatch.click();
        }
        return;
      }

      if (!currentQuestion) return;

      if (currentQuestion.type === 'multiple_choice') {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (view.mode === 'answered') el.btnNext.click();
          else if (!el.btnSubmit.disabled) el.btnSubmit.click();
        }
        return;
      }

      if (event.key === 'Enter' && view.mode === 'question') {
        event.preventDefault();
        el.btnReveal.click();
      } else if (event.key === '1' && view.mode === 'revealed') {
        event.preventDefault();
        el.btnMarkWrong.click();
      } else if (event.key === '2' && view.mode === 'revealed') {
        event.preventDefault();
        el.btnMarkRight.click();
      } else if (event.key === 'Escape' && view.mode === 'revealed') {
        event.preventDefault();
        el.btnBackToQuestion.click();
      }
    });
  }

  function init() {
    cache();
    bindEvents();
    ensureBatch();
    currentQuestion = getCurrentQuestion();
    render();
  }

  init();
})();
