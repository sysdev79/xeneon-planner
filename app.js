/* Xeneon Planner - 위젯 로직
   v01.04 (2026-11-17)

   URL 파라미터
     api        (필수) GAS 웹앱 배포 주소 (…/exec)
     key        (필수) GAS 스크립트 속성 SECRET_KEY 와 같은 값
     view       both | calendar | tasks   (기본 both)   ← v01.01
     range      day | week | month        (기본 day, 캘린더 초기 범위) ← v01.01
     cols       할일 전용 보기의 열 수 2~4 (기본 3) ← v01.01
     group      all | overdue | today | upcoming | nodue  (기본 all, 할일 초기 구분) ← v01.03
     weather    0 이면 날씨 숨김 (기본 표시) ← v01.04
     lat, lon   날씨 좌표 (기본 부산 35.1796, 129.0756) ← v01.04
     city       날씨 아래 표시할 지명 (기본 부산) ← v01.04
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
    weather: qs.get('weather') !== '0',
    lat: parseFloat(qs.get('lat') || '35.1796') || 35.1796,
    lon: parseFloat(qs.get('lon') || '129.0756') || 129.0756,
    city: qs.get('city') || '부산',
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
  var WEATHER_KEY = 'xeneon-planner-weather';
  var WEATHER_REFRESH_MS = 10 * 60 * 1000; // 날씨는 10분마다
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
    setup: $('setup'), setupSample: $('setup-sample'),
    weather: $('weather'), wIcon: $('w-icon'), wTemp: $('w-temp'), wCity: $('w-city')
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
  // 날씨 (Open-Meteo, 키 불필요) - 아이콘 + 온도
  // ------------------------------------------------------------
  var WX_SVG = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="#FFC845" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2" fill="#FFC845" stroke="none"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="#CBD5E1"><path d="M15.5 3a9 9 0 1 0 5.5 16.2A9.5 9.5 0 0 1 15.5 3z"/></svg>',
    cloudsun: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="3.2" fill="#FFC845" stroke="none"/><path d="M8 1.8v1.6M1.8 8h1.6M3.6 3.6l1.1 1.1" stroke="#FFC845"/><path d="M9 20h8.5a3.5 3.5 0 0 0 .6-6.95A5 5 0 0 0 8.6 12.2 3.9 3.9 0 0 0 9 20z" fill="#CBD5E1" stroke="none"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="#B8C2D1"><path d="M7 19h10.5a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.6 9.3 4.9 4.9 0 0 0 7 19z"/></svg>',
    fog: '<svg viewBox="0 0 24 24" fill="none" stroke="#B8C2D1" stroke-width="2.2" stroke-linecap="round"><path d="M4 9h16M3 13h18M5 17h14M7 21h10"/></svg>',
    rain: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><path d="M7 15h10.5a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.6 5.3 4.9 4.9 0 0 0 7 15z" fill="#B8C2D1"/><path d="M8.5 17.5l-1.2 3M12.5 17.5l-1.2 3M16.5 17.5l-1.2 3" stroke="#5AA9FF" stroke-width="2.2"/></svg>',
    snow: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><path d="M7 14h10.5a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.6 4.3 4.9 4.9 0 0 0 7 14z" fill="#B8C2D1"/><g stroke="#E8F4FF" stroke-width="1.8"><path d="M8 17v4M6.3 18l3.4 2M6.3 20l3.4-2M16 17v4M14.3 18l3.4 2M14.3 20l3.4-2"/></g></svg>',
    thunder: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 14h10.5a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.6 4.3 4.9 4.9 0 0 0 7 14z" fill="#9AA5B6"/><path d="M13 12l-3.5 5.5h3L11 22l4.5-6h-3L14 12z" fill="#FFC845"/></svg>',
    wind: '<svg viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" stroke-width="2.2" stroke-linecap="round"><path d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5M3 13h15a2.5 2.5 0 1 1-2.5 2.5M3 18h8a2 2 0 1 1-2 2"/></svg>'
  };
  // WMO 코드 -> 아이콘, 한글 설명
  function wxKind(code, isDay, wind) {
    if (code >= 95) return ['thunder', '뇌우'];
    if (code >= 85 || (code >= 71 && code <= 77)) return ['snow', '눈'];
    if (code >= 80 || (code >= 61 && code <= 67)) return ['rain', '비'];
    if (code >= 51 && code <= 57) return ['rain', '이슬비'];
    if (code === 45 || code === 48) return ['fog', '안개'];
    if (wind >= 9) return ['wind', '바람'];           // 9 m/s 이상이면 바람 우선 (강풍주의보 기준 14 m/s 보다 낮게 잡음)
    if (code === 3) return ['cloud', '흐림'];
    if (code === 2) return ['cloudsun', '구름 조금'];
    if (code === 1) return [isDay ? 'sun' : 'moon', '대체로 맑음'];
    return [isDay ? 'sun' : 'moon', '맑음'];
  }
  function renderWeather(w, stale) {
    if (!CFG.weather) return;
    el.weather.hidden = false;
    el.wCity.textContent = CFG.city;
    el.weather.classList.toggle('stale', !!stale);
    if (!w) { el.wIcon.innerHTML = WX_SVG.cloud; el.wTemp.textContent = '--°'; el.weather.title = '날씨 정보 없음'; return; }
    var k = wxKind(w.code, w.isDay, w.wind);
    el.wIcon.innerHTML = WX_SVG[k[0]];
    el.wTemp.textContent = Math.round(w.temp) + '°';
    el.weather.title = CFG.city + ' ' + k[1] + ' ' + w.temp + '°C, 바람 ' + w.wind + ' m/s';
  }
  function fetchWeather() {
    if (!CFG.weather) return;
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + CFG.lat + '&longitude=' + CFG.lon +
      '&current=temperature_2m,weather_code,wind_speed_10m,is_day&wind_speed_unit=ms&timezone=' + encodeURIComponent(CFG.tz);
    fetch(u, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var c = j && j.current;
        if (!c) throw new Error('응답 형식');
        var w = { temp: c.temperature_2m, code: c.weather_code, wind: c.wind_speed_10m, isDay: c.is_day !== 0, t: Date.now() };
        try { localStorage.setItem(WEATHER_KEY, JSON.stringify(w)); } catch (e) { /* 무시 */ }
        renderWeather(w, false);
      })
      .catch(function () {
        // 실패 시 마지막 값(3시간 이내)을 흐리게 유지
        var w = null;
        try { w = JSON.parse(localStorage.getItem(WEATHER_KEY) || 'null'); } catch (e) { /* 무시 */ }
        renderWeather(w && Date.now() - w.t < 3 * 3600000 ? w : null, true);
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

    if (CFG.view !== 'tasks' && CFG.weather) {
      try { var cw = JSON.parse(localStorage.getItem(WEATHER_KEY) || 'null'); if (cw) renderWeather(cw, true); } catch (e) { /* 무시 */ }
      fetchWeather();
      setInterval(fetchWeather, WEATHER_REFRESH_MS);
    }

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
