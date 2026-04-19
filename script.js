;(function () {
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
  const SLOT_START = 8
  const SLOT_END = 22
  const DAY_START_MIN = SLOT_START * 60
  const DAY_END_MIN = SLOT_END * 60
  const DAY_TOTAL_MIN = DAY_END_MIN - DAY_START_MIN
  /** 일 보기 빈 칸·눈금 간격 (분). 30이면 8:00, 8:30, … 클릭 가능 */
  const DAY_VIEW_SLOT_STEP_MIN = 30

  /**
   * 예약 한 건당 허용 최대 시간 길이(분).
   * 교회 운영 정책이 바뀌면 이 숫자만 수정하면 됨(폼 검증·안내에 동일하게 적용).
   * 예: 3시간 → 180, 2시간 → 120, 2시간 30분 → 150
   */
  const MAX_RESERVATION_SPAN_MINUTES = 180

  /**
   * 예약 오픈 일수: 오늘(Asia/Seoul 달력)을 포함해 며칠간 신청 가능한지.
   * 예: 14 → 오늘·내일 … 총 14일째 날까지 허용(마지막 날 = 오늘 + 13일).
   * “2주만 오픈” 같은 정책이 바뀌면 이 숫자만 수정.
   */
  const BOOKING_WINDOW_INCLUSIVE_DAYS = 14

  /** 구글 Apps Script 웹 앱 (배포 URL) */
  const GAS_URL =
    'https://script.google.com/macros/s/AKfycbzwOLYwcfo74MOJ8mI13sw67X-gWwa6yzQS-7LklBGxqn-pr9I4snlV0PEcSV4biQ65Xg/exec'

  const PLACES = ['다목적실', '유아예배실 1', '유아예배실 2']

  /** POST 본문: GAS가 JSON보다 잘 받는 형식과 동일하게 명시 */
  const GAS_CONTENT_TYPE_URLENC =
    'application/x-www-form-urlencoded;charset=UTF-8'

  function fieldsToUrlSearchParams(fields) {
    const params = new URLSearchParams()
    Object.keys(fields).forEach((k) => {
      const v = fields[k]
      if (v != null) params.set(k, String(v))
    })
    return params
  }

  /**
   * GAS 웹앱 POST. 응답 본문을 읽어야 하므로 mode: 'no-cors'는 사용하지 않음.
   * 본문은 URL 인코딩 문자열 + Content-Type 고정.
   */
  async function gasFetchPost(bodyFields) {
    const params =
      bodyFields instanceof URLSearchParams
        ? bodyFields
        : fieldsToUrlSearchParams(bodyFields)
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': GAS_CONTENT_TYPE_URLENC,
        Accept: 'text/plain, application/json, */*',
      },
      body: params.toString(),
      /** GAS 웹앱은 성공 시 리다이렉트할 수 있음 — 반드시 따라가야 최종 본문을 받을 수 있음 */
      redirect: 'follow',
      /** 응답 본문(JSON/텍스트)을 읽어야 하므로 cors 필수(no-cors 불가) */
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
    })
    return (await res.text()).trim()
  }

  /**
   * fetch가 막힐 때만: 전통적인 form POST(숨김 iframe). 응답 본문은 읽을 수 없음.
   */
  function gasSubmitViaHtmlForm(url, params) {
    let iframe = document.getElementById('gas-form-target-iframe')
    if (!iframe) {
      iframe = document.createElement('iframe')
      iframe.id = 'gas-form-target-iframe'
      iframe.name = 'gas-form-target-iframe'
      iframe.title = 'GAS 전송'
      iframe.setAttribute('aria-hidden', 'true')
      iframe.hidden = true
      iframe.tabIndex = -1
      document.body.appendChild(iframe)
    }
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = url
    form.target = iframe.name
    form.setAttribute('enctype', 'application/x-www-form-urlencoded')
    form.acceptCharset = 'UTF-8'
    form.noValidate = true
    const entries =
      params instanceof URLSearchParams
        ? [...params.entries()]
        : Object.keys(params)
            .filter((k) => params[k] != null)
            .map((k) => [k, params[k]])
    entries.forEach(([k, v]) => {
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = k
      input.value = String(v)
      form.appendChild(input)
    })
    document.body.appendChild(form)
    form.submit()
    form.remove()
  }

  function isLikelyFetchBlockedError(err) {
    if (!err) return false
    const name = err.name || ''
    const msg = String(err.message || '')
    return (
      name === 'TypeError' ||
      /Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)
    )
  }

  /**
   * doGet 목록: CORS 가능한 경우 fetch로 JSON 배열 수신.
   * redirect: 'follow'로 GAS 리다이렉트 체인 처리.
   */
  async function gasFetchGetReservationRows() {
    const u = new URL(GAS_URL)
    u.searchParams.set('t', String(Date.now()))
    const res = await fetch(u.toString(), {
      method: 'GET',
      redirect: 'follow',
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    })
    if (!res.ok) {
      throw new Error(`[GAS] GET HTTP ${res.status}`)
    }
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch (e) {
      throw new Error('[GAS] GET JSON 파싱 실패')
    }
    if (!Array.isArray(data)) {
      throw new Error('[GAS] GET 응답이 배열이 아님')
    }
    return data
  }

  /**
   * fetch가 CORS로 막힐 때만 사용. `<script src>`로 로드하면 브라우저가 교차 출처 스크립트 실행을 허용하는 경우가 있음.
   * GAS `doGet(e)`에서 `e.parameter.callback`이 있으면 아래처럼 반환해야 함:
   *   return ContentService.createTextOutput(e.parameter.callback + '(' + JSON.stringify(rows) + ');')
   *     .setMimeType(ContentService.MimeType.JAVASCRIPT);
   * callback 미지원 시 이 폴백은 실패함.
   */
  function gasGetReservationRowsViaJsonp() {
    return new Promise((resolve, reject) => {
      const cbName = `__rrGasJsonp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
      const script = document.createElement('script')
      const timeoutMs = 25000
      let settled = false
      const t = setTimeout(() => {
        finish(new Error('[GAS] JSONP 시간 초과'), null)
      }, timeoutMs)

      function finish(err, payload) {
        if (settled) return
        settled = true
        clearTimeout(t)
        try {
          delete window[cbName]
        } catch {
          /* ignore */
        }
        if (script.parentNode) script.parentNode.removeChild(script)
        if (err) reject(err)
        else resolve(payload)
      }

      window[cbName] = function (data) {
        finish(null, data)
      }

      script.onerror = () => finish(new Error('[GAS] JSONP 스크립트 로드 실패'), null)

      const u = new URL(GAS_URL)
      u.searchParams.set('callback', cbName)
      u.searchParams.set('t', String(Date.now()))
      script.src = u.toString()
      document.head.appendChild(script)
    })
  }

  // no-cors GET: opaque 응답만 오므로 JSON/텍스트 본문을 읽을 수 없어 목록 조회에 부적합(검토만, 미사용).

  const root = document.getElementById('calendar')
  if (!root) return

  const overlay = document.getElementById('reservation-overlay')
  const form = document.getElementById('reservation-form')
  const selectPlace = document.getElementById('reservation-place')
  const inputDate = document.getElementById('reservation-date')
  const inputTimeStart = document.getElementById('reservation-time-start')
  const inputTimeEnd = document.getElementById('reservation-time-end')
  const inputName = document.getElementById('reservation-name')
  const inputAffiliation = document.getElementById('reservation-affiliation')
  const inputPhone = document.getElementById('reservation-phone')
  const inputPurpose = document.getElementById('reservation-purpose')
  const btnClose = document.getElementById('reservation-close')
  const btnCancel = document.getElementById('reservation-cancel')

  const pwSetOverlay = document.getElementById('password-set-overlay')
  const pwSetForm = document.getElementById('password-set-form')
  const pwSetInput = document.getElementById('password-set-input')
  const pwSetClose = document.getElementById('password-set-close')
  const pwSetCancel = document.getElementById('password-set-cancel')

  const pwVerifyOverlay = document.getElementById('password-verify-overlay')
  const pwVerifyInput = document.getElementById('password-verify-input')
  const pwVerifyConfirm = document.getElementById('password-verify-confirm')
  const pwVerifyCancel = document.getElementById('password-verify-cancel')
  const pwVerifyClose = document.getElementById('password-verify-close')

  const gasLoadingOverlay = document.getElementById('gas-loading-overlay')
  const detailOverlay = document.getElementById('reservation-detail-overlay')
  const detailClose = document.getElementById('reservation-detail-close')
  const detailPlaceEl = document.getElementById('reservation-detail-place')
  const detailDateEl = document.getElementById('reservation-detail-date')
  const detailTimeEl = document.getElementById('reservation-detail-time')
  const detailNameEl = document.getElementById('reservation-detail-name')
  const detailBtnView = document.getElementById('reservation-detail-action-view')
  const detailBtnEdit = document.getElementById('reservation-detail-action-edit')
  const detailBtnDelete = document.getElementById('reservation-detail-action-delete')
  const detailFullOverlay = document.getElementById('reservation-detail-full-overlay')
  const detailFullClose = document.getElementById('reservation-detail-full-close')
  const detailFullOk = document.getElementById('reservation-detail-full-ok')
  const detailFullList = document.getElementById('reservation-detail-full-list')

  const state = {
    view: 'month',
    cursor: startOfDay(new Date()),
    /** 달력·신규 예약 기본 장소 */
    selectedPlace: '다목적실',
  }

  /** GAS GET으로 받은 예약 목록 (정규화된 객체 배열) */
  let sheetReservations = []

  let modalAnchorDate = startOfDay(new Date())
  /** 예약 폼 검증 후 · 비밀번호 확정 전까지 보관 */
  let pendingReservation = null
  let verifyModalState = {
    expectedPassword: '',
    onVerified: null,
    onCancel: null,
    serverOnly: false,
  }

  /** 달력 블록 클릭 시 열린 예약 (상세조회·삭제) */
  let detailReservationSelected = null

  /** `예약` 폼: 신규 예약 또는 수정 */
  let reservationFormMode = 'create'
  /** 수정 저장 시 서버 검증용 `{ id, password }` */
  let editSubmitContext = null

  function isAnyModalOpen() {
    const res = overlay && !overlay.hasAttribute('hidden')
    const set = pwSetOverlay && !pwSetOverlay.hasAttribute('hidden')
    const ver = pwVerifyOverlay && !pwVerifyOverlay.hasAttribute('hidden')
    const det = detailOverlay && !detailOverlay.hasAttribute('hidden')
    const detFull =
      detailFullOverlay && !detailFullOverlay.hasAttribute('hidden')
    return !!(res || set || ver || det || detFull)
  }

  function updateBodyScrollLock() {
    document.body.style.overflow = isAnyModalOpen() ? 'hidden' : ''
  }

  function showGasLoading(show) {
    if (!gasLoadingOverlay) return
    if (show) {
      gasLoadingOverlay.removeAttribute('hidden')
      gasLoadingOverlay.setAttribute('aria-hidden', 'false')
    } else {
      gasLoadingOverlay.setAttribute('hidden', '')
      gasLoadingOverlay.setAttribute('aria-hidden', 'true')
    }
  }

  function disableReservationSubmit() {
    const btn = document.getElementById('reservation-submit')
    if (!btn || btn.disabled) return
    if (!btn.dataset.originalLabel) {
      btn.dataset.originalLabel = btn.textContent.trim()
    }
    btn.disabled = true
  }

  function enableReservationSubmit() {
    const btn = document.getElementById('reservation-submit')
    if (!btn) return
    btn.disabled = false
    if (btn.dataset.originalLabel) {
      btn.textContent = btn.dataset.originalLabel
      delete btn.dataset.originalLabel
    }
  }

  /** '2026.04.11' → '2026-04-11' (GAS params.date) */
  function dotDateToISO(dot) {
    const m = String(dot).match(/^(\d{4})\.(\d{2})\.(\d{2})$/)
    if (!m) return ''
    return `${m[1]}-${m[2]}-${m[3]}`
  }

  /**
   * 시트/JSON에서 온 일자 → yyyy-MM-dd (Asia/Seoul 달력 기준)
   * 구글 시트 날짜는 JSON에서 `2026-04-18T15:00:00.000Z`처럼 오는데,
   * UTC 날짜 앞부분만 쓰면 한국에서는 하루 어긋남(예: 19일 예약이 18일로 표시).
   * 순수 `yyyy-MM-dd` 문자열만 그대로 쓰고, 그 외(Date·ISO 문자열)는 Seoul로 변환.
   */
  function normalizeSheetDate(val) {
    if (val == null || val === '') return ''
    const s = typeof val === 'string' ? val.trim() : String(val)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

    const d = new Date(val)
    if (Number.isNaN(d.getTime())) return ''
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(d)
      const y = parts.find((p) => p.type === 'year')?.value
      const mo = parts.find((p) => p.type === 'month')?.value
      const da = parts.find((p) => p.type === 'day')?.value
      if (y && mo && da) return `${y}-${mo}-${da}`
    } catch {
      /* ignore */
    }
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }

  /** Excel/시트 시간 셀(1899-12-30…) UTC 시각 → 서울 벽시계 분 */
  function utcHmToSeoulHHMM(utcH, utcM) {
    let t = utcH * 60 + utcM + 9 * 60
    t = ((t % (24 * 60)) + 24 * 60) % (24 * 60)
    return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`
  }

  /** '9:00', Date, 시트 시간 ISO → 'HH:mm' (달력 슬롯은 Asia/Seoul 기준) */
  function normalizeTimeStr(val) {
    if (val == null || val === '') return ''
    if (typeof val === 'string') {
      const plain = val.trim()
      if (/^\d{1,2}:\d{2}$/.test(plain)) {
        const m = plain.match(/^(\d{1,2}):(\d{2})$/)
        return `${pad2(Number(m[1]))}:${m[2]}`
      }
      if (/^\d{1,2}:\d{2}:\d{2}$/.test(plain)) {
        const m = plain.match(/^(\d{1,2}):(\d{2}):\d{2}$/)
        return `${pad2(Number(m[1]))}:${m[2]}`
      }
      if (/1899-12-30|T\d{2}:\d{2}/i.test(plain)) {
        const d = new Date(plain)
        if (!Number.isNaN(d.getTime()) && d.getFullYear() < 1901) {
          return utcHmToSeoulHHMM(d.getUTCHours(), d.getUTCMinutes())
        }
      }
    }
    const d = new Date(val)
    if (Number.isNaN(d.getTime())) return String(val)
    if (d.getFullYear() < 1901) {
      return utcHmToSeoulHHMM(d.getUTCHours(), d.getUTCMinutes())
    }
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }

  /**
   * doGet 목록 전용 정규화. 비밀번호 등 민감 필드는 저장하지 않음.
   * 전체 상세·연락처는 비밀번호 확인 후 POST(getDetail)로만 조회.
   */
  function normalizeReservationRow(raw, index) {
    if (!raw || typeof raw !== 'object') return null
    const idRaw =
      raw['예약번호'] ?? raw.예약번호 ?? raw.id ?? raw['id']
    const placeRaw = raw['장소'] ?? raw.place ?? ''
    const 일자Raw = raw['일자'] ?? raw.date ?? raw['date']
    const dateStr = normalizeSheetDate(일자Raw)
    const startRaw = raw['시작시간'] ?? raw.startTime ?? raw.start
    const endRaw = raw['종료시간'] ?? raw.endTime ?? raw.end
    const id =
      idRaw != null && String(idRaw).trim() !== ''
        ? String(idRaw).trim()
        : `row-${index}`
    return {
      id,
      place: normalizePlaceKey(placeRaw),
      date: dateStr,
      start: normalizeTimeStr(startRaw),
      end: normalizeTimeStr(endRaw),
      nameMasked: raw['예약자'] ?? raw.name ?? '',
    }
  }

  /** 장소명 비교용 (공백 통일) */
  function normalizePlaceKey(s) {
    return String(s ?? '')
      .trim()
      .replace(/\s+/g, ' ')
  }

  /** 달력·목록은 GAS doGet만 사용 (비밀번호 미포함 응답 가정). fetch 실패 시 JSONP 폴백. */
  async function fetchSheetReservations() {
    try {
      let data
      try {
        data = await gasFetchGetReservationRows()
      } catch (fetchErr) {
        console.warn('[GAS] GET(fetch) 실패 — JSONP 재시도', fetchErr)
        try {
          const payload = await gasGetReservationRowsViaJsonp()
          if (!Array.isArray(payload)) {
            console.warn('[GAS] JSONP 응답이 배열이 아님')
            sheetReservations = []
            return
          }
          data = payload
        } catch (jsonpErr) {
          console.warn('[GAS] JSONP도 실패', jsonpErr)
          sheetReservations = []
          return
        }
      }

      sheetReservations = data
        .map((row, idx) => normalizeReservationRow(row, idx))
        .filter((r) => r && r.date)
      console.log('[GAS] 예약 건수:', sheetReservations.length)
    } catch (err) {
      console.warn('[GAS] 예약 목록 불러오기 실패', err)
      sheetReservations = []
    }
  }

  function reservationsForPlace(place) {
    const p = normalizePlaceKey(place)
    return sheetReservations.filter((r) => normalizePlaceKey(r.place) === p)
  }

  /**
   * 달력 칸·일 보기와 시트 일자 비교용 키 (Asia/Seoul 날짜)
   * 로컬 TZ만 쓰면 시트(normalizeSheetDate·Seoul)와 어긋날 수 있음.
   */
  function dateKeyFromDate(dateObj) {
    const d =
      dateObj instanceof Date && !Number.isNaN(dateObj.getTime())
        ? dateObj
        : startOfDay(new Date())
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(d)
      const y = parts.find((x) => x.type === 'year')?.value
      const mo = parts.find((x) => x.type === 'month')?.value
      const da = parts.find((x) => x.type === 'day')?.value
      if (y && mo && da) return `${y}-${mo}-${da}`
    } catch {
      /* ignore */
    }
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }

  /** 시트에 저장된 일자 문자열을 비교용 yyyy-MM-dd로 */
  function reservationDateKeyForCompare(val) {
    if (val == null || val === '') return ''
    const s = String(val).trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    return normalizeSheetDate(val)
  }

  /** 해당 장소·날짜 예약 건수 */
  function countReservationsForPlaceAndDate(dateObj, place) {
    const key = dateKeyFromDate(dateObj)
    return reservationsForPlace(place).filter(
      (r) => reservationDateKeyForCompare(r.date) === key,
    ).length
  }

  function addCalendarDaysToYmdKey(ymd, deltaDays) {
    const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) return ymd
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    d.setDate(d.getDate() + deltaDays)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }

  function todayKeySeoul() {
    return dateKeyFromDate(new Date())
  }

  function lastBookableDayKeySeoul() {
    return addCalendarDaysToYmdKey(
      todayKeySeoul(),
      BOOKING_WINDOW_INCLUSIVE_DAYS - 1,
    )
  }

  function isYmdInBookableWindow(ymd) {
    const t = todayKeySeoul()
    const last = lastBookableDayKeySeoul()
    return ymd >= t && ymd <= last
  }

  function isDateInBookableWindow(dateObj) {
    return isYmdInBookableWindow(dateKeyFromDate(dateObj))
  }

  function currentTotalMinutesSeoul(now) {
    const d = now instanceof Date ? now : new Date()
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(d)
      const hh = parseInt(
        parts.find((p) => p.type === 'hour')?.value ?? '0',
        10,
      )
      const mm = parseInt(
        parts.find((p) => p.type === 'minute')?.value ?? '0',
        10,
      )
      return hh * 60 + mm
    } catch {
      return d.getHours() * 60 + d.getMinutes()
    }
  }

  /**
   * 일 보기 빈 슬롯 예약 가능 여부.
   * @returns {{ ok: true } | { ok: false, reason: 'past' | 'future' }}
   */
  function getSlotBookingAvailability(dayDate, slotStartMin) {
    const dayKey = dateKeyFromDate(startOfDay(dayDate))
    const nowKey = todayKeySeoul()
    const lastKey = lastBookableDayKeySeoul()

    if (dayKey < nowKey) return { ok: false, reason: 'past' }
    if (dayKey > lastKey) return { ok: false, reason: 'future' }

    if (dayKey === nowKey) {
      const cur = currentTotalMinutesSeoul(new Date())
      if (slotStartMin < cur) return { ok: false, reason: 'past' }
    }
    return { ok: true }
  }

  /** 종료 시각이 지금(서울)보다 이전이면 삭제 불가 */
  function isReservationEndedPastNow(r) {
    if (!r || !r.date || !r.end) return false
    const dayKey = reservationDateKeyForCompare(r.date)
    const endM = parseTimeToMinutes(normalizeTimeStr(r.end))
    if (Number.isNaN(endM)) return false
    const now = new Date()
    const nowKey = todayKeySeoul()
    const cur = currentTotalMinutesSeoul(now)
    if (dayKey < nowKey) return true
    if (dayKey > nowKey) return false
    return endM < cur
  }

  /** yyyy-MM-dd → 로컬 자정 기준 Date */
  function dateFromYmd(dateStr) {
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) return startOfDay(new Date())
    return startOfDay(
      new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
    )
  }

  /**
   * 이름 마스킹: 첫 글자만 표시 (홍길동 → 홍**, 허준 → 허*)
   * @param {string} name
   */
  function maskNameDisplay(name) {
    const s = String(name ?? '').trim()
    if (!s) return '(없음)'
    const chars = Array.from(s)
    if (chars.length <= 1) return `${chars[0]}*`
    return chars[0] + '*'.repeat(chars.length - 1)
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** 시트에서 온 연락처 표시용(선행 ') 제거 */
  function stripSheetPhoneDisplay(v) {
    let s = String(v ?? '').trim()
    if (s.startsWith("'")) s = s.slice(1)
    return s
  }

  /** getDetail JSON에서 소속 필드 (`group` / `소속` 등) */
  function pickDetailAffiliation(obj) {
    if (!obj || typeof obj !== 'object') return ''
    const v =
      obj.group ??
      obj.소속 ??
      obj.affiliation ??
      obj.groupName
    return String(v ?? '').trim()
  }

  function ensureReservationModalDefaultsStored() {
    const titleEl = document.getElementById('reservation-modal-title')
    const submitBtn = document.getElementById('reservation-submit')
    if (titleEl && !titleEl.dataset.defaultTitle) {
      titleEl.dataset.defaultTitle = titleEl.textContent.trim()
    }
    if (submitBtn && !submitBtn.dataset.defaultLabel) {
      submitBtn.dataset.defaultLabel = submitBtn.textContent.trim()
    }
  }

  function resetReservationModalToCreate() {
    reservationFormMode = 'create'
    editSubmitContext = null
    if (selectPlace) selectPlace.disabled = false
    ensureReservationModalDefaultsStored()
    const titleEl = document.getElementById('reservation-modal-title')
    const submitBtn = document.getElementById('reservation-submit')
    if (titleEl?.dataset.defaultTitle) {
      titleEl.textContent = titleEl.dataset.defaultTitle
    }
    if (submitBtn?.dataset.defaultLabel) {
      submitBtn.textContent = submitBtn.dataset.defaultLabel
    }
  }

  /**
   * 상세조회 응답에 달력에서 선택한 행을 합쳐 장소·예약일·예약시간을 반드시 채움.
   * 예약일은 yyyy-MM-dd면 점 형식으로 표시용 변환.
   */
  function enrichDetailPayloadForDisplay(payload) {
    const r = detailReservationSelected
    const src =
      payload != null &&
      typeof payload === 'object' &&
      !Array.isArray(payload)
        ? { ...payload }
        : {}
    if (!r) return src

    const place = src.장소 ?? src.place ?? r.place
    if (place) src.장소 = String(place).trim()

    const rawDate = src.예약일 ?? src.일자 ?? src.date ?? r.date
    if (rawDate) {
      const ds = String(rawDate).trim()
      src.예약일 = /^\d{4}-\d{2}-\d{2}$/.test(ds)
        ? formatDateDot(dateFromYmd(ds))
        : ds
    }

    const s = src.시작시간 ?? src.startTime ?? src.start ?? r.start
    const e = src.종료시간 ?? src.endTime ?? src.end ?? r.end
    if (s && e) src.예약시간 = `${s} ~ ${e}`

    return src
  }

  /** 예약 블록 세로 위치 (8:00~22:00 타임라인 %) */
  function clipReservationVertical(startStr, endStr) {
    let a = parseTimeToMinutes(startStr)
    let b = parseTimeToMinutes(endStr)
    if (Number.isNaN(a) || Number.isNaN(b)) return null
    a = Math.max(a, DAY_START_MIN)
    b = Math.min(b, DAY_END_MIN)
    if (b <= a) return null
    return {
      topPct: ((a - DAY_START_MIN) / DAY_TOTAL_MIN) * 100,
      heightPct: ((b - a) / DAY_TOTAL_MIN) * 100,
    }
  }

  /** 겹치는 예약 가로 분할 (열 할당) */
  function assignReservationColumns(list) {
    if (!list.length) return
    const sorted = [...list].sort(
      (a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start),
    )
    const active = []
    let maxK = 1
    sorted.forEach((r) => {
      const s = parseTimeToMinutes(r.start)
      const e = parseTimeToMinutes(r.end)
      if (Number.isNaN(s) || Number.isNaN(e)) {
        r._col = 0
        return
      }
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].end <= s) active.splice(i, 1)
      }
      const taken = new Set(active.map((x) => x.col))
      let col = 0
      while (taken.has(col)) col += 1
      r._col = col
      active.push({ end: e, col })
      maxK = Math.max(maxK, col + 1)
    })
    sorted.forEach((r) => {
      r._colCount = maxK
    })
  }

  async function postGasReservationAction(fields) {
    return gasFetchPost(fields)
  }

  function openReservationDetailModal(r) {
    closeReservationDetailFullModal()
    if (
      !detailOverlay ||
      !detailPlaceEl ||
      !detailDateEl ||
      !detailTimeEl ||
      !detailNameEl
    ) {
      return
    }
    detailReservationSelected = r
    detailPlaceEl.textContent = r.place || '(없음)'
    detailDateEl.textContent = formatDateDot(dateFromYmd(r.date))
    detailTimeEl.textContent = `${r.start || '?'} ~ ${r.end || '?'}`
    detailNameEl.textContent = maskNameDisplay(r.nameMasked)

    const pastEnded = isReservationEndedPastNow(r)
    if (detailBtnDelete) {
      detailBtnDelete.hidden = pastEnded
      detailBtnDelete.style.display = pastEnded ? 'none' : ''
    }
    if (detailBtnEdit) {
      detailBtnEdit.hidden = pastEnded
      detailBtnEdit.style.display = pastEnded ? 'none' : ''
    }
    const modalDetail = detailOverlay.querySelector('.modal--detail')
    if (modalDetail) {
      modalDetail.classList.toggle('modal--detail-no-delete', pastEnded)
    }

    detailOverlay.removeAttribute('hidden')
    detailOverlay.setAttribute('aria-hidden', 'false')
    updateBodyScrollLock()
  }

  function closeReservationDetailFullModal() {
    if (!detailFullOverlay) return
    detailFullOverlay.setAttribute('hidden', '')
    detailFullOverlay.setAttribute('aria-hidden', 'true')
    if (detailFullList) detailFullList.innerHTML = ''
    updateBodyScrollLock()
  }

  function closeReservationDetailModal() {
    if (!detailOverlay) return
    closeReservationDetailFullModal()
    detailOverlay.setAttribute('hidden', '')
    detailOverlay.setAttribute('aria-hidden', 'true')
    detailReservationSelected = null
    updateBodyScrollLock()
  }

  const DETAIL_SENSITIVE_KEY = /password|비밀번호|^pwd$|^pass$/i

  function fillDetailFullListFromPayload(payload) {
    if (!detailFullList) return
    detailFullList.innerHTML = ''

    if (payload == null) return

    if (typeof payload === 'string') {
      let obj
      try {
        obj = JSON.parse(payload)
      } catch {
        const row = document.createElement('div')
        row.className = 'modal__detail-row'
        const dt = document.createElement('dt')
        dt.textContent = '내용'
        const dd = document.createElement('dd')
        dd.textContent = payload
        row.append(dt, dd)
        detailFullList.appendChild(row)
        return
      }
      fillDetailFullListFromPayload(obj)
      return
    }

    if (typeof payload !== 'object' || Array.isArray(payload)) {
      const row = document.createElement('div')
      row.className = 'modal__detail-row'
      const dt = document.createElement('dt')
      dt.textContent = '내용'
      const dd = document.createElement('dd')
      dd.textContent = JSON.stringify(payload)
      row.append(dt, dd)
      detailFullList.appendChild(row)
      return
    }

    const obj = enrichDetailPayloadForDisplay(payload)
    const seen = new Set()

    function addRow(label, value, key) {
      if (value == null || String(value).trim() === '') return
      const row = document.createElement('div')
      row.className = 'modal__detail-row'
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.textContent = String(value)
      row.append(dt, dd)
      detailFullList.appendChild(row)
      if (key) seen.add(key)
    }

    function pick(label, ...keys) {
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i]
        if (!(k in obj)) continue
        if (DETAIL_SENSITIVE_KEY.test(k)) continue
        const v = obj[k]
        if (v == null || v === '') continue
        addRow(label, v, k)
        return
      }
    }

    pick('장소', '장소', 'place')
    pick('예약일', '예약일', '일자', 'date')
    pick('예약시간', '예약시간')
    pick('예약번호', '예약번호', 'id')
    pick('예약자', '예약자', 'name')
    pick('소속', '소속', 'group')
    pick('연락처', '연락처', 'phone')
    pick('사용 목적', '사용목적', 'purpose')

    if (seen.has('예약일')) {
      seen.add('일자')
      seen.add('date')
    }
    if (seen.has('예약시간')) {
      ;['시작시간', '종료시간', 'startTime', 'endTime', 'start', 'end'].forEach(
        (k) => {
          seen.add(k)
        },
      )
    }
    if (seen.has('장소') || seen.has('place')) {
      seen.add('장소')
      seen.add('place')
    }

    Object.keys(obj).forEach((k) => {
      if (seen.has(k)) return
      if (DETAIL_SENSITIVE_KEY.test(k)) return
      const v = obj[k]
      if (v == null || v === '') return
      addRow(k, v, k)
    })
  }

  function openReservationDetailFullModal(payload) {
    if (!detailFullOverlay) return
    fillDetailFullListFromPayload(payload)
    detailFullOverlay.removeAttribute('hidden')
    detailFullOverlay.setAttribute('aria-hidden', 'false')
    updateBodyScrollLock()
  }

  async function requestReservationDetailFromServer(plainPassword) {
    const r = detailReservationSelected
    if (!r) return
    showGasLoading(true)
    try {
      const text = await postGasReservationAction({
        mode: 'getDetail',
        id: r.id,
        password: plainPassword,
      })
      if (text.startsWith('Error:') || text.startsWith('Unauthorized')) {
        alert(text)
        return
      }
      try {
        const data = JSON.parse(text)
        openReservationDetailFullModal(data)
      } catch {
        openReservationDetailFullModal(text)
      }
    } catch (err) {
      console.error(err)
      alert('상세 정보를 불러오지 못했습니다.')
    } finally {
      showGasLoading(false)
    }
  }

  /**
   * 수정 폼용: 비밀번호 확인 후 상세(JSON)를 받아 편집 모달을 연다.
   * @param {string} plainPassword
   */
  async function requestReservationDetailThenOpenEdit(plainPassword) {
    const r = detailReservationSelected
    if (!r) return
    showGasLoading(true)
    try {
      const text = await postGasReservationAction({
        mode: 'getDetail',
        id: r.id,
        password: plainPassword,
      })
      if (text === 'AuthFail') {
        alert('비밀번호가 일치하지 않습니다.')
        return
      }
      if (text.startsWith('Error:') || text.startsWith('Unauthorized')) {
        alert(text)
        return
      }
      let detailJson
      try {
        detailJson = JSON.parse(text)
      } catch {
        alert('예약 정보를 불러오지 못했습니다.')
        return
      }
      openReservationEditModal(plainPassword, detailJson)
    } catch (err) {
      console.error(err)
      alert('예약 정보를 불러오지 못했습니다.')
    } finally {
      showGasLoading(false)
    }
  }

  /**
   * 장소·일자·시작 시간 고정, 종료·예약자·소속·연락처·목적 수정 가능.
   * @param {string} plainPassword
   * @param {{ name?: string, phone?: string, purpose?: string, group?: string }} detailJson
   */
  function openReservationEditModal(plainPassword, detailJson) {
    const r = detailReservationSelected
    if (
      !r ||
      !overlay ||
      !inputDate ||
      !inputTimeStart ||
      !inputTimeEnd ||
      !inputName ||
      !inputPurpose ||
      !selectPlace ||
      !inputAffiliation ||
      !inputPhone
    ) {
      return
    }

    ensureReservationModalDefaultsStored()
    reservationFormMode = 'edit'
    editSubmitContext = { id: r.id, password: plainPassword }

    const titleEl = document.getElementById('reservation-modal-title')
    const submitBtn = document.getElementById('reservation-submit')
    if (titleEl) titleEl.textContent = '예약 수정'
    if (submitBtn) submitBtn.textContent = '저장'

    selectPlace.value = r.place
    selectPlace.disabled = true

    modalAnchorDate = dateFromYmd(r.date)
    inputDate.value = formatDateDot(modalAnchorDate)

    const startStr = snapToHalfHourSlot(normalizeTimeStr(r.start))
    inputTimeStart.value = startStr

    /** 달력(doGet displayValues) 기준 종료시간 우선 — getDetail의 시트 Date 직렬화 오류 방지 */
    const endRaw =
      r.end ??
      detailJson.end ??
      detailJson.endTime ??
      detailJson['종료시간']
    let endPreferred = ''
    if (endRaw != null && String(endRaw).trim() !== '') {
      endPreferred = snapToHalfHourSlot(normalizeTimeStr(endRaw))
    }
    fillReservationEndSelect(endPreferred || undefined)

    inputName.value = String(detailJson.name ?? '').trim()
    inputAffiliation.value = pickDetailAffiliation(detailJson)
    inputPhone.value = stripSheetPhoneDisplay(detailJson.phone)
    inputPurpose.value = String(detailJson.purpose ?? '').trim()

    closeReservationDetailModal()

    overlay.removeAttribute('hidden')
    overlay.setAttribute('aria-hidden', 'false')
    updateBodyScrollLock()
    inputTimeEnd.focus()
  }

  async function requestReservationCancel(plainPassword) {
    const r = detailReservationSelected
    if (!r) return
    showGasLoading(true)
    try {
      const text = await postGasReservationAction({
        mode: 'cancel',
        id: r.id,
        password: plainPassword,
      })
      const ok =
        text === 'CancelSuccess' ||
        /^Success/i.test(text) ||
        text === 'OK' ||
        /^Deleted/i.test(text) ||
        /^Cancelled/i.test(text) ||
        /^Cancel:/i.test(text) ||
        /취소\s*완료/.test(text)
      if (ok) {
        closePasswordVerifyModal()
        closeReservationDetailModal()
        await fetchSheetReservations()
        render()
        updateBodyScrollLock()
        alert('예약이 취소되었습니다.')
        return
      }
      if (text.startsWith('Error:') || text.startsWith('Unauthorized')) {
        alert(text)
        return
      }
      alert(text || '취소 처리에 실패했습니다.')
    } catch (err) {
      console.error(err)
      alert('취소 요청 중 오류가 발생했습니다.')
    } finally {
      showGasLoading(false)
    }
  }

  function startOfDay(d) {
    const x = new Date(d)
    x.setHours(0, 0, 0, 0)
    return x
  }

  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    )
  }

  function pad2(n) {
    return String(n).padStart(2, '0')
  }

  function formatDateDot(d) {
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const day = d.getDate()
    return `${y}.${pad2(m)}.${pad2(day)}`
  }

  function formatTimeKorean(totalMins) {
    const h = Math.floor(totalMins / 60)
    const m = totalMins % 60
    if (m === 0) return `${h}시`
    return `${h}시 30분`
  }

  function valueFromMinutes(totalMins) {
    const h = Math.floor(totalMins / 60)
    const m = totalMins % 60
    return `${pad2(h)}:${pad2(m)}`
  }

  function parseTimeToMinutes(t) {
    if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return NaN
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }

  /**
   * 8:00~22:00 안에서만 30분 격자(:00, :30)로 맞춤.
   * type="time" step="1800"과 함께 쓰며, 붙여넣기·일부 브라우저 입력 보정용.
   */
  function snapToHalfHourSlot(value) {
    let m = parseTimeToMinutes(value)
    if (Number.isNaN(m)) return value
    const minM = SLOT_START * 60
    const maxM = SLOT_END * 60
    m = Math.round((m - minM) / 30) * 30 + minM
    m = Math.max(minM, Math.min(maxM, m))
    return valueFromMinutes(m)
  }

  /** MAX_RESERVATION_SPAN_MINUTES를 안내 문구용 짧은 한글로 */
  function maxReservationSpanLabelKo() {
    const n = MAX_RESERVATION_SPAN_MINUTES
    const h = Math.floor(n / 60)
    const m = n % 60
    if (m === 0) return `${h}시간`
    if (h === 0) return `${m}분`
    return `${h}시간 ${m}분`
  }

  /** 시작·종료가 30분 격자 위인지(스냅 후 검증용) */
  function isAlignedToHalfHourFromDayStart(totalMins) {
    if (Number.isNaN(totalMins)) return false
    return (totalMins - DAY_START_MIN) % 30 === 0
  }

  /**
   * 종료만 30분 격자 옵션(시작~최대 MAX_RESERVATION_SPAN · 22:00까지)
   * @param {string} [preferredEndHHmm] — 있으면 옵션에 맞을 때 우선 선택(수정 폼 등)
   */
  function fillReservationEndSelect(preferredEndHHmm) {
    if (!inputTimeStart || !inputTimeEnd) return

    const startStr = snapToHalfHourSlot(inputTimeStart.value)
    inputTimeStart.value = startStr
    const startM = parseTimeToMinutes(startStr)
    if (Number.isNaN(startM)) return

    const maxEndM = Math.min(
      startM + MAX_RESERVATION_SPAN_MINUTES,
      DAY_END_MIN,
    )
    const sel = inputTimeEnd
    const prev =
      sel.tagName === 'SELECT' && sel.value ? String(sel.value) : ''

    sel.innerHTML = ''

    for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 30) {
      if (m <= startM) continue
      if (m > maxEndM) break
      const v = valueFromMinutes(m)
      const opt = document.createElement('option')
      opt.value = v
      opt.textContent = v
      sel.appendChild(opt)
    }

    if (!sel.options.length) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '선택 가능한 종료 시간 없음'
      sel.appendChild(opt)
      return
    }

    const preferM = Math.min(startM + 60, maxEndM)
    const preferStr = valueFromMinutes(preferM)
    const pref =
      preferredEndHHmm != null && String(preferredEndHHmm).trim() !== ''
        ? String(preferredEndHHmm).trim()
        : ''
    let chosen = ''
    if (pref && [...sel.options].some((o) => o.value === pref)) {
      chosen = pref
    } else if ([...sel.options].some((o) => o.value === preferStr)) {
      chosen = preferStr
    } else if (prev && [...sel.options].some((o) => o.value === prev)) {
      chosen = prev
    } else {
      chosen = sel.options[0].value
    }
    sel.value = chosen
  }

  function monthTitle(d) {
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월`
  }

  function dayTitle(d) {
    const w = WEEKDAYS[d.getDay()]
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${w})`
  }

  function openReservationModal(date, opts) {
    if (
      !overlay ||
      !inputDate ||
      !inputTimeStart ||
      !inputTimeEnd ||
      !inputName ||
      !inputPurpose ||
      !selectPlace ||
      !inputAffiliation ||
      !inputPhone
    ) {
      return
    }

    resetReservationModalToCreate()

    const opt = opts || {}
    modalAnchorDate = startOfDay(date)
    inputDate.value = formatDateDot(modalAnchorDate)

    const dayKeyModal = dateKeyFromDate(modalAnchorDate)
    if (!isYmdInBookableWindow(dayKeyModal)) {
      alert(
        `예약은 오늘부터 ${BOOKING_WINDOW_INCLUSIVE_DAYS}일(약 2주) 이내 날짜만 가능합니다.`,
      )
      return
    }

    let startTotalMin = 9 * 60
    if (typeof opt.startTotalMin === 'number' && !Number.isNaN(opt.startTotalMin)) {
      startTotalMin = opt.startTotalMin
    } else if (typeof opt.startHour === 'number') {
      startTotalMin = opt.startHour * 60
    }

    const slotAvail = getSlotBookingAvailability(date, startTotalMin)
    if (!slotAvail.ok) {
      alert(
        slotAvail.reason === 'future'
          ? `예약은 오늘부터 ${BOOKING_WINDOW_INCLUSIVE_DAYS}일(약 2주) 이내만 가능합니다.`
          : '이미 지난 일자·시간에는 예약할 수 없습니다.',
      )
      return
    }

    inputTimeStart.value = snapToHalfHourSlot(valueFromMinutes(startTotalMin))
    fillReservationEndSelect()

    inputName.value = ''
    inputAffiliation.value = ''
    inputPhone.value = ''
    inputPurpose.value = ''
    if (PLACES.includes(state.selectedPlace)) {
      selectPlace.value = state.selectedPlace
    } else {
      selectPlace.selectedIndex = 0
    }

    overlay.removeAttribute('hidden')
    overlay.setAttribute('aria-hidden', 'false')
    updateBodyScrollLock()
    selectPlace.focus()
  }

  function closeReservationModal() {
    if (!overlay) return
    if (pwSetOverlay && !pwSetOverlay.hasAttribute('hidden')) {
      closePasswordSetModal()
    }
    overlay.setAttribute('hidden', '')
    overlay.setAttribute('aria-hidden', 'true')
    pendingReservation = null
    resetReservationModalToCreate()
    enableReservationSubmit()
    resetPasswordSubmitButton()
    updateBodyScrollLock()
  }

  function openPasswordSetModal() {
    if (!pwSetOverlay || !pwSetInput) return
    pwSetInput.value = ''
    pwSetOverlay.removeAttribute('hidden')
    pwSetOverlay.setAttribute('aria-hidden', 'false')
    updateBodyScrollLock()
    pwSetInput.focus()
  }

  function closePasswordSetModal() {
    if (!pwSetOverlay) return
    pwSetOverlay.setAttribute('hidden', '')
    pwSetOverlay.setAttribute('aria-hidden', 'true')
    if (pwSetInput) pwSetInput.value = ''
    enableReservationSubmit()
    resetPasswordSubmitButton()
    updateBodyScrollLock()
  }

  function resetPasswordSubmitButton() {
    const btnPw = document.getElementById('password-set-submit')
    if (!btnPw) return
    btnPw.disabled = false
    if (btnPw.dataset.originalLabel) {
      btnPw.textContent = btnPw.dataset.originalLabel
      delete btnPw.dataset.originalLabel
    }
  }

  async function finalizeReservation(plainPassword) {
    const btnPw = document.getElementById('password-set-submit')

    showGasLoading(true)
    const btnRes = document.getElementById('reservation-submit')
    if (btnRes) btnRes.textContent = '처리 중...'
    if (btnPw) {
      if (!btnPw.dataset.originalLabel) {
        btnPw.dataset.originalLabel = btnPw.textContent.trim()
      }
      btnPw.disabled = true
      btnPw.textContent = '처리 중...'
    }

    try {
      if (!pendingReservation) return

      const dateIso = dotDateToISO(pendingReservation.일자)
      if (!dateIso) {
        alert('일자 형식이 올바르지 않습니다.')
        return
      }

      if (!isYmdInBookableWindow(dateIso)) {
        alert(
          `예약 가능 기간이 아닙니다. 오늘부터 ${BOOKING_WINDOW_INCLUSIVE_DAYS}일(약 2주) 이내만 선택해 주세요.`,
        )
        return
      }

      const params = new URLSearchParams()
      params.set('place', pendingReservation.장소)
      params.set('date', dateIso)
      params.set('startTime', pendingReservation.시작시간)
      params.set('endTime', pendingReservation.종료시간)
      params.set('name', pendingReservation.예약자)
      params.set('group', pendingReservation.소속)
      params.set('phone', pendingReservation.연락처)
      params.set('purpose', pendingReservation.사용목적)
      params.set('password', plainPassword)

      let text
      try {
        text = await gasFetchPost(params)
      } catch (fetchErr) {
        console.error(fetchErr)
        if (isLikelyFetchBlockedError(fetchErr)) {
          gasSubmitViaHtmlForm(GAS_URL, params)
          pendingReservation = null
          closePasswordSetModal()
          closeReservationModal()
          void fetchSheetReservations().then(() => render())
          setTimeout(() => {
            void fetchSheetReservations().then(() => render())
          }, 2000)
          alert(
            '브라우저에서 서버 응답을 받지 못했습니다. 전송은 시도되었으니 목록을 새로 고칩니다. 반영이 늦으면 잠시 후 다시 확인해 주세요.',
          )
          return
        }
        alert(
          `서버와 통신할 수 없습니다.\n(${fetchErr && fetchErr.message ? fetchErr.message : '네트워크 오류'})\n\n구글 시트 웹앱 배포 URL·CORS 설정을 확인해 주세요.`,
        )
        return
      }

      if (text.startsWith('Success:')) {
        const reservationId = text.slice('Success:'.length).trim()
        console.log('[예약 완료]', {
          예약번호: reservationId,
          장소: pendingReservation.장소,
          일자: dateIso,
          비밀번호: '(콘솔 미출력)',
        })
        pendingReservation = null
        closePasswordSetModal()
        closeReservationModal()
        await fetchSheetReservations()
        render()
        alert(`예약이 저장되었습니다.\n예약번호: ${reservationId}`)
        return
      }

      if (text === 'Conflict') {
        alert(
          '해당 장소·날짜·시간에 이미 예약이 있습니다.\n다른 시간을 선택해 주세요.',
        )
        return
      }

      if (text.startsWith('Error:')) {
        alert(text)
        return
      }

      alert(`저장에 실패했습니다.\n(${text})`)
    } catch (err) {
      console.error(err)
      alert(
        `서버와 통신할 수 없습니다.\n(${err && err.message ? err.message : '네트워크 오류'})\n\n구글 시트 웹앱 배포 URL·CORS(다른 도메인에서 열 때) 설정을 확인해 주세요.`,
      )
    } finally {
      showGasLoading(false)
      if (btnPw) {
        btnPw.disabled = false
        btnPw.textContent = btnPw.dataset.originalLabel || '확인'
      }
      enableReservationSubmit()
    }
  }

  async function submitReservationUpdate(ts, te) {
    const ctx = editSubmitContext
    if (!ctx?.id || ctx.password == null) {
      alert('수정 세션이 만료되었습니다. 다시 시도해 주세요.')
      return
    }

    showGasLoading(true)
    const btnRes = document.getElementById('reservation-submit')
    const saveLabel =
      reservationFormMode === 'edit'
        ? '저장'
        : btnRes?.dataset.defaultLabel || '예약'
    if (btnRes) {
      btnRes.disabled = true
      btnRes.textContent = '처리 중...'
    }

    try {
      const params = new URLSearchParams()
      params.set('mode', 'update')
      params.set('id', ctx.id)
      params.set('password', ctx.password)
      params.set('endTime', te)
      params.set('name', inputName.value.trim())
      params.set('group', inputAffiliation.value.trim())
      params.set('phone', inputPhone.value.trim())
      params.set('purpose', inputPurpose.value.trim())

      let text
      try {
        text = await gasFetchPost(params)
      } catch (fetchErr) {
        console.error(fetchErr)
        if (isLikelyFetchBlockedError(fetchErr)) {
          gasSubmitViaHtmlForm(GAS_URL, params)
          closeReservationModal()
          void fetchSheetReservations().then(() => render())
          setTimeout(() => {
            void fetchSheetReservations().then(() => render())
          }, 2000)
          alert(
            '브라우저에서 서버 응답을 받지 못했습니다. 전송은 시도되었으니 목록을 새로 고칩니다.',
          )
          return
        }
        alert(
          `서버와 통신할 수 없습니다.\n(${fetchErr && fetchErr.message ? fetchErr.message : '네트워크 오류'})\n\n구글 시트 웹앱 배포 URL·CORS 설정을 확인해 주세요.`,
        )
        return
      }

      if (text === 'UpdateSuccess') {
        closeReservationModal()
        await fetchSheetReservations()
        render()
        alert('예약이 수정되었습니다.')
        return
      }

      if (text === 'Conflict') {
        alert(
          '해당 장소·날짜·시간에 이미 예약이 있습니다.\n종료 시간을 조정해 주세요.',
        )
        return
      }

      if (text === 'AuthFail') {
        alert('비밀번호가 일치하지 않습니다.')
        return
      }

      if (text.startsWith('Error:')) {
        alert(text)
        return
      }

      alert(`수정에 실패했습니다.\n(${text})`)
    } catch (err) {
      console.error(err)
      alert(
        `서버와 통신할 수 없습니다.\n(${err && err.message ? err.message : '네트워크 오류'})`,
      )
    } finally {
      showGasLoading(false)
      if (btnRes) {
        btnRes.disabled = false
        btnRes.textContent = saveLabel
      }
      enableReservationSubmit()
    }
  }

  /**
   * 수정·삭제 전 본인 확인 모달을 연다. (예약 항목 클릭 시 이어 붙이면 됨)
   * @param {string} expectedPassword - 해당 예약에 저장된 비밀번호(클라이언트 임시 저장분)
   * @param {{ onVerified?: (password?: string) => void, onCancel?: () => void }} [callbacks]
   * @param {{ serverOnly?: boolean }} [options] - true면 서버 검증용(입력값을 그대로 콜백에 전달)
   */
  function openPasswordVerifyModal(expectedPassword, callbacks, options) {
    if (!pwVerifyOverlay || !pwVerifyInput) return
    const o = options || {}
    verifyModalState = {
      expectedPassword: String(expectedPassword ?? ''),
      onVerified: callbacks && callbacks.onVerified,
      onCancel: callbacks && callbacks.onCancel,
      serverOnly: !!o.serverOnly,
    }
    pwVerifyInput.value = ''
    pwVerifyOverlay.removeAttribute('hidden')
    pwVerifyOverlay.setAttribute('aria-hidden', 'false')
    updateBodyScrollLock()
    pwVerifyInput.focus()
  }

  function closePasswordVerifyModal() {
    if (!pwVerifyOverlay) return
    pwVerifyOverlay.setAttribute('hidden', '')
    pwVerifyOverlay.setAttribute('aria-hidden', 'true')
    if (pwVerifyInput) pwVerifyInput.value = ''
    verifyModalState = {
      expectedPassword: '',
      onVerified: null,
      onCancel: null,
      serverOnly: false,
    }
    updateBodyScrollLock()
  }

  function confirmPasswordVerify() {
    const entered = pwVerifyInput ? pwVerifyInput.value : ''
    if (verifyModalState.serverOnly) {
      if (!entered.trim()) {
        alert('비밀번호를 입력해 주세요.')
        return
      }
      const cb = verifyModalState.onVerified
      closePasswordVerifyModal()
      if (typeof cb === 'function') cb(entered)
      return
    }
    if (entered !== verifyModalState.expectedPassword) {
      alert('비밀번호가 일치하지 않습니다.')
      return
    }
    const cb = verifyModalState.onVerified
    closePasswordVerifyModal()
    if (typeof cb === 'function') cb()
  }

  /**
   * 수정/삭제 UI: 서버 `getDetail`로 본인 확인 후 진행. (비밀번호는 시트에만 있음)
   * @example
   * gasFetchPost({ mode:'getDetail', id, password }) — URL 인코딩 POST
   */
  window.RoomReserveAuth = {
    requestPasswordForEdit(expectedPassword, callbacks) {
      openPasswordVerifyModal(expectedPassword, callbacks)
    },
    /** GAS GET으로 불러온 예약 목록 (비밀번호 없음). */
    getReservations() {
      return sheetReservations.slice()
    },
    async refreshFromSheet() {
      await fetchSheetReservations()
      render()
    },
    getGasUrl() {
      return GAS_URL
    },
  }

  const timeHintEl = document.getElementById('reservation-time-hint')
  if (timeHintEl) {
    timeHintEl.textContent = `시작은 달력에서 고른 시간으로 고정 · 종료만 아래에서 선택(30분 단위) · 최대 ${maxReservationSpanLabelKo()}`
  }

  if (
    overlay &&
    form &&
    btnClose &&
    btnCancel &&
    inputTimeStart &&
    inputTimeEnd
  ) {
    btnClose.addEventListener('click', closeReservationModal)
    btnCancel.addEventListener('click', closeReservationModal)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeReservationModal()
    })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      let ts = snapToHalfHourSlot(inputTimeStart.value)
      let te = inputTimeEnd ? String(inputTimeEnd.value || '').trim() : ''
      inputTimeStart.value = ts
      if (!ts || !te) {
        alert('시작·종료 시간을 선택해 주세요.')
        return
      }
      const startM = parseTimeToMinutes(ts)
      const endM = parseTimeToMinutes(te)
      if (
        !isAlignedToHalfHourFromDayStart(startM) ||
        !isAlignedToHalfHourFromDayStart(endM)
      ) {
        alert('시작·종료 시간은 30분 단위(:00, :30)로만 선택할 수 있습니다.')
        return
      }
      if (endM <= startM) {
        alert('종료 시간은 시작 시간보다 늦어야 합니다.')
        return
      }
      const spanM = endM - startM
      if (spanM > MAX_RESERVATION_SPAN_MINUTES) {
        alert(
          `예약 시간은 시작부터 최대 ${maxReservationSpanLabelKo()}까지 선택할 수 있습니다.`,
        )
        return
      }

      if (reservationFormMode === 'edit') {
        const isoEdit = dotDateToISO(inputDate.value)
        if (!isoEdit) {
          alert('일자 형식이 올바르지 않습니다.')
          return
        }
        disableReservationSubmit()
        void submitReservationUpdate(ts, te)
        return
      }

      const isoCheck = dotDateToISO(inputDate.value)
      if (!isoCheck || !isYmdInBookableWindow(isoCheck)) {
        alert(
          `예약 가능 기간이 아닙니다. 오늘부터 ${BOOKING_WINDOW_INCLUSIVE_DAYS}일(약 2주) 이내만 선택해 주세요.`,
        )
        return
      }
      const slotCk = getSlotBookingAvailability(modalAnchorDate, startM)
      if (!slotCk.ok) {
        alert(
          slotCk.reason === 'future'
            ? `예약은 오늘부터 ${BOOKING_WINDOW_INCLUSIVE_DAYS}일(약 2주) 이내만 가능합니다.`
            : '이미 지난 일자·시간에는 예약할 수 없습니다.',
        )
        return
      }

      pendingReservation = {
        장소: selectPlace.value,
        일자: inputDate.value,
        시작시간: ts,
        종료시간: te,
        시작표시: formatTimeKorean(startM),
        종료표시: formatTimeKorean(endM),
        예약자: inputName.value.trim(),
        소속: inputAffiliation.value.trim(),
        연락처: inputPhone.value.trim(),
        사용목적: inputPurpose.value.trim(),
      }

      disableReservationSubmit()
      openPasswordSetModal()
    })
  }

  if (pwSetForm && pwSetInput && pwSetOverlay) {
    if (pwSetClose) {
      pwSetClose.addEventListener('click', () => {
        closePasswordSetModal()
        showGasLoading(false)
      })
    }
    if (pwSetCancel) {
      pwSetCancel.addEventListener('click', () => {
        closePasswordSetModal()
        showGasLoading(false)
      })
    }
    pwSetOverlay.addEventListener('click', (e) => {
      if (e.target === pwSetOverlay) closePasswordSetModal()
    })
    pwSetForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const pwd = pwSetInput.value
      if (!pwd.trim()) {
        alert('비밀번호를 입력해 주세요.')
        return
      }
      void finalizeReservation(pwd).catch((err) => {
        console.error(err)
        alert('저장 처리 중 오류가 발생했습니다.')
      })
    })
  }

  if (pwVerifyConfirm && pwVerifyCancel && pwVerifyClose) {
    pwVerifyClose.addEventListener('click', () => {
      const cancel = verifyModalState.onCancel
      closePasswordVerifyModal()
      if (typeof cancel === 'function') cancel()
    })
    pwVerifyCancel.addEventListener('click', () => {
      const cancel = verifyModalState.onCancel
      closePasswordVerifyModal()
      if (typeof cancel === 'function') cancel()
    })
    if (pwVerifyOverlay) {
      pwVerifyOverlay.addEventListener('click', (e) => {
        if (e.target === pwVerifyOverlay) {
          const cancel = verifyModalState.onCancel
          closePasswordVerifyModal()
          if (typeof cancel === 'function') cancel()
        }
      })
    }
    pwVerifyConfirm.addEventListener('click', confirmPasswordVerify)
    if (pwVerifyInput) {
      pwVerifyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          confirmPasswordVerify()
        }
      })
    }
  }

  if (detailOverlay) {
    if (detailClose) {
      detailClose.addEventListener('click', closeReservationDetailModal)
    }
    detailOverlay.addEventListener('click', (e) => {
      if (e.target === detailOverlay) closeReservationDetailModal()
    })
    if (detailBtnView) {
      detailBtnView.addEventListener('click', () => {
        if (!detailReservationSelected) return
        openPasswordVerifyModal(
          '',
          {
            onVerified: (pwd) => {
              void requestReservationDetailFromServer(pwd)
            },
          },
          { serverOnly: true },
        )
      })
    }
    if (detailBtnDelete) {
      detailBtnDelete.addEventListener('click', () => {
        if (!detailReservationSelected) return
        openPasswordVerifyModal(
          '',
          {
            onVerified: (pwd) => {
              void requestReservationCancel(pwd)
            },
          },
          { serverOnly: true },
        )
      })
    }
    if (detailBtnEdit) {
      detailBtnEdit.addEventListener('click', () => {
        if (!detailReservationSelected) return
        openPasswordVerifyModal(
          '',
          {
            onVerified: (pwd) => {
              void requestReservationDetailThenOpenEdit(pwd)
            },
          },
          { serverOnly: true },
        )
      })
    }
  }

  if (detailFullOverlay) {
    const closeFull = () => closeReservationDetailFullModal()
    if (detailFullClose) detailFullClose.addEventListener('click', closeFull)
    if (detailFullOk) detailFullOk.addEventListener('click', closeFull)
    detailFullOverlay.addEventListener('click', (e) => {
      if (e.target === detailFullOverlay) closeFull()
    })
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (pwVerifyOverlay && !pwVerifyOverlay.hasAttribute('hidden')) {
      const cancel = verifyModalState.onCancel
      closePasswordVerifyModal()
      if (typeof cancel === 'function') cancel()
      return
    }
    if (pwSetOverlay && !pwSetOverlay.hasAttribute('hidden')) {
      closePasswordSetModal()
      return
    }
    if (detailFullOverlay && !detailFullOverlay.hasAttribute('hidden')) {
      closeReservationDetailFullModal()
      return
    }
    if (detailOverlay && !detailOverlay.hasAttribute('hidden')) {
      closeReservationDetailModal()
      return
    }
    if (overlay && !overlay.hasAttribute('hidden')) {
      closeReservationModal()
    }
  })

  function buildToolbar() {
    const bar = document.createElement('div')
    bar.className = 'cal__toolbar'

    const left = document.createElement('div')
    left.className = 'cal__toolbar-left'
    const prev = document.createElement('button')
    prev.type = 'button'
    prev.className = 'cal__btn'
    prev.setAttribute('aria-label', '이전')
    prev.textContent = '‹'
    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'cal__btn'
    next.setAttribute('aria-label', '다음')
    next.textContent = '›'
    const todayBtn = document.createElement('button')
    todayBtn.type = 'button'
    todayBtn.className = 'cal__btn cal__btn--ghost'
    todayBtn.textContent = '오늘'
    left.append(prev, next, todayBtn)

    const title = document.createElement('h2')
    title.className = 'cal__title'
    title.id = 'cal-title'

    const placeWrap = document.createElement('div')
    placeWrap.className = 'cal__toolbar-place'
    const placeLab = document.createElement('span')
    placeLab.className = 'cal__place-label'
    placeLab.textContent = '장소'
    const placeSelect = document.createElement('select')
    placeSelect.className = 'cal__select cal__place-select'
    placeSelect.setAttribute('aria-label', '달력에 표시할 장소')
    PLACES.forEach((p) => {
      const o = document.createElement('option')
      o.value = p
      o.textContent = p
      placeSelect.appendChild(o)
    })
    placeSelect.value = state.selectedPlace
    placeSelect.addEventListener('change', () => {
      state.selectedPlace = placeSelect.value
      if (selectPlace) selectPlace.value = state.selectedPlace
      render()
    })
    placeWrap.append(placeLab, placeSelect)

    const right = document.createElement('div')
    right.className = 'cal__toolbar-right'
    const btnMonth = document.createElement('button')
    btnMonth.type = 'button'
    btnMonth.className = 'cal__btn cal__btn--toggle'
    btnMonth.dataset.view = 'month'
    btnMonth.textContent = '월'
    const btnDay = document.createElement('button')
    btnDay.type = 'button'
    btnDay.className = 'cal__btn cal__btn--toggle'
    btnDay.dataset.view = 'day'
    btnDay.textContent = '일'
    right.append(btnMonth, btnDay)

    bar.append(left, title, placeWrap, right)

    prev.addEventListener('click', () => navigate(-1))
    next.addEventListener('click', () => navigate(1))
    todayBtn.addEventListener('click', () => {
      state.cursor = startOfDay(new Date())
      render()
    })
    btnMonth.addEventListener('click', () => {
      state.view = 'month'
      render()
    })
    btnDay.addEventListener('click', () => {
      state.view = 'day'
      render()
    })

    return { bar, title, btnMonth, btnDay }
  }

  function navigate(delta) {
    const c = new Date(state.cursor)
    if (state.view === 'month') {
      c.setMonth(c.getMonth() + delta)
      c.setDate(1)
    } else {
      c.setDate(c.getDate() + delta)
    }
    state.cursor = startOfDay(c)
    render()
  }

  function monthCells(year, month) {
    const pad = new Date(year, month, 1).getDay()
    const cells = []
    let i = 1 - pad
    const total = 42
    for (let k = 0; k < total; k++, i++) {
      const dt = new Date(year, month, i)
      cells.push({
        date: startOfDay(dt),
        inMonth: dt.getMonth() === month,
        isToday: sameDay(dt, new Date()),
      })
    }
    return cells
  }

  function renderMonth(titleEl) {
    const y = state.cursor.getFullYear()
    const m = state.cursor.getMonth()
    titleEl.textContent = monthTitle(state.cursor)

    const wrap = document.createElement('div')
    wrap.className = 'cal__month'

    const head = document.createElement('div')
    head.className = 'cal__weekdays'
    WEEKDAYS.forEach((name, idx) => {
      const th = document.createElement('div')
      th.className = 'cal__weekday'
      if (idx === 0) th.classList.add('cal__weekday--sunday')
      th.textContent = name
      head.appendChild(th)
    })

    const grid = document.createElement('div')
    grid.className = 'cal__grid'

    const cells = monthCells(y, m)

    cells.forEach(({ date, inMonth, isToday }) => {
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'cal__cell'
      if (!inMonth) cell.classList.add('cal__cell--muted')
      if (isToday) cell.classList.add('cal__cell--today')
      if (date.getDay() === 0) cell.classList.add('cal__cell--sunday')

      const n = inMonth
        ? countReservationsForPlaceAndDate(date, state.selectedPlace)
        : 0

      if (inMonth && !isDateInBookableWindow(date)) {
        cell.classList.add('cal__cell--booking-closed')
      }

      if (inMonth && n > 0) {
        cell.classList.add('cal__cell--has-bookings')
        cell.setAttribute(
          'title',
          `예약 ${n}건 · 클릭하면 이 날짜 일 보기`,
        )
      } else {
        cell.setAttribute('title', '클릭하면 이 날짜 일 보기')
      }


      const inner = document.createElement('div')
      inner.className = 'cal__cell-inner'
      const num = document.createElement('span')
      num.className = 'cal__cell-num'
      num.textContent = String(date.getDate())
      inner.appendChild(num)
      if (inMonth && n > 0) {
        const sum = document.createElement('span')
        sum.className = 'cal__cell-summary'
        sum.textContent = `예약 ${n}건`
        inner.appendChild(sum)
      }
      cell.appendChild(inner)

      cell.addEventListener('click', () => {
        state.cursor = startOfDay(date)
        state.view = 'day'
        render()
      })

      grid.appendChild(cell)
    })

    wrap.append(head, grid)
    return wrap
  }

  function renderDay(titleEl) {
    titleEl.textContent = dayTitle(state.cursor)

    const wrap = document.createElement('div')
    wrap.className = 'cal__day'

    const scroll = document.createElement('div')
    scroll.className = 'cal__day-scroll'

    const curDay = startOfDay(state.cursor)
    const dateKey = dateKeyFromDate(curDay)
    const beyondBookableWindow =
      dateKey > lastBookableDayKeySeoul()

    const list = reservationsForPlace(state.selectedPlace)
      .filter((r) => reservationDateKeyForCompare(r.date) === dateKey)
      .sort(
        (a, b) =>
          parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start),
      )
    assignReservationColumns(list)

    const pane = document.createElement('div')
    pane.className = 'cal__day-pane'

    const ruler = document.createElement('div')
    ruler.className = 'cal__day-ruler'

    const track = document.createElement('div')
    track.className = 'cal__day-track'

    const hoursBg = document.createElement('div')
    hoursBg.className = 'cal__day-hours-bg'
    for (
      let m = DAY_START_MIN;
      m < DAY_END_MIN;
      m += DAY_VIEW_SLOT_STEP_MIN
    ) {
      const avail = getSlotBookingAvailability(curDay, m)
      const blocked = !avail.ok

      const lab = document.createElement('div')
      lab.className = 'cal__day-ruler-hour'
      if (blocked) lab.classList.add('cal__day-slot--blocked')
      lab.textContent = valueFromMinutes(m)
      ruler.appendChild(lab)

      const slot = document.createElement('button')
      slot.type = 'button'
      slot.className = 'cal__day-hour-empty'
      if (blocked) slot.classList.add('cal__day-slot--blocked')
      slot.dataset.startMin = String(m)
      const label = valueFromMinutes(m)
      slot.setAttribute(
        'aria-label',
        blocked ? `${label} 예약 불가` : `${label} 새 예약`,
      )
      slot.addEventListener('click', () => {
        const ck = getSlotBookingAvailability(curDay, m)
        if (!ck.ok) {
          alert(
            ck.reason === 'future'
              ? `예약은 오늘부터 ${BOOKING_WINDOW_INCLUSIVE_DAYS}일(약 2주) 이내만 가능합니다.`
              : '이미 지난 일자·시간에는 예약할 수 없습니다.',
          )
          return
        }
        state.cursor = startOfDay(state.cursor)
        openReservationModal(state.cursor, { startTotalMin: m })
      })
      hoursBg.appendChild(slot)
    }

    const blocksLayer = document.createElement('div')
    blocksLayer.className = 'cal__day-blocks'

    list.forEach((r) => {
      const geom = clipReservationVertical(r.start, r.end)
      if (!geom) return
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'cal__res-block'
      btn.style.top = `${geom.topPct}%`
      const hPct = Math.max(geom.heightPct, 3.25)
      btn.style.height = `${hPct}%`
      const k = Math.max(1, r._colCount || 1)
      const col = r._col || 0
      btn.style.left = `calc(${(col / k) * 100}% + 2px)`
      btn.style.width = `calc(${100 / k}% - 4px)`
      const masked = maskNameDisplay(r.nameMasked)
      btn.innerHTML = `<span class="cal__res-block-text">예약자: ${escapeHtml(masked)}</span>`
      btn.setAttribute(
        'aria-label',
        `예약자: ${maskNameDisplay(r.nameMasked)}, ${r.start}부터 ${r.end}까지`,
      )
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        openReservationDetailModal(r)
      })
      blocksLayer.appendChild(btn)
    })

    track.append(hoursBg, blocksLayer)
    pane.append(ruler, track)
    scroll.appendChild(pane)

    if (beyondBookableWindow) {
      const banner = document.createElement('div')
      banner.className = 'cal__day-banner'
      banner.setAttribute('role', 'note')
      banner.textContent = `현재일 기준 ${BOOKING_WINDOW_INCLUSIVE_DAYS}일 이내만 예약할 수 있습니다.`
      wrap.append(banner, scroll)
    } else {
      wrap.appendChild(scroll)
    }
    return wrap
  }

  function render() {
    root.innerHTML = ''
    const { bar, title, btnMonth, btnDay } = buildToolbar()
    btnMonth.classList.toggle('cal__btn--active', state.view === 'month')
    btnDay.classList.toggle('cal__btn--active', state.view === 'day')

    const main =
      state.view === 'month' ? renderMonth(title) : renderDay(title)

    root.append(bar, main)
  }

  void (async function init() {
    await fetchSheetReservations()
    render()
  })()
})()
