/* Xeneon Planner - 위젯 로직
   v01.03 (2026-11-17)

   URL 파라미터
     api        (필수) GAS 웹앱 배포 주소 (…/exec)
     key        (필수) GAS 스크립트 속성 SECRET_KEY 와 같은 값
     view       both | calendar | tasks   (기본 both)   ← v01.01
     range      day | week | month        (기본 day, 캘린더 초기 범위) ← v01.01
     cols       할일 전용 보기의 열 수 2~4 (기본 3) ← v01.01
     group      all | overdue | today | upcoming | nodue  (기본 all, 할일 초기 구분) ← v01.03
     weekstart  mon | sun (기본 mon, 주·월 보기 시작 요일) ← v01.01
     days       일 보기 조회 일수, 기본 2 (오늘·내일), 최대 14
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
  function pick(v, allowed, def) { return allowed.indexOf(v) >= 0 ? v : def; }
  var CFG = {
    api: (qs.get('api') || '').trim(),
    key: (qs.get('key') || '').trim(),
    view: pick(qs.get('view'), ['both', 'calendar', 'tasks'], 'both'),
    range: pick(qs.get('range'), ['day', 'week', 'month'], 'day'),
    cols: clamp(parseInt(qs.get('cols') || '3', 10) || 3, 2, 4),
    group: pick(qs.get('group'), ['all', 'overdue', 'today', 'upcoming', 'nodue'], 'all'),
    weekStart: qs.get('weekstart') === 'sun' ? 0 : 1,
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
  var CACHE_KEY = 'xeneon-planner-cache-v2';
  var LIST_KEY = 'xeneon-planner-list';
  var GROUP_KEY = 'xeneon-planner-group';
  var RANGE_KEY = 'xeneon-planner-range-' + CFG.view;

  var state = {
    data: null,
    activeList: 'all',
    group: CFG.group,
    range: CFG.range,
    lastFetch: 0,
    error: '',
    busy: {}
  };
  try { state.range = pick(localStorage.getItem(RANGE_KEY), ['day', 'week', 'month'], CFG.range); } catch (e) { /* 무시 */ }
  try { state.group = pick(localStorage.getItem(GROUP_KEY), ['all', 'overdue', 'today', 'upcoming', 'nodue'], CFG.group); } catch (e) { /* 무시 */ }

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    app: $('app'), clockTime: $('clock-time'), clockDate: $('clock-date'),
    next: $('next-event'), calBody: $('cal-body'), rangeTabs: $('range-tabs'),
    panelCal: $('panel-cal'), panelTask: $('panel-task'),
    tabs: $('task-tabs'), groupTabs: $('group-tabs'), taskBody: $('task-body'),
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
    b.classList.remove('view-both', 'view-calendar', 'view-tasks');
    b.classList.add('view-' + CFG.view);
    b.classList.remove('range-day', 'range-week', 'range-month');
    b.classList.add('range-' + state.range);
    // 일 보기에서 날짜를 가로로 몇 열로 놓을지
    var dayCols = 1;
    if (CFG.view === 'calendar') dayCols = w >= 1400 ? Math.min(CFG.days, 4) : (w >= 1000 ? Math.min(CFG.days, 2) : 1);
    else if (w >= 1400 && h >= 480) dayCols = Math.min(CFG.days, 2);
    b.style.setProperty('--day-cols', String(dayCols));
    b.style.setProperty('--task-cols', String(CFG.view === 'tasks' ? CFG.cols : 1));
    b.style.fontSize = 'calc(var(--fs) * ' + CFG.scale + ')';
    el.app.classList.toggle('single', CFG.view !== 'both');
  }

  // ------------------------------------------------------------
  // 날짜 유틸 (모두 CFG.tz 기준, 날짜 문자열은 'YYYY-MM-DD')
  // ------------------------------------------------------------
  var fmtTime = new Intl.DateTimeFormat('ko-KR', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hour12: false });
  var fmtDateLong = new Intl.DateTimeFormat('ko-KR', { timeZone: CFG.tz, month: 'long', day: 'numeric', weekday: 'short' });
  var fmtDateShort = new Intl.DateTimeFormat('ko-KR', { timeZone: CFG.tz, month: 'numeric', day: 'numeric', weekday: 'short' });
  var fmtYmd = new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  var WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

  function ymd(d) { return fmtYmd.format(d); }
  function todayYmd() { return ymd(new Date()); }
  function parts(y) { var p = y.split('-').map(Number); return { y: p[0], m: p[1], d: p[2] }; }
  function addDaysYmd(base, n) {
    var p = parts(base);
    return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10);
  }
  function diffDays(a, b) { // a - b (일)
    var pa = parts(a), pb = parts(b);
    return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86400000);
  }
  function dow(y) { return new Date(y + 'T12:00:00Z').getUTCDay(); } // 0=일
  function startOfWeek(y) { var off = (dow(y) - CFG.weekStart + 7) % 7; return addDaysYmd(y, -off); }
  function startOfMonth(y) { return y.slice(0, 8) + '01'; }
  function daysInMonth(y) { var p = parts(y); return new Date(Date.UTC(p.y, p.m, 0)).getUTCDate(); }
  function monthGrid(y) { // 월 보기 격자: 시작(주 시작 요일) ~ 42일
    var first = startOfMonth(y);
    var start = startOfWeek(first);
    var last = first.slice(0, 8) + String(daysInMonth(y)).padStart(2, '0');
    var rows = Math.ceil((diffDays(last, start) + 1) / 7);
    return { start: start, rows: rows, month: y.slice(0, 7) };
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
    return Math.floor(h / 24) + '일 후';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 조회 구간: 일·주·월 보기를 모두 덮는 합집합 (보기 전환 시 재조회 없이 즉시 그리기 위함)
  function fetchWindow() {
    var t = todayYmd();
    if (CFG.view === 'tasks') return { from: t, days: 1 };
    var g = monthGrid(t);
    var start = g.start < t ? g.start : t;
    var endDay = addDaysYmd(t, CFG.days - 1);
    var gridEnd = addDaysYmd(g.start, g.rows * 7 - 1);
    var weekEnd = addDaysYmd(startOfWeek(t), 6);
    var end = [endDay, gridEnd, weekEnd].sort().pop();
    return { from: start, days: diffDays(end, start) + 1 };
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
    var fw = fetchWindow();
    u.searchParams.set('key', CFG.key);
    u.searchParams.set('from', fw.from);
    u.searchParams.set('days', String(fw.days));
    u.searchParams.set('tz', CFG.tz);
    if (CFG.calendars) u.searchParams.set('calendars', CFG.calendars);
    u.searchParams.set('_', String(Date.now()));
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
  // 렌더링 공통
  // ------------------------------------------------------------
  function renderAll() {
    if (CFG.view !== 'tasks') { renderNext(); renderRangeTabs(); renderCalendar(); }
    if (CFG.view !== 'calendar') { renderTabs(); renderGroupTabs(); renderTasks(); renderAddForm(); }
  }

  function eventsByDay() {
    var byDay = {};
    (state.data.events || []).forEach(function (e) {
      if (e.allDay) {
        var d = e.start, guard = 0;
        while (d < e.end && guard++ < 62) { (byDay[d] = byDay[d] || []).push(e); d = addDaysYmd(d, 1); }
      } else {
        var k = ymd(new Date(e.start));
        (byDay[k] = byDay[k] || []).push(e);
      }
    });
    Object.keys(byDay).forEach(function (k) {
      byDay[k].sort(function (a, b) {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.allDay ? 0 : new Date(a.start) - new Date(b.start);
      });
    });
    return byDay;
  }

  function evTags(e) {
    var tags = '';
    if (e.meetingLink) tags += '<span class="tag meet">화상</span>';
    if (e.responseStatus === 'declined') tags += '<span class="tag declined">거절</span>';
    if (e.responseStatus === 'tentative') tags += '<span class="tag tentative">미정</span>';
    if (e.responseStatus === 'needsAction') tags += '<span class="tag">미응답</span>';
    return tags;
  }

  function evClass(e, now) {
    var s = e.allDay ? 0 : new Date(e.start).getTime();
    var en = e.allDay ? 0 : new Date(e.end).getTime();
    return 'ev' + (e.allDay ? ' allday' : '') +
      (!e.allDay && en <= now ? ' past' : '') +
      (!e.allDay && s <= now && en > now ? ' live' : '') +
      (e.responseStatus === 'declined' ? ' declined' : '');
  }

  function renderNext() {
    var now = Date.now();
    var upcoming = (state.data.events || []).filter(function (e) {
      return !e.allDay && e.responseStatus !== 'declined' && new Date(e.end).getTime() > now;
    }).sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    el.next.classList.remove('soon', 'live');
    var t = el.next.querySelector('.next-title'), w = el.next.querySelector('.next-when');
    if (!upcoming.length) { t.textContent = '예정된 일정 없음'; w.textContent = ''; return; }
    var ev = upcoming[0];
    var start = new Date(ev.start).getTime(), end = new Date(ev.end).getTime();
    t.textContent = ev.title;
    if (start <= now) {
      el.next.classList.add('live');
      w.textContent = '진행 중 · ' + hhmm(ev.start) + '–' + hhmm(ev.end) + ' (' + minutesText(Math.round((end - now) / 60000)).replace(' 후', ' 남음') + ')';
    } else {
      var mins = Math.round((start - now) / 60000);
      if (mins <= 15) el.next.classList.add('soon');
      var sd = ymd(new Date(ev.start));
      var prefix = sd === todayYmd() ? '' : dayLabel(sd) + ' ';
      w.textContent = prefix + hhmm(ev.start) + ' · ' + minutesText(mins);
    }
  }

  function renderRangeTabs() {
    Array.prototype.forEach.call(el.rangeTabs.querySelectorAll('.rtab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-range') === state.range);
    });
  }

  function renderCalendar() {
    if (state.range === 'week') return renderWeek();
    if (state.range === 'month') return renderMonth();
    return renderDayList();
  }

  // ---------- 일 보기: 날짜별 목록 ----------
  function renderDayList() {
    var byDay = eventsByDay();
    var t = todayYmd();
    var now = Date.now();
    var html = '<div class="cal-grid day-grid">';
    for (var i = 0; i < CFG.days; i++) {
      var day = addDaysYmd(t, i);
      var list = byDay[day] || [];
      html += '<section class="day"><div class="day-title">' + escapeHtml(dayLabel(day)) +
        '<span class="sub">' + escapeHtml(daySub(day)) + '</span>' +
        '<span class="cnt">' + list.length + '건</span></div>';
      if (!list.length) { html += '<div class="empty">일정 없음</div></section>'; continue; }
      var nowDrawn = day !== t;
      list.forEach(function (e) {
        var s = e.allDay ? 0 : new Date(e.start).getTime();
        if (!nowDrawn && !e.allDay && s > now) { html += '<div class="now-line"></div>'; nowDrawn = true; }
        html += '<div class="' + evClass(e, now) + '">' +
          '<div class="ev-bar" style="background:' + escapeHtml(e.color) + '"></div>' +
          '<div class="ev-time">' + (e.allDay ? '종일' : '<b>' + hhmm(e.start) + '</b><br>' + hhmm(e.end)) + '</div>' +
          '<div class="ev-main"><div class="ev-title">' + escapeHtml(e.title) + '</div>' +
          (e.location ? '<div class="ev-loc">' + escapeHtml(e.location) + '</div>' : '') + '</div>' +
          '<div class="ev-tags">' + evTags(e) + '</div></div>';
      });
      if (!nowDrawn) html += '<div class="now-line"></div>';
      html += '</section>';
    }
    html += '</div>';
    el.calBody.innerHTML = html;
  }

  // ---------- 주 보기: 7열 ----------
  function renderWeek() {
    var byDay = eventsByDay();
    var t = todayYmd();
    var now = Date.now();
    var start = startOfWeek(t);
    var html = '<div class="week-grid">';
    for (var i = 0; i < 7; i++) {
      var day = addDaysYmd(start, i);
      var list = byDay[day] || [];
      var p = parts(day);
      var wd = dow(day);
      html += '<section class="wday' + (day === t ? ' today' : '') + (day < t ? ' pastday' : '') + (wd === 0 || wd === 6 ? ' weekend' : '') + '">' +
        '<div class="wday-title"><span class="wd">' + WEEKDAY[wd] + '</span><span class="dn">' + p.d + '</span>' +
        (list.length ? '<span class="cnt">' + list.length + '</span>' : '') + '</div><div class="wday-list">';
      if (!list.length) html += '<div class="empty small">-</div>';
      list.forEach(function (e) {
        html += '<div class="' + evClass(e, now) + ' compact" style="border-left-color:' + escapeHtml(e.color) + '">' +
          '<div class="ev-time">' + (e.allDay ? '종일' : hhmm(e.start)) + '</div>' +
          '<div class="ev-title">' + escapeHtml(e.title) + '</div></div>';
      });
      html += '</div></section>';
    }
    html += '</div>';
    el.calBody.innerHTML = html;
  }

  // ---------- 월 보기: 7열 x N행 ----------
  function renderMonth() {
    var byDay = eventsByDay();
    var t = todayYmd();
    var now = Date.now();
    var g = monthGrid(t);
    var html = '<div class="month-grid" style="--rows:' + g.rows + '">';
    for (var i = 0; i < 7; i++) {
      var wd = (CFG.weekStart + i) % 7;
      html += '<div class="mhead' + (wd === 0 || wd === 6 ? ' weekend' : '') + '">' + WEEKDAY[wd] + '</div>';
    }
    for (var r = 0; r < g.rows * 7; r++) {
      var day = addDaysYmd(g.start, r);
      var list = byDay[day] || [];
      var inMonth = day.slice(0, 7) === g.month;
      var wd2 = dow(day);
      html += '<div class="mcell' + (day === t ? ' today' : '') + (inMonth ? '' : ' other') + (wd2 === 0 || wd2 === 6 ? ' weekend' : '') + '" data-day="' + day + '">' +
        '<div class="mnum">' + parts(day).d + (list.length ? '<span class="cnt">' + list.length + '</span>' : '') + '</div><div class="mlist">';
      list.forEach(function (e) {
        html += '<div class="chip' + (e.allDay ? ' allday' : '') + (e.responseStatus === 'declined' ? ' declined' : '') +
          (!e.allDay && new Date(e.end).getTime() <= now ? ' past' : '') + '" style="--c:' + escapeHtml(e.color) + '">' +
          (e.allDay ? '' : '<b>' + hhmm(e.start) + '</b> ') + escapeHtml(e.title) + '</div>';
      });
      html += '</div><div class="more"></div></div>';
    }
    html += '</div>';
    el.calBody.innerHTML = html;
    // 칸에 못 들어간 일정 수를 "+n" 으로 표시
    Array.prototype.forEach.call(el.calBody.querySelectorAll('.mcell'), function (cell) {
      var ml = cell.querySelector('.mlist'), chips = ml.children, more = cell.querySelector('.more');
      var hidden = 0;
      // offsetTop 은 position:relative 인 .mcell 기준이므로 목록 영역의 아래 경계도 같은 기준으로 계산
      var limit = ml.offsetTop + ml.clientHeight;
      for (var i = 0; i < chips.length; i++) {
        if (chips[i].offsetTop + chips[i].offsetHeight > limit + 1) { chips[i].style.visibility = 'hidden'; hidden++; }
      }
      if (hidden) more.textContent = '+' + hidden;
    });
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

  var GROUP_LABEL = { overdue: '기한 지남', today: '오늘', upcoming: '예정', nodue: '기한 없음', done: '최근 완료' };
  // 할일 전용 보기에서 열 수에 따른 그룹 배치
  var COLUMN_PLAN = {
    2: [['overdue', 'today'], ['upcoming', 'nodue', 'done']],
    3: [['overdue', 'today'], ['upcoming'], ['nodue', 'done']],
    4: [['overdue'], ['today'], ['upcoming'], ['nodue', 'done']]
  };

  // 선택된 목록의 할일을 구분별로 나눈다
  function groupTasks() {
    var t = todayYmd();
    var groups = { overdue: [], today: [], upcoming: [], nodue: [], done: [] };
    visibleTasks().forEach(function (task) {
      if (task.status === 'completed') { if (CFG.showDone) groups.done.push(task); return; }
      if (!task.due) { groups.nodue.push(task); return; }
      var d = task.due.slice(0, 10);
      if (d < t) groups.overdue.push(task);
      else if (d === t) groups.today.push(task);
      else groups.upcoming.push(task);
    });
    return groups;
  }

  // 할일 구분 버튼 (전체 / 지연 / 오늘 / 예정 / 기한 없음). 전용 보기(열 배치)에서는 숨김
  var GROUP_TABS = [['all', '전체'], ['overdue', '지연'], ['today', '오늘'], ['upcoming', '예정'], ['nodue', '기한 없음']];
  function renderGroupTabs() {
    if (CFG.view === 'tasks') { el.groupTabs.innerHTML = ''; el.groupTabs.hidden = true; return; }
    el.groupTabs.hidden = false;
    var g = groupTasks();
    var counts = { overdue: g.overdue.length, today: g.today.length, upcoming: g.upcoming.length, nodue: g.nodue.length };
    counts.all = counts.overdue + counts.today + counts.upcoming + counts.nodue;
    el.groupTabs.innerHTML = GROUP_TABS.map(function (p) {
      return '<button type="button" class="gtab ' + p[0] + (state.group === p[0] ? ' active' : '') + '" data-group="' + p[0] + '">' +
        p[1] + '<span class="n">' + counts[p[0]] + '</span></button>';
    }).join('');
  }

  function renderTasks() {
    var t = todayYmd();
    var groups = groupTasks();
    var listName = {};
    (state.data.taskLists || []).forEach(function (l) { listName[l.id] = l.title; });

    function section(key, list, forceShow, noTitle) {
      if (!list.length && !forceShow) return '';
      var html = '<section class="tsec ' + key + '">' + (noTitle ? '' : '<div class="tsec-title">' + GROUP_LABEL[key] + ' · ' + list.length + '</div>');
      if (!list.length) return html + '<div class="empty small">없음</div></section>';
      list.forEach(function (task) {
        var due = task.due ? task.due.slice(0, 10) : '';
        var dueText = '';
        if (due) {
          var diff = diffDays(due, t);
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
      return html + '</section>';
    }

    var html = '';
    if (CFG.view === 'tasks') {
      // 전용 보기: 열 단위 배치, 빈 그룹도 열 제목은 유지
      var plan = COLUMN_PLAN[CFG.cols];
      html = '<div class="task-cols">';
      plan.forEach(function (keys) {
        html += '<div class="tcol">';
        keys.forEach(function (k, idx) { html += section(k, groups[k], idx === 0 || groups[k].length > 0); });
        html += '</div>';
      });
      html += '</div>';
      el.taskBody.innerHTML = html;
      return;
    }
    // 구분 버튼이 '전체' 가 아니면 그 구분만, 제목 없이 바로 목록
    if (state.group !== 'all') {
      var one = groups[state.group] || [];
      el.taskBody.innerHTML = one.length ? section(state.group, one, true, true) : '<div class="empty">' + GROUP_LABEL[state.group] + ' 할일 없음</div>';
      return;
    }
    var total = 0;
    ['overdue', 'today', 'upcoming', 'nodue', 'done'].forEach(function (k) { total += groups[k].length; html += section(k, groups[k], false); });
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
  el.rangeTabs.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.rtab');
    if (!btn) return;
    state.range = btn.getAttribute('data-range');
    try { localStorage.setItem(RANGE_KEY, state.range); } catch (e) { /* 무시 */ }
    applyLayout();
    if (state.data) { renderRangeTabs(); renderCalendar(); }
  });

  el.tabs.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.tab');
    if (!btn) return;
    state.activeList = btn.getAttribute('data-list');
    try { localStorage.setItem(LIST_KEY, state.activeList); } catch (e) { /* 무시 */ }
    renderTabs(); renderGroupTabs(); renderTasks(); renderAddForm();
  });

  el.groupTabs.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.gtab');
    if (!btn) return;
    state.group = btn.getAttribute('data-group');
    try { localStorage.setItem(GROUP_KEY, state.group); } catch (e) { /* 무시 */ }
    renderGroupTabs(); renderTasks();
    el.taskBody.scrollTop = 0;
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
    task.status = toCompleted ? 'completed' : 'needsAction';
    task.completed = toCompleted ? new Date().toISOString() : '';
    state.busy[id] = true;
    renderTabs(); renderGroupTabs(); renderTasks();

    postAction({ action: toCompleted ? 'complete' : 'uncomplete', listId: listId, taskId: id })
      .then(function () {
        delete state.busy[id];
        setStatus((toCompleted ? '완료: ' : '되돌림: ') + task.title);
        renderTabs(); renderGroupTabs(); renderTasks();
      })
      .catch(function (err) {
        task.status = prev.status; task.completed = prev.completed;
        delete state.busy[id];
        setStatus('처리 실패: ' + (err && err.message || err), true);
        renderTabs(); renderGroupTabs(); renderTasks();
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
    window.addEventListener('resize', function () { applyLayout(); if (state.data && state.range === 'month') renderMonth(); });
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
    setInterval(function () { if (state.data && CFG.view !== 'tasks') { renderNext(); renderCalendar(); } }, 30000);
    var lastDay = todayYmd();
    setInterval(function () {
      var d = todayYmd();
      if (d !== lastDay) { lastDay = d; fetchData(); }
    }, 60000);
  }

  start();
})();
