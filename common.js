(() => {
  const STORAGE_PREFIX = 'sachkunde_trainer_v2';
  const DAY_MS = 86400000;

  function nowTs() { return Date.now(); }
  function todayKey(ts = nowTs()) { return new Date(ts).toISOString().slice(0, 10); }
  function startOfDay(ts = nowTs()) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function addDays(ts, days) { return ts + days * DAY_MS; }
  function normalizeChapterLabel(raw) {
    if (!raw) return 'Ohne Kapitel';
    return String(raw).replace(/\s+/g, ' ').trim();
  }
  function shuffle(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  function compareQuestionIds(a, b) {
    const [a1, a2] = String(a).split('.').map(Number);
    const [b1, b2] = String(b).split('.').map(Number);
    return (a1 - b1) || (a2 - b2);
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function formatPct(value) {
    return `${Math.round((value || 0) * 100)}%`;
  }
  function formatDate(ts) {
    if (!ts) return '–';
    return new Date(ts).toLocaleDateString('de-DE');
  }
  function formatDue(ts) {
    if (!ts) return 'sofort';
    const diffDays = Math.ceil((ts - nowTs()) / DAY_MS);
    if (diffDays <= 0) return 'jetzt';
    if (diffDays === 1) return 'morgen';
    return `in ${diffDays} Tagen`;
  }

  function defaultQuestionState() {
    return {
      seenCount: 0,
      correctCount: 0,
      incorrectCount: 0,
      lapseCount: 0,
      streak: 0,
      ease: 2.35,
      difficulty: 0.32,
      intervalDays: 0,
      dueAt: 0,
      lastReviewedAt: 0,
      lastResult: null,
      revealedCount: 0,
      bookmarked: false,
      notes: '',
      recentOutcomes: [],
      successfulReviews: 0
    };
  }

  function datasetFromWindow() {
    return window.SACHKUNDE_DATA || { source_pdf: '', schema_version: 1, question_count: 0, questions: [] };
  }

  function dataKey(dataset) {
    const identity = `${dataset.source_pdf}|${dataset.schema_version}|${dataset.question_count || dataset.questions.length}`;
    return `${STORAGE_PREFIX}:${identity}`;
  }

  function createEmptyState(dataset) {
    return {
      version: 2,
      datasetIdentity: dataKey(dataset),
      createdAt: nowTs(),
      updatedAt: nowTs(),
      session: {
        answered: 0,
        correct: 0,
        incorrect: 0,
        streak: 0,
        batchesCompleted: 0,
        currentBatchId: null
      },
      settings: {
        batchSize: 12
      },
      historyByDay: {},
      batchHistory: [],
      questions: {},
      currentBatch: null
    };
  }

  function ensureStateShape(state, dataset) {
    if (!state || typeof state !== 'object') state = createEmptyState(dataset);
    if (!state.questions) state.questions = {};
    if (!state.historyByDay) state.historyByDay = {};
    if (!state.batchHistory) state.batchHistory = [];
    if (!state.settings) state.settings = { batchSize: 12 };
    if (!state.session) {
      state.session = { answered: 0, correct: 0, incorrect: 0, streak: 0, batchesCompleted: 0, currentBatchId: null };
    }
    if (typeof state.settings.batchSize !== 'number') state.settings.batchSize = 12;

    for (const q of dataset.questions) {
      if (!state.questions[q.id]) state.questions[q.id] = defaultQuestionState();
      else state.questions[q.id] = { ...defaultQuestionState(), ...state.questions[q.id] };
    }
    return state;
  }

  function loadState(dataset) {
    const raw = localStorage.getItem(dataKey(dataset));
    let state;
    if (!raw) {
      state = createEmptyState(dataset);
    } else {
      try {
        state = JSON.parse(raw);
      } catch {
        state = createEmptyState(dataset);
      }
    }
    state = ensureStateShape(state, dataset);
    saveState(dataset, state);
    return state;
  }

  function saveState(dataset, state) {
    state.updatedAt = nowTs();
    localStorage.setItem(dataKey(dataset), JSON.stringify(state));
  }

  function getQuestionState(state, qid) {
    return state.questions[qid] || defaultQuestionState();
  }

  function getAccuracy(qState) {
    const total = (qState.correctCount || 0) + (qState.incorrectCount || 0);
    return total ? (qState.correctCount || 0) / total : 0;
  }

  function isMastered(qState) {
    return (qState.successfulReviews || 0) >= 4 && (qState.streak || 0) >= 4 && getAccuracy(qState) >= 0.85 && (qState.intervalDays || 0) >= 7;
  }

  function isDue(qState, ts = nowTs()) {
    if (!qState.seenCount) return true;
    if (!qState.dueAt) return true;
    return qState.dueAt <= ts;
  }

  function overdueDays(qState, ts = nowTs()) {
    if (!qState.dueAt) return qState.seenCount ? 0 : 1;
    return Math.max(0, Math.floor((ts - qState.dueAt) / DAY_MS));
  }

  function retentionEstimate(qState) {
    const recent = Array.isArray(qState.recentOutcomes) ? qState.recentOutcomes : [];
    if (!recent.length) return 0;
    const weighted = recent.reduce((sum, entry, idx) => sum + entry * (idx + 1), 0);
    const denom = recent.reduce((sum, _, idx) => sum + (idx + 1), 0);
    return denom ? weighted / denom : 0;
  }

  function priorityScore(qState, ts = nowTs()) {
    const dueBoost = isDue(qState, ts) ? 2.2 + Math.min(2.2, overdueDays(qState, ts) * 0.18) : 0.18;
    const newBoost = qState.seenCount === 0 ? 2.6 : 0;
    const accuracyPenalty = 1 - getAccuracy(qState);
    const lapseBoost = Math.min(1.4, (qState.lapseCount || 0) * 0.18);
    const lastWrongBoost = qState.lastResult === 'incorrect' ? 0.75 : 0;
    const difficultyBoost = (qState.difficulty || 0) * 1.25;
    const bookmarkBoost = qState.bookmarked ? 0.22 : 0;
    const retentionPenalty = (1 - retentionEstimate(qState)) * 0.45;
    return dueBoost + newBoost + accuracyPenalty + lapseBoost + lastWrongBoost + difficultyBoost + bookmarkBoost + retentionPenalty;
  }

  function computeReviewOutcome(qState, correct) {
    let intervalDays = qState.intervalDays || 0;
    let ease = qState.ease || 2.35;
    let difficulty = qState.difficulty || 0.32;
    let streak = qState.streak || 0;

    if (correct) {
      streak += 1;
      const growthFactor = 1.45 + (ease - 1.3) * 0.75 - difficulty * 0.55 + Math.min(streak, 6) * 0.04;
      if (streak === 1 || intervalDays < 1) intervalDays = 1;
      else if (streak === 2) intervalDays = 3;
      else intervalDays = Math.max(4, Math.round(intervalDays * growthFactor));
      ease = clamp(ease + 0.06 - difficulty * 0.02, 1.3, 2.95);
      difficulty = clamp(difficulty - 0.05, 0.08, 0.98);
    } else {
      streak = 0;
      intervalDays = 1;
      ease = clamp(ease - 0.16, 1.3, 2.95);
      difficulty = clamp(difficulty + 0.12, 0.08, 0.98);
    }

    return {
      intervalDays,
      ease,
      difficulty,
      streak,
      dueAt: addDays(startOfDay(nowTs()), intervalDays)
    };
  }

  function registerHistory(state, correct) {
    const key = todayKey();
    if (!state.historyByDay[key]) state.historyByDay[key] = { answered: 0, correct: 0, incorrect: 0 };
    state.historyByDay[key].answered += 1;
    if (correct) state.historyByDay[key].correct += 1;
    else state.historyByDay[key].incorrect += 1;
  }

  function updateQuestionAfterAnswer(dataset, state, q, correct) {
    const qState = getQuestionState(state, q.id);
    qState.seenCount += 1;
    qState.lastReviewedAt = nowTs();
    qState.lastResult = correct ? 'correct' : 'incorrect';
    if (correct) {
      qState.correctCount += 1;
      qState.successfulReviews += 1;
    } else {
      qState.incorrectCount += 1;
      qState.lapseCount += 1;
    }

    const outcome = computeReviewOutcome(qState, correct);
    qState.intervalDays = outcome.intervalDays;
    qState.ease = outcome.ease;
    qState.difficulty = outcome.difficulty;
    qState.streak = outcome.streak;
    qState.dueAt = outcome.dueAt;

    qState.recentOutcomes = [...(qState.recentOutcomes || []), correct ? 1 : 0].slice(-12);

    state.session.answered += 1;
    if (correct) {
      state.session.correct += 1;
      state.session.streak += 1;
    } else {
      state.session.incorrect += 1;
      state.session.streak = 0;
    }

    registerHistory(state, correct);
    saveState(dataset, state);
    return qState;
  }

  function weightedSampleWithoutReplacement(items, weightFn, count) {
    const pool = [...items];
    const out = [];
    const limit = Math.min(count, pool.length);
    for (let k = 0; k < limit; k++) {
      const weights = pool.map(item => Math.max(0.0001, Number(weightFn(item)) || 0.0001));
      const total = weights.reduce((sum, w) => sum + w, 0);
      let r = Math.random() * total;
      let chosenIndex = 0;
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          chosenIndex = i;
          break;
        }
      }
      out.push(pool[chosenIndex]);
      pool.splice(chosenIndex, 1);
    }
    return out;
  }

  function buildBatchQuestions(dataset, state, filters, batchSize) {
    const ts = nowTs();
    const candidates = dataset.questions.filter(q => {
      const qState = getQuestionState(state, q.id);
      const chapterValue = normalizeChapterLabel(q.chapter);
      const sectionValue = q.section || 'Ohne Abschnitt';
      if (filters.type && filters.type !== 'all' && q.type !== filters.type) return false;
      if (filters.chapter && filters.chapter !== 'all' && chapterValue !== filters.chapter) return false;
      if (filters.section && filters.section !== 'all' && sectionValue !== filters.section) return false;
      if (filters.search) {
        const blob = `${q.id} ${q.prompt} ${q.answer_text || ''} ${(q.options || []).map(o => o.text).join(' ')} ${chapterValue} ${sectionValue}`.toLowerCase();
        if (!blob.includes(filters.search.toLowerCase())) return false;
      }
      if (filters.queue === 'due' && !isDue(qState, ts)) return false;
      if (filters.queue === 'unseen' && qState.seenCount !== 0) return false;
      if (filters.queue === 'weak' && !(qState.seenCount === 0 || getAccuracy(qState) < 0.75 || qState.lastResult === 'incorrect')) return false;
      if (filters.queue === 'incorrect' && qState.lastResult !== 'incorrect') return false;
      if (filters.queue === 'bookmarked' && !qState.bookmarked) return false;
      if (filters.queue === 'mastered' && !isMastered(qState)) return false;
      return true;
    });

    if (!candidates.length) return [];

    const due = candidates.filter(q => {
      const s = getQuestionState(state, q.id);
      return s.seenCount > 0 && isDue(s, ts);
    });
    const unseen = candidates.filter(q => getQuestionState(state, q.id).seenCount === 0);
    const review = candidates.filter(q => {
      const s = getQuestionState(state, q.id);
      return s.seenCount > 0 && !isDue(s, ts);
    });

    let dueTarget;
    let reviewTarget;
    let newTarget;

    if (due.length >= Math.ceil(batchSize * 0.6)) {
      dueTarget = Math.round(batchSize * 0.6);
      reviewTarget = Math.round(batchSize * 0.2);
      newTarget = batchSize - dueTarget - reviewTarget;
    } else if (due.length > 0) {
      dueTarget = due.length;
      reviewTarget = Math.min(review.length, Math.round(batchSize * 0.25));
      newTarget = batchSize - dueTarget - reviewTarget;
    } else {
      dueTarget = 0;
      reviewTarget = Math.min(review.length, Math.round(batchSize * 0.3));
      newTarget = batchSize - reviewTarget;
    }

    const selected = [];
    const selectedIds = new Set();
    const addUnique = (items) => {
      for (const item of items) {
        if (!selectedIds.has(item.id)) {
          selected.push(item);
          selectedIds.add(item.id);
        }
      }
    };

    addUnique(weightedSampleWithoutReplacement(due, q => priorityScore(getQuestionState(state, q.id), ts), dueTarget));
    addUnique(weightedSampleWithoutReplacement(review, q => priorityScore(getQuestionState(state, q.id), ts) + 0.35, reviewTarget));
    addUnique(weightedSampleWithoutReplacement(unseen, q => priorityScore(getQuestionState(state, q.id), ts) + 0.15, newTarget));

    if (selected.length < batchSize) {
      const leftovers = candidates.filter(q => !selectedIds.has(q.id));
      addUnique(weightedSampleWithoutReplacement(leftovers, q => priorityScore(getQuestionState(state, q.id), ts), batchSize - selected.length));
    }

    return shuffle(selected).slice(0, batchSize);
  }

  function createBatch(dataset, state, filters, batchSize = 12) {
    const questions = buildBatchQuestions(dataset, state, filters, batchSize);
    if (!questions.length) return null;
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const questionIds = questions.map(q => q.id);
    return {
      id: batchId,
      createdAt: nowTs(),
      filters: { ...filters },
      batchSize,
      questionIds,
      currentPool: shuffle(questionIds),
      retryPoolNext: [],
      round: 1,
      currentIndex: 0,
      currentQuestionId: questionIds[0],
      resolvedIds: [],
      incorrectIds: [],
      attemptsByQuestion: {},
      firstPassCorrectIds: [],
      answerLog: [],
      completed: false,
      summary: null
    };
  }

  function uniq(arr) {
    return [...new Set(arr)];
  }

  function ensureBatchQuestionPointer(batch) {
    if (!batch) return batch;
    if (!batch.currentPool.length) {
      batch.currentQuestionId = null;
      return batch;
    }
    batch.currentIndex = Math.min(batch.currentIndex, batch.currentPool.length - 1);
    batch.currentQuestionId = batch.currentPool[batch.currentIndex] || null;
    return batch;
  }

  function finalizeBatch(state, batch) {
    const totalAttempts = Object.values(batch.attemptsByQuestion || {}).reduce((sum, n) => sum + n, 0);
    const firstPassCorrect = (batch.firstPassCorrectIds || []).length;
    const recycled = uniq(batch.incorrectIds || []).length;
    const summary = {
      id: batch.id,
      completedAt: nowTs(),
      totalQuestions: batch.questionIds.length,
      totalAttempts,
      rounds: batch.round,
      firstPassCorrect,
      recycled,
      accuracyFirstPass: batch.questionIds.length ? firstPassCorrect / batch.questionIds.length : 0,
      filters: batch.filters,
      questionIds: batch.questionIds,
      incorrectIds: uniq(batch.incorrectIds || []),
      answerLog: batch.answerLog
    };
    batch.completed = true;
    batch.summary = summary;
    state.batchHistory.unshift(summary);
    state.batchHistory = state.batchHistory.slice(0, 80);
    state.session.batchesCompleted += 1;
    state.session.currentBatchId = null;
    state.currentBatch = batch;
    return summary;
  }

  function advanceBatch(dataset, state, batch, questionId, correct) {
    if (!batch || batch.completed) return { status: 'missing' };
    batch.attemptsByQuestion[questionId] = (batch.attemptsByQuestion[questionId] || 0) + 1;
    batch.answerLog.push({ questionId, correct, at: nowTs(), round: batch.round, attempt: batch.attemptsByQuestion[questionId] });

    if (correct) {
      if (batch.attemptsByQuestion[questionId] === 1) batch.firstPassCorrectIds.push(questionId);
      if (!batch.resolvedIds.includes(questionId)) batch.resolvedIds.push(questionId);
    } else {
      batch.incorrectIds.push(questionId);
      batch.retryPoolNext.push(questionId);
      batch.resolvedIds = batch.resolvedIds.filter(id => id !== questionId);
    }

    batch.currentIndex += 1;

    if (batch.currentIndex >= batch.currentPool.length) {
      const retryPool = uniq(batch.retryPoolNext);
      if (retryPool.length) {
        batch.round += 1;
        batch.currentPool = shuffle(retryPool);
        batch.retryPoolNext = [];
        batch.currentIndex = 0;
      } else {
        const summary = finalizeBatch(state, batch);
        saveState(dataset, state);
        return { status: 'completed', summary, batch };
      }
    }

    ensureBatchQuestionPointer(batch);
    state.session.currentBatchId = batch.id;
    state.currentBatch = batch;
    saveState(dataset, state);
    return { status: 'next', batch };
  }

  function getQuestionMap(dataset) {
    const map = new Map();
    dataset.questions.forEach(q => map.set(q.id, q));
    return map;
  }

  function getStatusTone(qState) {
    if (isMastered(qState)) return 'good';
    if (qState.lastResult === 'incorrect') return 'bad';
    if (!qState.seenCount) return 'new';
    if (isDue(qState)) return 'due';
    return 'neutral';
  }

  window.SachkundeStore = {
    STORAGE_PREFIX,
    DAY_MS,
    datasetFromWindow,
    nowTs,
    todayKey,
    startOfDay,
    addDays,
    normalizeChapterLabel,
    shuffle,
    compareQuestionIds,
    clamp,
    formatPct,
    formatDate,
    formatDue,
    dataKey,
    defaultQuestionState,
    createEmptyState,
    ensureStateShape,
    loadState,
    saveState,
    getQuestionState,
    getAccuracy,
    isMastered,
    isDue,
    overdueDays,
    retentionEstimate,
    priorityScore,
    computeReviewOutcome,
    updateQuestionAfterAnswer,
    weightedSampleWithoutReplacement,
    buildBatchQuestions,
    createBatch,
    advanceBatch,
    getQuestionMap,
    getStatusTone
  };
})();
