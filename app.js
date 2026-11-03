/* Xeneon Planner - 위젯 로직
   v01.00 (2026-11-03)

   URL 파라미터
     api        (필수) GAS 웹앱 배포 주소 (…/exec)
     key        (필수) GAS 스크립트 속성 SECRET_KEY 와 같은 값
     days       조회 일수, 기본 2 (오늘·내일), 최대 14
     tz         시간대, 기본 Asia/Seoul
     calendars  표시할 캘린더 ID 또는 이름을 쉼표로 (생략 시 전체)
     refresh    자동 갱신 주기(초), 기본 60, 최소 20
     theme      dark | light, 기본 dark
     scale      글자 배율, 예 1.1 (기본 1)
     add        1 이면 할일 추가 입력창 표시 (기본 숨김)
     done       0 이면 최근 완료 항목 숨김 (기본 표시)
     list       처음 선택할 할일 목록 이름
*/
(function () {
  'use strict';

  // ------------------------------------------------------------
  // 설정
  // ------------------------------------------------------------
  var qs = new URLSearchParams(location.search);
  var CFG = {
    api: (qs.get('api') || '').trim(),
    key: (qs.get('key') || '').trim(),
    days: clamp(parseInt(qs.get('days') || '2', 10) || 2, 1, 14),
    tz: qs.get('tz') || 'Asia/Seoul',
    calendars: qs.get('calendars') || '',
    refresh: Math.max(20, parseInt(qs.get('refresh') || '60', 10) || 60),
    theme: qs.get('theme') === 'light' ? 'light' : 'dark',
    scale: parseFloat(qs.get('scale') || '1') || 1,
    add: qs.get('add') === '1',
    showDone: qs.get('done') !== '0',
    list: qs.get('list') || ''
  };
  var CACHE_KEY = 'xeneon-planner-cache-v1';
  var LIST_KEY = 'xeneon-planner-list';

  var state = {
    data: null,
    activeList: 'all',
    lastFetch: 0,
    error: '',
    busy: {}
  };

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    app: $('app'), clockTime: $('clock-time'), clockDate: $('clock-date'),
    next: $('next-event'), calBody: $('cal-body'),
    tabs: $('task-tabs'), summary: $('task-summary'), taskBody: $('task-body'),
    addForm: $('task-add'), addList: $('add-list'), addTitle: $('add-title'),
    status: $('status'), statusText: $('status-text'), refreshBtn: $('refresh-btn'),
    setup: $('setup'), setupSample: $('setup-sample')
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // ------------------------------------------------------------
  // 레이아웃 분기 (뷰포트 = 위젯 크기)
  // ------------------------------------------------------------
  function applyLayout() {
    var w = window.innerWidth, h = window.innerHeight;
    var b = document.body;
    b.classList.toggle('h-short', h <= 400);
    b.classList.toggle('w-narrow', w <= 1000);
    b.classList.toggle('w-wide', w >= 1400);
    b.classList.toggle('portrait', h > w);
    b.classList.toggle('cols-2', w >= 1400 && h >= 480 && CFG.days >= 2);
    b.style.fontSize = 'calc(var(--fs) * ' + CFG.scale + ')';
  }

  // ------------------------------------------------------------
  // 날짜 유틸 (모두 CFG.tz 기준)
  // ------------------------------------------------------------
  var fmtTime = new Intl.DateTimeFormat('ko-KR', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hour12: false });
  var fmtDateLong = new Intl.DateTimeFormat('ko-KR', { timeZone: CFG.tz, month: 'long', day: 'numeric', weekday: 'short' });
  var fmtDateShort = new Intl.DateTimeFormat('ko-KR', { timeZone: CFG.tz, month: 'numeric', day: 'numeric', weekday: 'short' });
  var fmtYmd = new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit' });

  function ymd(d) { return fmtYmd.format(d); }               // 'YYYY-MM-DD'
  function todayYmd() { return ymd(new Date()); }
  function addDaysYmd(base, n) {
    var p = base.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.toISOString().slice(0, 10);
  }
  function hhmm(iso) { return fmtTime.format(new Date(iso)); }
  function dayLabel(y) {
    var t = todayYmd();
    if (y === t) return '오늘';
    if (y === addDaysYmd(t, 1)) return '내일';
    if (y === addDaysYmd(t, 2)) return '모레';
    return fmtDateShort.format(new Date(y + 'T12:00:00Z'));
  }
  function daySub(y) { return fmtDateLong.format(new Date(y + 'T12:00:00Z')); }
  function minutesText(mins) {
    if (mins < 1) return '곧 시작';
    if (mins < 60) return mins + '분 후';
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24) return h + '시간' + (m ? ' ' + m + '분' : '') + ' 후';
    var d = Math.floor(h / 24);
    return d + '일 후';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------
  // 시계
  // ------------------------------------------------------------
  function tickClock() {
    var now = new Date();
    el.clockTime.textContent = fmtTime.format(now);
    el.clockDate.textContent = fmtDateLong.format(now);
  }

  // ------------------------------------------------------------
  // 데이터 호출
  // ------------------------------------------------------------
  function buildGetUrl() {
    var u = new URL(CFG.api);
    u.searchParams.set('key', CFG.key);
    u.searchParams.set('days', String(CFG.days));
    u.searchParams.set('tz', CFG.tz);
    if (CFG.calendars) u.searchParams.set('calendars', CFG.calendars);
    u.searchParams.set('_', String(Date.now())); // 캐시 우회
    return u.toString();
  }

  function fetchData() {
    el.refreshBtn.classList.add('spin');
    setStatus('갱신 중');
    return fetch(buildGetUrl(), { method: 'GET', redirect: 'follow', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.ok) throw new Error(json.error || '응답 오류');
        state.data = json;
        state.lastFetch = Date.now();
        state.error = '';
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: state.lastFetch, data: json })); } catch (e) { /* 무시 */ }
        renderAll();
        var warn = [];
        if (json.calendarError) warn.push('캘린더: ' + json.calendarError);
        if (json.tasksError) warn.push('할일: ' + json.tasksError);
        setStatus(warn.length ? warn.join(' / ') : '갱신 ' + fmtTime.format(new Date(state.lastFetch)), warn.length > 0);
      })
      .catch(function (err) {
        state.error = String(err && err.message || err);
        setStatus('갱신 실패: ' + state.error + (state.data ? ' (마지막 데이터 표시 중)' : ''), true);
        if (!state.data) {
          el.calBody.innerHTML = '<div class="empty">데이터를 가져오지 못했습니다.<br>' + escapeHtml(state.error) + '</div>';
          el.taskBody.innerHTML = '';
        }
      })
      .then(function () { el.refreshBtn.classList.remove('spin'); });
  }

  function postAction(payload) {
    payload.key = CFG.key;
    // text/plain 으로 보내야 preflight(OPTIONS) 없이 GAS 에 도달한다
    return fetch(CFG.api, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.ok) throw new Error(json.error || '요청 실패');
        return json;
      });
  }

  function setStatus(text, isError) {
    el.statusText.textContent = text;
    el.status.classList.toggle('error', !!isError);
  }

  // ------------------------------------------------------------
  // 렌더링: 캘린더
  // ------------------------------------------------------------
  function renderAll() {
    renderNext();
    renderCalendar();
    renderTabs();
    renderTasks();
    renderAddForm();
  }

  function timedEvents() {
    return (state.data.events || []).filter(function (e) { return !e.allDay; });
  }

  function renderNext() {
    var now = Date.now();
    var upcoming = timedEvents().filter(function (e) {
      return e.responseStatus !== 'declined' && new Date(e.end).getTime() > now;
    });
    el.next.classList.remove('soon', 'live');
    var t = el.next.querySelector('.next-title'), w = el.next.querySelector('.next-when');
    if (!upcoming.length) {
      t.textContent = '예정된 일정 없음';
      w.textContent = CFG.days === 1 ? '오늘' : CFG.days + '일 내';
      return;
    }
    var ev = upcoming[0];
    var start = new Date(ev.start).getTime(), end = new Date(ev.end).getTime();
    t.textContent = ev.title;
    if (start <= now) {
      el.next.classList.add('live');
      w.textContent = '진행 중 · ' + hhmm(ev.start) + '–' + hhmm(ev.end) + ' (' + minutesText(Math.round((end - now) / 60000)).replace(' 후', ' 남음') + ')';
    } else {
      var mins = Math.round((start - now) / 60000);
      if (mins <= 15) el.next.classList.add('soon');
      var prefix = ymd(new Date(ev.start)) === todayYmd() ? '' : dayLabel(ymd(new Date(ev.start))) + ' ';
      w.textContent = prefix + hhmm(ev.start) + ' · ' + minutesText(mins);
    }
  }

  function renderCalendar() {
    var events = state.data.events || [];
    var byDay = {};
    var t = todayYmd();
    for (var i = 0; i < CFG.days; i++) byDay[addDaysYmd(t, i)] = [];

    events.forEach(function (e) {
      if (e.allDay) {
        // 종일 일정: 시작일~종료일(배타) 사이 모든 날짜에 표시
        var d = e.start, endEx = e.end;
        var guard = 0;
        while (d < endEx && guard++ < 31) {
          if (byDay[d]) byDay[d].push(e);
          d = addDaysYmd(d, 1);
        }
      } else {
        var k = ymd(new Date(e.start));
        if (byDay[k]) byDay[k].push(e);
      }
    });

    var now = Date.now();
    var html = '<div class="cal-grid">';
    Object.keys(byDay).forEach(function (day) {
      var list = byDay[day];
      html += '<section class="day"><div class="day-title">' + escapeHtml(dayLabel(day)) +
        '<span class="sub">' + escapeHtml(daySub(day)) + '</span>' +
        '<span class="cnt">' + list.length + '건</span></div>';
      if (!list.length) {
        html += '<div class="empty">일정 없음</div></section>';
        return;
      }
      var nowDrawn = day !== t; // 오늘만 현재 시각 선 표시
      list.forEach(function (e) {
        var s = e.allDay ? 0 : new Date(e.start).getTime();
        var en = e.allDay ? 0 : new Date(e.end).getTime();
        if (!nowDrawn && !e.allDay && s > now) { html += '<div class="now-line"></div>'; nowDrawn = true; }
        var cls = 'ev' + (e.allDay ? ' allday' : '') +
          (!e.allDay && en <= now ? ' past' : '') +
          (!e.allDay && s <= now && en > now ? ' live' : '');
        var tags = '';
        if (e.meetingLink) tags += '<span class="tag meet">화상</span>';
        if (e.responseStatus === 'declined') tags += '<span class="tag declined">거절</span>';
        if (e.responseStatus === 'tentative') tags += '<span class="tag tentative">미정</span>';
        if (e.responseStatus === 'needsAction') tags += '<span class="tag">미응답</span>';
        html += '<div class="' + cls + '">' +
          '<div class="ev-bar" style="background:' + escapeHtml(e.color) + '"></div>' +
          '<div class="ev-time">' + (e.allDay ? '종일' : '<b>' + hhmm(e.start) + '</b><br>' + hhmm(e.end)) + '</div>' +
          '<div class="ev-main"><div class="ev-title">' + escapeHtml(e.title) + '</div>' +
          (e.location ? '<div class="ev-loc">' + escapeHtml(e.location) + '</div>' : '') + '</div>' +
          '<div class="ev-tags">' + tags + '</div></div>';
      });
      if (!nowDrawn) html += '<div class="now-line"></div>';
      html += '</section>';
    });
    html += '</div>';
    el.calBody.innerHTML = html;
  }

  // ------------------------------------------------------------
  // 렌더링: 할일
  // ------------------------------------------------------------
  function visibleTasks() {
    var tasks = state.data.tasks || [];
    if (state.activeList !== 'all') tasks = tasks.filter(function (t) { return t.listId === state.activeList; });
    return tasks;
  }

  function renderTabs() {
    var lists = state.data.taskLists || [];
    var counts = {};
    (state.data.tasks || []).forEach(function (t) {
      if (t.status !== 'needsAction') return;
      counts[t.listId] = (counts[t.listId] || 0) + 1;
      counts.all = (counts.all || 0) + 1;
    });
    // 처음 선택 목록: 저장값 > ?list= > 전체
    if (!state.tabsInit) {
      state.tabsInit = true;
      var saved = '';
      try { saved = localStorage.getItem(LIST_KEY) || ''; } catch (e) { /* 무시 */ }
      var byName = lists.filter(function (l) { return l.title === CFG.list; })[0];
      if (saved && (saved === 'all' || lists.some(function (l) { return l.id === saved; }))) state.activeList = saved;
      else if (byName) state.activeList = byName.id;
    }
    var html = '<button type="button" class="tab' + (state.activeList === 'all' ? ' active' : '') + '" data-list="all">전체<span class="n">' + (counts.all || 0) + '</span></button>';
    lists.forEach(function (l) {
      html += '<button type="button" class="tab' + (state.activeList === l.id ? ' active' : '') + '" data-list="' + escapeHtml(l.id) + '">' +
        escapeHtml(l.title) + '<span class="n">' + (counts[l.id] || 0) + '</span></button>';
    });
    el.tabs.innerHTML = html;
  }

  function renderTasks() {
    var t = todayYmd();
    var groups = { overdue: [], today: [], upcoming: [], nodue: [], done: [] };
    var listName = {};
    (state.data.taskLists || []).forEach(function (l) { listName[l.id] = l.title; });

    visibleTasks().forEach(function (task) {
      if (task.status === 'completed') { if (CFG.showDone) groups.done.push(task); return; }
      if (!task.due) { groups.nodue.push(task); return; }
      var d = task.due.slice(0, 10); // Tasks API 의 due 는 날짜만 유효
      if (d < t) groups.overdue.push(task);
      else if (d === t) groups.today.push(task);
      else groups.upcoming.push(task);
    });

    var overdueAll = 0, todayAll = 0;
    (state.data.tasks || []).forEach(function (task) {
      if (task.status !== 'needsAction' || !task.due) return;
      var d = task.due.slice(0, 10);
      if (d < t) overdueAll++; else if (d === t) todayAll++;
    });
    el.summary.innerHTML = (overdueAll ? '<b>지연 ' + overdueAll + '</b> · ' : '') + '오늘 ' + todayAll;

    var order = [
      ['overdue', '기한 지남'], ['today', '오늘'], ['upcoming', '예정'], ['nodue', '기한 없음'], ['done', '최근 완료']
    ];
    var html = '';
    var total = 0;
    order.forEach(function (pair) {
      var key = pair[0], list = groups[key];
      if (!list.length) return;
      total += list.length;
      html += '<section class="tsec ' + key + '"><div class="tsec-title">' + pair[1] + ' · ' + list.length + '</div>';
      list.forEach(function (task) {
        var due = task.due ? task.due.slice(0, 10) : '';
        var dueText = '';
        if (due) {
          var diff = Math.round((Date.UTC.apply(null, due.split('-').map(Number).map(function (v, i) { return i === 1 ? v - 1 : v; })) -
            Date.UTC.apply(null, t.split('-').map(Number).map(function (v, i) { return i === 1 ? v - 1 : v; }))) / 86400000);
          if (diff === 0) dueText = '오늘';
          else if (diff === 1) dueText = '내일';
          else if (diff < 0) dueText = (-diff) + '일 지남';
          else dueText = due.slice(5).replace('-', '/') + ' (' + diff + '일)';
        }
        var cls = 'task' + (task.status === 'completed' ? ' done' : '') + (task.parent ? ' sub' : '') + (state.busy[task.id] ? ' busy' : '');
        html += '<div class="' + cls + '" data-id="' + escapeHtml(task.id) + '" data-list="' + escapeHtml(task.listId) + '">' +
          '<button type="button" class="chk" aria-label="완료 전환"><span>' + (task.status === 'completed' ? '✓' : '') + '</span></button>' +
          '<div class="task-main"><div class="task-title">' + escapeHtml(task.title) + '</div>' +
          '<div class="task-meta">' + (state.activeList === 'all' ? '<span class="list">' + escapeHtml(listName[task.listId] || '') + '</span>' : '') +
          (task.notes ? (state.activeList === 'all' ? ' · ' : '') + escapeHtml(task.notes.split('\n')[0]) : '') + '</div></div>' +
          '<div class="task-due">' + escapeHtml(dueText) + '</div></div>';
      });
      html += '</section>';
    });
    el.taskBody.innerHTML = total ? html : '<div class="empty">할일 없음</div>';
  }

  function renderAddForm() {
    el.addForm.hidden = !CFG.add;
    if (!CFG.add) return;
    var lists = state.data.taskLists || [];
    var cur = el.addList.value;
    el.addList.innerHTML = lists.map(function (l) {
      return '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.title) + '</option>';
    }).join('');
    if (cur && lists.some(function (l) { return l.id === cur; })) el.addList.value = cur;
    else if (state.activeList !== 'all') el.addList.value = state.activeList;
  }

  // ------------------------------------------------------------
  // 상호작용
  // ------------------------------------------------------------
  el.tabs.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.tab');
    if (!btn) return;
    state.activeList = btn.getAttribute('data-list');
    try { localStorage.setItem(LIST_KEY, state.activeList); } catch (e) { /* 무시 */ }
    renderTabs(); renderTasks(); renderAddForm();
  });

  el.taskBody.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.chk');
    if (!btn) return;
    var row = btn.closest('.task');
    var id = row.getAttribute('data-id'), listId = row.getAttribute('data-list');
    var task = (state.data.tasks || []).filter(function (t) { return t.id === id; })[0];
    if (!task || state.busy[id]) return;

    var toCompleted = task.status !== 'completed';
    var prev = { status: task.status, completed: task.completed };
    // 낙관적 갱신
    task.status = toCompleted ? 'completed' : 'needsAction';
    task.completed = toCompleted ? new Date().toISOString() : '';
    state.busy[id] = true;
    renderTabs(); renderTasks();

    postAction({ action: toCompleted ? 'complete' : 'uncomplete', listId: listId, taskId: id })
      .then(function () {
        delete state.busy[id];
        setStatus((toCompleted ? '완료: ' : '되돌림: ') + task.title);
        renderTabs(); renderTasks();
      })
      .catch(function (err) {
        task.status = prev.status; task.completed = prev.completed;
        delete state.busy[id];
        setStatus('처리 실패: ' + (err && err.message || err), true);
        renderTabs(); renderTasks();
      });
  });

  el.addForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var title = el.addTitle.value.trim();
    var listId = el.addList.value;
    if (!title || !listId) return;
    el.addTitle.value = '';
    setStatus('추가 중: ' + title);
    postAction({ action: 'add', listId: listId, title: title })
      .then(function () { setStatus('추가됨: ' + title); return fetchData(); })
      .catch(function (err) { setStatus('추가 실패: ' + (err && err.message || err), true); });
  });

  el.refreshBtn.addEventListener('click', function () { fetchData(); });

  // ------------------------------------------------------------
  // 시작
  // ------------------------------------------------------------
  function start() {
    document.documentElement.setAttribute('data-theme', CFG.theme);
    applyLayout();
    window.addEventListener('resize', applyLayout);
    tickClock();
    setInterval(tickClock, 1000);

    if (!CFG.api || !CFG.key) {
      el.setup.hidden = false;
      var base = location.origin + location.pathname;
      el.setupSample.textContent =
        '<iframe src="' + base + '?api=https://script.google.com/macros/s/배포ID/exec&key=비밀키" ' +
        'style="width:100%;height:100%;border:0"></iframe>';
      return;
    }

    // 캐시가 있으면 먼저 그려서 빈 화면 시간을 줄인다
    try {
      var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.data) {
        state.data = cached.data;
        state.lastFetch = cached.t;
        renderAll();
        setStatus('캐시 표시 중 (' + fmtTime.format(new Date(cached.t)) + ')');
      }
    } catch (e) { /* 무시 */ }

    fetchData();
    setInterval(fetchData, CFG.refresh * 1000);
    // 다음 일정 카운트다운과 지난 일정 흐림 처리는 30초마다 다시 그린다
    setInterval(function () { if (state.data) { renderNext(); renderCalendar(); } }, 30000);
    // 날짜가 바뀌면 전체 갱신
    var lastDay = todayYmd();
    setInterval(function () {
      var d = todayYmd();
      if (d !== lastDay) { lastDay = d; fetchData(); }
    }, 60000);
  }

  start();
})();
