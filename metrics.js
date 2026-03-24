(() => {
  const Store = window.SachkundeStore;
  const dataset = Store.datasetFromWindow();
  let state = Store.loadState(dataset);
  const el = {};
  const qs = id => document.getElementById(id);

  function cacheElements() {
    [
      'datasetTitle', 'datasetSubtitle', 'metricsChapterSelect', 'metricsTypeSelect',
      'btnExportProgress', 'btnImportProgress', 'progressFileInput', 'btnResetProgress',
      'statTotal', 'statReviewed', 'statMastered', 'statMasteredPct', 'statAccuracy', 'statCorrect', 'statIncorrect', 'statDue', 'statUnseen', 'statBookmarks',
      'activityChart', 'batchHistoryList', 'chapterMetrics', 'hardQuestionList'
    ].forEach(id => el[id] = qs(id));
  }

  function toast(message, danger = false) {
    const div = document.createElement('div');
    div.className = 'toast';
    if (danger) div.style.borderColor = 'rgba(255, 120, 157, 0.45)';
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 2600);
  }

  function updateDatasetHeader() {
    const chapters = new Set(dataset.questions.map(q => Store.normalizeChapterLabel(q.chapter)));
    el.datasetTitle.textContent = dataset.source_pdf || 'Sachkunde Datensatz';
    el.datasetSubtitle.textContent = `${dataset.question_count || dataset.questions.length} Fragen · ${chapters.size} Kapitel · Fortschritt lokal gespeichert`;
  }

  function buildFilterOptions() {
    const chapters = Array.from(new Set(dataset.questions.map(q => Store.normalizeChapterLabel(q.chapter)))).sort((a, b) => a.localeCompare(b, 'de'));
    el.metricsChapterSelect.innerHTML = '<option value="all">Alle Kapitel</option>' + chapters.map(ch => `<option value="${escapeHtml(ch)}">${escapeHtml(ch)}</option>`).join('');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getVisibleQuestions() {
    const chapter = el.metricsChapterSelect.value;
    const type = el.metricsTypeSelect.value;
    return dataset.questions.filter(q => {
      if (chapter !== 'all' && Store.normalizeChapterLabel(q.chapter) !== chapter) return false;
      if (type !== 'all' && q.type !== type) return false;
      return true;
    });
  }

  function updateTopStats(questions) {
    const states = questions.map(q => Store.getQuestionState(state, q.id));
    const total = questions.length;
    const reviewed = states.filter(s => s.seenCount > 0).length;
    const mastered = states.filter(Store.isMastered).length;
    const due = states.filter(Store.isDue).length;
    const unseen = states.filter(s => s.seenCount === 0).length;
    const bookmarks = states.filter(s => s.bookmarked).length;
    const correct = states.reduce((sum, s) => sum + s.correctCount, 0);
    const incorrect = states.reduce((sum, s) => sum + s.incorrectCount, 0);
    const accuracy = correct + incorrect ? correct / (correct + incorrect) : 0;

    el.statTotal.textContent = total.toLocaleString('de-DE');
    el.statReviewed.textContent = `${reviewed.toLocaleString('de-DE')} davon bearbeitet`;
    el.statMastered.textContent = mastered.toLocaleString('de-DE');
    el.statMasteredPct.textContent = Store.formatPct(total ? mastered / total : 0);
    el.statAccuracy.textContent = Store.formatPct(accuracy);
    el.statCorrect.textContent = correct.toLocaleString('de-DE');
    el.statIncorrect.textContent = incorrect.toLocaleString('de-DE');
    el.statDue.textContent = due.toLocaleString('de-DE');
    el.statUnseen.textContent = unseen.toLocaleString('de-DE');
    el.statBookmarks.textContent = bookmarks.toLocaleString('de-DE');
  }

  function renderActivityChart() {
    const now = new Date();
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const entry = state.historyByDay[key] || { answered: 0, correct: 0, incorrect: 0 };
      days.push({
        key,
        label: d.toLocaleDateString('de-DE', { weekday: 'short' }).slice(0, 2),
        answered: entry.answered || 0,
        accuracy: entry.answered ? (entry.correct || 0) / entry.answered : 0
      });
    }
    const maxAnswered = Math.max(1, ...days.map(d => d.answered));
    el.activityChart.innerHTML = '';
    days.forEach(day => {
      const wrap = document.createElement('div');
      wrap.className = 'activity-bar-wrap';
      const value = document.createElement('div');
      value.className = 'activity-value';
      value.textContent = day.answered;
      const bar = document.createElement('div');
      bar.className = 'activity-bar';
      bar.style.height = `${Math.max(16, (day.answered / maxAnswered) * 180)}px`;
      bar.style.opacity = String(0.35 + day.accuracy * 0.65);
      bar.title = `${day.key}: ${day.answered} Antworten · ${Store.formatPct(day.accuracy)}`;
      const label = document.createElement('div');
      label.className = 'activity-label';
      label.textContent = day.label;
      wrap.append(value, bar, label);
      el.activityChart.appendChild(wrap);
    });
  }

  function renderBatchHistory() {
    el.batchHistoryList.innerHTML = '';
    const rows = (state.batchHistory || []).slice(0, 12);
    if (!rows.length) {
      el.batchHistoryList.innerHTML = '<div class="metric-item"><div class="metric-item-title">Noch keine Batch-Historie</div><div class="metric-item-sub">Sobald du Lern-Batches abschließt, erscheint hier die Qualität der letzten Durchläufe.</div></div>';
      return;
    }
    rows.forEach(batch => {
      const item = document.createElement('div');
      item.className = 'metric-item';
      item.innerHTML = `
        <div class="metric-item-top">
          <div class="metric-item-title">${new Date(batch.completedAt).toLocaleDateString('de-DE')} · ${batch.totalQuestions} Fragen</div>
          <span class="badge-mini ${batch.recycled ? 'bad' : 'good'}">${batch.recycled ? batch.recycled + ' Fehlerfragen' : 'sauber'}</span>
        </div>
        <div class="metric-item-sub">Runden: ${batch.rounds} · Ersttreffer: ${Store.formatPct(batch.accuracyFirstPass || 0)} · Gesamtversuche: ${batch.totalAttempts}</div>
      `;
      el.batchHistoryList.appendChild(item);
    });
  }

  function renderChapterMetrics(questions) {
    const groups = new Map();
    questions.forEach(q => {
      const key = Store.normalizeChapterLabel(q.chapter);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(q);
    });

    const rows = Array.from(groups.entries()).map(([chapter, list]) => {
      const states = list.map(q => Store.getQuestionState(state, q.id));
      const reviewed = states.filter(s => s.seenCount > 0).length;
      const mastered = states.filter(Store.isMastered).length;
      const correct = states.reduce((sum, s) => sum + s.correctCount, 0);
      const incorrect = states.reduce((sum, s) => sum + s.incorrectCount, 0);
      const accuracy = correct + incorrect ? correct / (correct + incorrect) : 0;
      return {
        chapter,
        total: list.length,
        reviewedPct: list.length ? reviewed / list.length : 0,
        masteredPct: list.length ? mastered / list.length : 0,
        accuracy
      };
    }).sort((a, b) => b.masteredPct - a.masteredPct || b.reviewedPct - a.reviewedPct);

    el.chapterMetrics.innerHTML = '';
    if (!rows.length) {
      el.chapterMetrics.innerHTML = '<div class="metric-item"><div class="metric-item-title">Keine Daten</div></div>';
      return;
    }

    rows.forEach(row => {
      const item = document.createElement('div');
      item.className = 'metric-table-row';
      item.innerHTML = `
        <div class="metric-table-head">
          <div class="metric-table-title">${escapeHtml(row.chapter)}</div>
          <div class="metric-item-sub">${row.total} Fragen · ${Store.formatPct(row.accuracy)} Trefferquote</div>
        </div>
        <div class="metric-bars">
          <div>
            <div class="metric-bar-label"><span>Bearbeitet</span><span>${Store.formatPct(row.reviewedPct)}</span></div>
            <div class="metric-bar-track"><div class="metric-bar-fill" style="width:${row.reviewedPct * 100}%"></div></div>
          </div>
          <div>
            <div class="metric-bar-label"><span>Beherrscht</span><span>${Store.formatPct(row.masteredPct)}</span></div>
            <div class="metric-bar-track"><div class="metric-bar-fill success" style="width:${row.masteredPct * 100}%"></div></div>
          </div>
        </div>
      `;
      el.chapterMetrics.appendChild(item);
    });
  }

  function renderHardQuestions(questions) {
    const rows = questions
      .map(q => ({ q, s: Store.getQuestionState(state, q.id) }))
      .sort((a, b) => Store.priorityScore(b.s) - Store.priorityScore(a.s))
      .slice(0, 15);

    el.hardQuestionList.innerHTML = '';
    if (!rows.length) {
      el.hardQuestionList.innerHTML = '<div class="metric-item"><div class="metric-item-title">Keine Fragen im aktuellen Filter</div></div>';
      return;
    }

    rows.forEach(({ q, s }) => {
      const item = document.createElement('div');
      item.className = 'metric-item';
      item.innerHTML = `
        <div class="metric-item-top">
          <div class="metric-item-title">${q.id}</div>
          <span class="badge-mini ${s.lastResult === 'incorrect' ? 'bad' : Store.isMastered(s) ? 'good' : 'warn'}">${Store.formatDue(s.dueAt)}</span>
        </div>
        <div class="metric-item-sub">${escapeHtml(q.prompt.slice(0, 120))}${q.prompt.length > 120 ? '…' : ''}<br>${escapeHtml(q.section || 'Ohne Abschnitt')} · Fehler: ${s.incorrectCount} · Accuracy: ${Store.formatPct(Store.getAccuracy(s))}</div>
      `;
      el.hardQuestionList.appendChild(item);
    });
  }

  function exportProgress() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), datasetIdentity: Store.dataKey(dataset), state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sachkunde_progress.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importProgressFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed.state || !parsed.state.questions) throw new Error('Ungültige Fortschrittsdatei');
        state = Store.ensureStateShape(parsed.state, dataset);
        Store.saveState(dataset, state);
        renderAll();
        toast('Fortschritt importiert.');
      } catch (err) {
        toast(`Import fehlgeschlagen: ${err.message}`, true);
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function resetProgress() {
    if (!confirm('Den kompletten lokalen Fortschritt für diesen Datensatz wirklich löschen?')) return;
    localStorage.removeItem(Store.dataKey(dataset));
    state = Store.loadState(dataset);
    renderAll();
    toast('Fortschritt zurückgesetzt.');
  }

  function renderAll() {
    updateDatasetHeader();
    const questions = getVisibleQuestions();
    updateTopStats(questions);
    renderActivityChart();
    renderBatchHistory();
    renderChapterMetrics(questions);
    renderHardQuestions(questions);
  }

  function bindEvents() {
    el.metricsChapterSelect.addEventListener('change', renderAll);
    el.metricsTypeSelect.addEventListener('change', renderAll);
    el.btnExportProgress.addEventListener('click', exportProgress);
    el.btnImportProgress.addEventListener('click', () => el.progressFileInput.click());
    el.progressFileInput.addEventListener('change', (e) => {
      if (e.target.files?.[0]) importProgressFile(e.target.files[0]);
      e.target.value = '';
    });
    el.btnResetProgress.addEventListener('click', resetProgress);
  }

  function init() {
    cacheElements();
    buildFilterOptions();
    bindEvents();
    renderAll();
  }

  init();
})();
