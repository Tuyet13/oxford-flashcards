  const STORAGE_KEY = 'oxford_srs_v1';
  const DAILY_NEW_LIMIT = 15;
  const DEFAULT_SPEECH_RATE = 0.92;
  const SPEECH_RATES = [0.7, DEFAULT_SPEECH_RATE, 1.15];

  let state = loadState();
  let sessionQueue = [];
  let queueIndex = 0;
  let isRevealed = false;
  let currentView = 'study';
  let selectedLetter = '';
  let listPage = 0;
  let returnContext = null;
  let showExampleTranslation = false;
  let audioIndex = {};

  function getAudioPaths(sound) {
    const localPath = paths => {
      const path = paths && paths[0];
      return path ? `data/media/${path.split('/').pop()}` : '';
    };
    return {
      audioUK: localPath(sound?.uk),
      audioUS: localPath(sound?.us)
    };
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.cards)) throw new Error('Dữ liệu tiến độ không hợp lệ.');
        if (parsed.date !== todayStr()) {
          parsed.date = todayStr();
          parsed.newToday = 0;
        }
        parsed.speechRate = SPEECH_RATES.includes(Number(parsed.speechRate))
          ? Number(parsed.speechRate)
          : DEFAULT_SPEECH_RATE;
        parsed.cards.forEach(card => { card.forgotten = Boolean(card.forgotten); });
        return parsed;
      } catch (error) {
        setStatus(`Không đọc được tiến độ đã lưu: ${error.message}`);
      }
    }
    return {
      cards: [],
      date: todayStr(),
      newToday: 0,
      speechRate: DEFAULT_SPEECH_RATE
    };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function setStatus(message) {
    const status = document.getElementById('status');
    if (status) status.textContent = message;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function buildQueue(extraNew = 0) {
    const now = Date.now();
    const due = state.cards.filter(card => card.level > 0 && card.nextReview <= now);
    const allowedNew = Math.max(0, DAILY_NEW_LIMIT + extraNew - (state.newToday || 0));
    const freshCandidates = state.cards.filter(card => card.level === 0);
    for (let index = freshCandidates.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [freshCandidates[index], freshCandidates[randomIndex]] = [freshCandidates[randomIndex], freshCandidates[index]];
    }
    const fresh = freshCandidates.slice(0, allowedNew);
    sessionQueue = [...new Map([...due, ...fresh].map(card => [card.w.toLowerCase(), card])).values()];
    queueIndex = 0;
    isRevealed = false;
    showExampleTranslation = false;
    render();
  }

  async function loadAudioIndex() {
    try {
      const response = await fetch('data/oxford-5000.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const entries = await response.json();
      entries.forEach(entry => {
        if (!entry.word || !entry.sound) return;
        audioIndex[entry.word.toLowerCase()] = getAudioPaths(entry.sound);
      });
      state.cards.forEach(card => Object.assign(card, audioIndex[card.w.toLowerCase()] || {}));
      saveState();
    } catch (error) {
      setStatus(`Không tải được dữ liệu phát âm: ${error.message}. Hãy mở trang qua máy chủ cục bộ.`);
    }
  }

  async function loadDataset(dataset) {
    setStatus(`Đang nạp ${dataset}...`);
    try {
      const response = await fetch(`data/${dataset}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error('Dữ liệu JSON không phải danh sách từ.');
      const existing = new Set(state.cards.map(card => card.w.toLowerCase()));
      let added = 0;
      entries.forEach(entry => {
        const word = (typeof entry === 'string' ? entry : entry.word || entry.w || '').trim();
        if (!word || existing.has(word.toLowerCase())) return;
        const pronunciation = audioIndex[word.toLowerCase()] || {};
        state.cards.push({
          w: word,
          pos: entry.pos || '',
          ipa: entry.ipa || '',
          vi: entry.vi || entry.meaning || '',
          ex: entry.ex || entry.example || '',
          ...pronunciation,
          ...getAudioPaths(entry.sound),
          level: 0,
          nextReview: 0,
          forgotten: false
        });
        existing.add(word.toLowerCase());
        added += 1;
      });
      saveState();
      currentView = 'study';
      returnContext = null;
      updateViewButtons();
      buildQueue();
      setStatus(`Đã thêm ${added} từ từ ${dataset}. Tổng kho: ${state.cards.length} từ.`);
    } catch (error) {
      setStatus(`Không nạp được ${dataset}: ${error.message}. Hãy mở trang qua máy chủ cục bộ.`);
    }
  }

  function speak(word, event) {
    if (event) event.stopPropagation();
    const card = state.cards.find(item => item.w === word);
    const audioUrl = card && (card.audioUS || card.audioUK);
    if (audioUrl) {
      const audio = new Audio(audioUrl);
      audio.play().catch(error => {
        setStatus(`Không phát được file âm thanh (${error.message}); dùng phát âm của trình duyệt.`);
        speakWithBrowser(word);
      });
      return;
    }
    speakWithBrowser(word);
  }

  function speakWithBrowser(word, rate = DEFAULT_SPEECH_RATE) {
    if (!('speechSynthesis' in window)) {
      setStatus('Trình duyệt này không hỗ trợ đọc văn bản thành tiếng.');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = rate;
    window.speechSynthesis.speak(utterance);
  }

  function speakExample(text, event) {
    event.stopPropagation();
    speakWithBrowser(text, state.speechRate);
  }

  async function translateExample(card, event) {
    event.stopPropagation();
    if (card.exVi) {
      showExampleTranslation = !showExampleTranslation;
      renderCardContent(card);
      return;
    }

    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<i class="bi bi-hourglass-split" aria-hidden="true"></i> Đang dịch';
    try {
      const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(card.ex)}&langpair=en|vi`);
      if (!response.ok) throw new Error(`Dịch HTTP ${response.status}`);
      const result = await response.json();
      const translation = result.responseData?.translatedText?.trim();
      if (!translation) throw new Error(result.responseDetails || 'Dịch vụ không trả về bản dịch.');
      card.exVi = translation;
      const isCurrentCard = sessionQueue[queueIndex]?.w === card.w;
      if (isCurrentCard) showExampleTranslation = true;
      saveState();
      setStatus('');
      if (isCurrentCard) renderCardContent(card);
    } catch (error) {
      setStatus(`Không dịch được câu ví dụ: ${error.message}`);
      if (sessionQueue[queueIndex]?.w === card.w) renderCardContent(card);
    }
  }

  async function enrichCard(card) {
    if ((card.vi && card.ipa) || card.lookupPending || card.lookupAttempted) return;
    card.lookupPending = true;
    card.lookupAttempted = true;
    const requests = await Promise.allSettled([
      fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(card.w)}`)
        .then(response => { if (!response.ok) throw new Error(`Từ điển HTTP ${response.status}`); return response.json(); }),
      fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(card.w)}&langpair=en|vi`)
        .then(response => { if (!response.ok) throw new Error(`Dịch HTTP ${response.status}`); return response.json(); })
    ]);
    card.lookupPending = false;
    const dict = requests[0].status === 'fulfilled' ? requests[0].value : null;
    const translation = requests[1].status === 'fulfilled' ? requests[1].value : null;
    if (dict && dict[0]) {
      const entry = dict[0];
      card.ipa = entry.phonetic || entry.phonetics?.find(item => item.text)?.text || '';
      const meaning = entry.meanings?.[0];
      if (meaning) {
        card.pos = meaning.partOfSpeech || '';
        card.ex = meaning.definitions?.[0]?.example || meaning.definitions?.[0]?.definition || '';
      }
    }
    if (translation?.responseData?.translatedText) {
      card.vi = translation.responseData.translatedText.toLowerCase();
    }
    if (requests.every(result => result.status === 'rejected')) {
      setStatus(`Không tra được nghĩa cho "${card.w}". Kiểm tra kết nối mạng hoặc thêm nghĩa bằng file.`);
    }
    saveState();
    if (sessionQueue[queueIndex]?.w === card.w) renderCardContent(card);
  }

  function renderCardContent(card) {
    const element = document.getElementById('cardContent');
    if (!element) return;
    element.innerHTML = `
      <span class="badge">${card.level === 0 ? 'Từ mới' : `Ôn cấp ${card.level}`}${card.forgotten ? ' · Cần ôn' : ''}</span>
      <button class="speak-btn" id="speakButton" type="button" aria-label="Phát âm"><i class="bi bi-volume-up-fill" aria-hidden="true"></i></button>
      <div class="word">${escapeHtml(card.w)}</div>
      <div class="ipa">${escapeHtml(card.ipa || 'Chưa có phiên âm')}</div>
      <div class="tap-hint">${isRevealed ? 'Chạm lại để ẩn nghĩa' : 'Chạm vào thẻ để xem nghĩa'}</div>
      <div class="back-content ${isRevealed ? 'show' : ''}">
        <div class="pos">${escapeHtml(card.pos)}</div>
        <div class="meaning">${escapeHtml(card.vi || 'Chưa có nghĩa')}</div>
        ${card.ex ? `<div class="example-block">
          <div class="example">${escapeHtml(card.ex)}</div>
          ${card.exVi && showExampleTranslation ? `<div class="example-translation">${escapeHtml(card.exVi)}</div>` : ''}
          <div class="example-actions">
            <button class="example-speak-btn" id="exampleSpeakButton" type="button" aria-label="Đọc ví dụ"><i class="bi bi-volume-up-fill" aria-hidden="true"></i></button>
            <button class="example-translate-btn" id="exampleTranslateButton" type="button" aria-expanded="${showExampleTranslation}" aria-label="${showExampleTranslation ? 'Ẩn bản dịch' : 'Dịch ví dụ'}"><i class="bi bi-translate" aria-hidden="true"></i><span>${showExampleTranslation ? 'Ẩn dịch' : 'Dịch'}</span></button>
            <label class="example-rate" for="exampleRateSelect">
              <i class="bi bi-speedometer2" aria-hidden="true"></i>
              <span>Tốc độ</span>
              <select id="exampleRateSelect" aria-label="Tốc độ đọc ví dụ">
                <option value="0.7" ${state.speechRate === 0.7 ? 'selected' : ''}>Chậm</option>
                <option value="0.92" ${state.speechRate === 0.92 ? 'selected' : ''}>Vừa</option>
                <option value="1.15" ${state.speechRate === 1.15 ? 'selected' : ''}>Nhanh</option>
              </select>
            </label>
          </div>
        </div>` : ''}
      </div>
    `;
    document.getElementById('speakButton').addEventListener('click', event => speak(card.w, event));
    const exampleSpeakButton = document.getElementById('exampleSpeakButton');
    if (exampleSpeakButton) {
      exampleSpeakButton.addEventListener('click', event => speakExample(card.ex, event));
    }
    const exampleTranslateButton = document.getElementById('exampleTranslateButton');
    if (exampleTranslateButton) {
      exampleTranslateButton.addEventListener('click', event => translateExample(card, event));
    }
    const exampleRateSelect = document.getElementById('exampleRateSelect');
    if (exampleRateSelect) {
      exampleRateSelect.addEventListener('click', event => event.stopPropagation());
      exampleRateSelect.addEventListener('change', event => {
        const rate = Number(event.currentTarget.value);
        if (!SPEECH_RATES.includes(rate)) {
          setStatus('Tốc độ đọc không hợp lệ.');
          return;
        }
        state.speechRate = rate;
        saveState();
      });
    }
  }

  function render() {
    const mastered = state.cards.filter(card => card.level >= 3).length;
    const learned = state.cards.filter(card => card.level > 0 && !card.forgotten).length;
    const forgotten = state.cards.filter(card => card.forgotten).length;
    document.getElementById('stats').innerHTML =
      `Cần học: <b>${sessionQueue.length}</b> · Đã học: <b>${learned}</b> · Thuộc: <b>${mastered}</b> · Đã quên: <b>${forgotten}</b>`;
    const main = document.getElementById('mainArea');
    const controls = document.getElementById('controls');
    const letters = document.getElementById('letters');

    if (currentView !== 'study') {
      controls.innerHTML = '';
      if (currentView === 'browse') {
        renderLetters(letters);
        renderWordList(main, state.cards);
      } else {
        letters.hidden = true;
        renderWordList(main, state.cards.filter(card =>
          currentView === 'learned' ? card.level > 0 && !card.forgotten : card.forgotten
        ));
      }
      return;
    }

    letters.hidden = true;
    if (sessionQueue.length === 0) {
      if (state.cards.length === 0) {
        main.innerHTML = '<div class="empty">Đang tải từ vựng Oxford 3000...</div>';
        controls.innerHTML = '';
        return;
      }
      main.innerHTML = `<div class="empty"><div class="empty-icon"><i class="bi bi-stars" aria-hidden="true"></i></div><strong>Đã hoàn thành lượt học!</strong><br>Tổng kho hiện có ${state.cards.length} từ.</div>`;
      controls.innerHTML = `
        <button type="button" class="btn-action btn-show" onclick="buildQueue(10)">+ Học thêm 10 từ mới</button>
        ${returnContext ? '<button type="button" class="btn-back" onclick="returnToList()"><i class="bi bi-arrow-left" aria-hidden="true"></i> Quay lại danh sách</button>' : ''}
      `;
      return;
    }

    const current = sessionQueue[queueIndex];
    if (!current.vi || !current.ipa) enrichCard(current);
    main.innerHTML = `<div class="card" id="cardContent" role="button" tabindex="0" aria-label="${isRevealed ? 'Chạm để ẩn nghĩa' : 'Chạm để xem nghĩa'}"></div>`;
    const cardElement = document.getElementById('cardContent');
    cardElement.addEventListener('click', toggleCardAnswer);
    cardElement.addEventListener('keydown', event => {
      if (event.target !== cardElement && event.target.closest('button, select, input, textarea')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleCardAnswer();
      }
    });
    renderCardContent(current);

    const navigation = `
      <button type="button" class="btn-nav" onclick="navigateCard(-1)" ${queueIndex === 0 ? 'disabled' : ''} aria-label="Từ trước"><i class="bi bi-chevron-left" aria-hidden="true"></i> Từ trước</button>
      <button type="button" class="btn-nav" onclick="navigateCard(1)" ${queueIndex === sessionQueue.length - 1 ? 'disabled' : ''} aria-label="Từ tiếp theo">Từ tiếp <i class="bi bi-chevron-right" aria-hidden="true"></i></button>
    `;
    const backButton = returnContext
      ? '<button type="button" class="btn-back" onclick="returnToList()"><i class="bi bi-arrow-left" aria-hidden="true"></i> Quay lại danh sách</button>'
      : '';
    if (!isRevealed) {
      controls.innerHTML = `${navigation}
        <button type="button" class="btn-action btn-show" onclick="toggleCardAnswer()">Xem đáp án</button>
        ${backButton}
      `;
    } else {
      const nextDays = [1, 2, 4, 7, 15, 30][Math.min(current.level, 5)];
      controls.innerHTML = `${navigation}
        <button type="button" class="btn-action btn-forgot" onclick="answer(false)">Quên <span>Đánh dấu để ôn lại</span></button>
        <button type="button" class="btn-action btn-know" onclick="answer(true)">Nhớ <span>Ôn lại sau ${nextDays} ngày</span></button>
        ${backButton}
      `;
    }
  }

  function renderLetters(container) {
    const available = [...new Set(state.cards.map(card => card.w[0]?.toUpperCase()).filter(letter => /^[A-Z]$/.test(letter)))].sort();
    if (!selectedLetter) selectedLetter = available[0] || '';
    container.hidden = false;
    container.innerHTML = available.map(letter =>
      `<button type="button" data-letter="${letter}" class="${selectedLetter === letter ? 'active' : ''}">${letter}</button>`
    ).join('');
    container.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
      selectedLetter = button.dataset.letter;
      listPage = 0;
      render();
    }));
  }

  function renderWordList(container, cards) {
    const filtered = cards
      .filter(card => !selectedLetter || card.w[0]?.toUpperCase() === selectedLetter)
      .sort((a, b) => a.w.localeCompare(b.w));
    if (filtered.length === 0) {
      const message = currentView === 'learned'
        ? 'Chưa có từ nào được ghi nhớ.'
        : currentView === 'forgotten' ? 'Chưa có từ nào được đánh dấu là đã quên.' : 'Không có từ nào ở chữ cái này.';
      container.innerHTML = `<div class="empty">${message}</div>`;
      return;
    }
    const pageSize = 50;
    const pageCount = Math.ceil(filtered.length / pageSize);
    listPage = Math.min(listPage, pageCount - 1);
    const pageCards = filtered.slice(listPage * pageSize, (listPage + 1) * pageSize);
    const groups = new Map();
    pageCards.forEach(card => {
      const letter = card.w[0]?.toUpperCase() || '#';
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(card);
    });
    container.innerHTML = `<div class="word-list">${[...groups].map(([letter, words]) => `
      <section class="letter-group">
        <h2>${escapeHtml(letter)}</h2>
        ${words.map((card, index) => `
          <div class="word-row">
            <div class="word-row-main"><strong>${escapeHtml(card.w)}</strong>
              <span class="translation">${escapeHtml(card.vi || card.ipa || 'Chưa tra nghĩa')}</span>
            </div>
            <button type="button" data-word="${escapeHtml(card.w)}" aria-label="Ôn ${escapeHtml(card.w)}">Ôn từ</button>
          </div>
        `).join('')}
      </section>
    `).join('')}
      ${pageCount > 1 ? `<div class="pagination">
        <button type="button" data-page="${listPage - 1}" ${listPage === 0 ? 'disabled' : ''}>Trước</button>
        <span>${listPage + 1} / ${pageCount} · ${filtered.length} từ</span>
        <button type="button" data-page="${listPage + 1}" ${listPage === pageCount - 1 ? 'disabled' : ''}>Tiếp</button>
      </div>` : ''}
    </div>`;
    container.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
      listPage = Number(button.dataset.page);
      render();
    }));
    container.querySelectorAll('[data-word]').forEach(button => button.addEventListener('click', () => {
      const selected = state.cards.find(card => card.w === button.dataset.word);
      if (!selected) return;
      returnContext = { view: currentView, letter: selectedLetter, page: listPage };
      currentView = 'study';
      sessionQueue = filtered;
      queueIndex = sessionQueue.findIndex(card => card.w === selected.w);
      isRevealed = false;
      showExampleTranslation = false;
      updateViewButtons();
      render();
    }));
  }

  function navigateCard(direction) {
    const targetIndex = queueIndex + direction;
    if (targetIndex < 0 || targetIndex >= sessionQueue.length) return;
    queueIndex = targetIndex;
    isRevealed = false;
    showExampleTranslation = false;
    render();
  }

  function returnToList() {
    if (!returnContext) return;
    currentView = returnContext.view;
    selectedLetter = returnContext.letter;
    listPage = returnContext.page;
    returnContext = null;
    updateViewButtons();
    render();
  }

  function toggleCardAnswer() {
    if (sessionQueue.length === 0) return;
    isRevealed = !isRevealed;
    if (isRevealed) {
      speak(sessionQueue[queueIndex].w);
    } else if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    render();
  }

  function answer(remembered) {
    const card = sessionQueue[queueIndex];
    if (!card) return;
    if (card.level === 0) state.newToday = (state.newToday || 0) + 1;
    if (remembered) {
      card.level += 1;
      const days = [1, 2, 4, 7, 15, 30][Math.min(card.level - 1, 5)];
      card.nextReview = Date.now() + days * 86400000;
      card.forgotten = false;
    } else {
      card.level = Math.max(1, card.level);
      card.nextReview = Date.now();
      card.forgotten = true;
    }
    sessionQueue.splice(queueIndex, 1);
    if (!remembered && currentView === 'study') {
      sessionQueue.splice(Math.min(queueIndex + 3, sessionQueue.length), 0, card);
    }
    if (queueIndex >= sessionQueue.length) queueIndex = Math.max(0, sessionQueue.length - 1);
    isRevealed = false;
    showExampleTranslation = false;
    saveState();
    render();
  }

  function parseAndAdd(rawText) {
    const existing = new Set(state.cards.map(card => card.w.toLowerCase()));
    let entries;
    try {
      const parsed = JSON.parse(rawText);
      if (!Array.isArray(parsed)) throw new Error('JSON cần có định dạng danh sách.');
      entries = parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        entries = rawText.split(/\r?\n/).map(line => {
          const parts = line.split(/[,;\t]/);
          return { w: parts[0]?.replace(/["']/g, '').trim(), vi: parts[1]?.replace(/["']/g, '').trim() || '' };
        });
      } else {
        setStatus(error.message);
        return;
      }
    }
    let added = 0;
    entries.forEach(entry => {
      const word = (typeof entry === 'string' ? entry : entry.w || entry.word || '').trim();
      if (!word || existing.has(word.toLowerCase())) return;
      state.cards.push({
        w: word,
        pos: entry.pos || '',
        ipa: entry.ipa || '',
        vi: entry.vi || entry.meaning || '',
        ex: entry.ex || entry.example || '',
        ...(audioIndex[word.toLowerCase()] || {}),
        ...getAudioPaths(entry.sound),
        level: Number(entry.level) || 0,
        nextReview: Number(entry.nextReview) || 0,
        forgotten: Boolean(entry.forgotten)
      });
      existing.add(word.toLowerCase());
      added += 1;
    });
    saveState();
    currentView = 'study';
    updateViewButtons();
    buildQueue();
    setStatus(`Đã thêm ${added} từ. Tổng kho: ${state.cards.length} từ.`);
    closeModal();
  }

  function handleFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => parseAndAdd(String(reader.result || ''));
    reader.onerror = () => setStatus(`Không đọc được file: ${reader.error?.message || 'lỗi không xác định'}`);
    reader.readAsText(file);
    event.target.value = '';
  }

  async function exportBackup() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.cards));
      setStatus('Đã sao chép toàn bộ từ và tiến độ vào clipboard.');
    } catch (error) {
      setStatus(`Không sao chép được backup: ${error.message}`);
    }
  }

  function updateViewButtons() {
    document.querySelectorAll('[data-view]').forEach(button => {
      button.classList.toggle('active', button.dataset.view === currentView);
    });
  }

  function openModal() { document.getElementById('modal').classList.add('open'); }
  function closeModal() { document.getElementById('modal').classList.remove('open'); }

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    currentView = button.dataset.view;
    returnContext = null;
    listPage = 0;
    selectedLetter = currentView === 'browse'
      ? [...new Set(state.cards.map(card => card.w[0]?.toUpperCase()).filter(letter => /^[A-Z]$/.test(letter)))].sort()[0] || ''
      : '';
    updateViewButtons();
    if (currentView === 'study') buildQueue();
    else render();
  }));
  document.getElementById('fileInput').addEventListener('change', handleFile);
  document.getElementById('importButton').addEventListener('click', () => {
    const value = document.getElementById('bulkText').value.trim();
    if (value) parseAndAdd(value);
    document.getElementById('bulkText').value = '';
  });
  document.getElementById('exportButton').addEventListener('click', exportBackup);
  document.addEventListener('keydown', event => {
    if (document.getElementById('modal').classList.contains('open')) {
      if (event.key === 'Escape') closeModal();
      return;
    }
    if (currentView !== 'study') return;
    if (event.code === 'Space') { event.preventDefault(); toggleCardAnswer(); }
    if (event.key === 'ArrowLeft') navigateCard(-1);
    if (event.key === 'ArrowRight') navigateCard(1);
    if (event.key === '1' && isRevealed) answer(false);
    if (event.key === '2' && isRevealed) answer(true);
  });

  if (state.cards.length === 0) {
    setStatus('Đang nạp Oxford 3000...');
    loadDataset('oxford-3000');
  } else {
    buildQueue();
  }
  loadAudioIndex();
