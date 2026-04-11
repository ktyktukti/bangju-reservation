;(function () {
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
  const SLOT_START = 8
  const SLOT_END = 22

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

  const state = {
    view: 'month',
    cursor: startOfDay(new Date()),
  }

  let modalAnchorDate = startOfDay(new Date())
  /** 예약 폼 검증 후 · 비밀번호 확정 전까지 보관 */
  let pendingReservation = null
  /**
   * 메모리상 예약 목록 (수정/삭제 시 비밀번호 대조용).
   * 실서비스에서는 서버/시트에 해시만 저장할 것.
   */
  const reservations = []

  let verifyModalState = {
    expectedPassword: '',
    onVerified: null,
    onCancel: null,
  }

  function isAnyModalOpen() {
    const res = overlay && !overlay.hasAttribute('hidden')
    const set = pwSetOverlay && !pwSetOverlay.hasAttribute('hidden')
    const ver = pwVerifyOverlay && !pwVerifyOverlay.hasAttribute('hidden')
    return !!(res || set || ver)
  }

  function updateBodyScrollLock() {
    document.body.style.overflow = isAnyModalOpen() ? 'hidden' : ''
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

  /** 8:00~22:00 범위에서 가장 가까운 30분 단위로 맞춤 (일부 브라우저 자유 입력 대비) */
  function snapToHalfHourSlot(value) {
    let m = parseTimeToMinutes(value)
    if (Number.isNaN(m)) return value
    const minM = SLOT_START * 60
    const maxM = SLOT_END * 60
    m = Math.round((m - minM) / 30) * 30 + minM
    m = Math.max(minM, Math.min(maxM, m))
    return valueFromMinutes(m)
  }

  function setTimeRange(startVal, endVal) {
    if (inputTimeStart) inputTimeStart.value = startVal
    if (inputTimeEnd) inputTimeEnd.value = endVal
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

    const opt = opts || {}
    modalAnchorDate = startOfDay(date)
    inputDate.value = formatDateDot(modalAnchorDate)

    let sh = 9
    let eh = 10
    if (typeof opt.startHour === 'number') {
      sh = opt.startHour
      eh = Math.min(opt.startHour + 1, SLOT_END)
    }

    setTimeRange(
      valueFromMinutes(sh * 60),
      valueFromMinutes(eh * 60),
    )

    inputName.value = ''
    inputAffiliation.value = ''
    inputPhone.value = ''
    inputPurpose.value = ''
    selectPlace.selectedIndex = 0

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
    updateBodyScrollLock()
  }

  function finalizeReservation(plainPassword) {
    if (!pendingReservation) return
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `res-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    const record = {
      id,
      ...pendingReservation,
      _비밀번호: plainPassword,
    }
    reservations.push(record)

    const { _비밀번호, ...forLog } = record
    console.log('[예약 완료]', {
      ...forLog,
      비밀번호: '(설정됨 · 콘솔에는 평문 미출력)',
    })

    pendingReservation = null
    closePasswordSetModal()
    closeReservationModal()
  }

  /**
   * 수정·삭제 전 본인 확인 모달을 연다. (예약 항목 클릭 시 이어 붙이면 됨)
   * @param {string} expectedPassword - 해당 예약에 저장된 비밀번호(클라이언트 임시 저장분)
   * @param {{ onVerified?: () => void, onCancel?: () => void }} [callbacks]
   */
  function openPasswordVerifyModal(expectedPassword, callbacks) {
    if (!pwVerifyOverlay || !pwVerifyInput) return
    verifyModalState = {
      expectedPassword: String(expectedPassword ?? ''),
      onVerified: callbacks && callbacks.onVerified,
      onCancel: callbacks && callbacks.onCancel,
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
    }
    updateBodyScrollLock()
  }

  function confirmPasswordVerify() {
    const entered = pwVerifyInput ? pwVerifyInput.value : ''
    if (entered !== verifyModalState.expectedPassword) {
      alert('비밀번호가 일치하지 않습니다.')
      return
    }
    const cb = verifyModalState.onVerified
    closePasswordVerifyModal()
    if (typeof cb === 'function') cb()
  }

  /**
   * 수정/삭제 UI를 붙일 때 사용.
   * @example
   * const r = RoomReserveAuth.getReservations().find((x) => x.id === clickedId)
   * RoomReserveAuth.requestPasswordForEdit(r._비밀번호, {
   *   onVerified() { showEditOrDeleteUi(r) },
   *   onCancel() { },
   * })
   */
  window.RoomReserveAuth = {
    requestPasswordForEdit(expectedPassword, callbacks) {
      openPasswordVerifyModal(expectedPassword, callbacks)
    },
    /** 메모리 예약 목록(각 항목에 검증용 _비밀번호 포함). 실서비스는 서버만 신뢰. */
    getReservations() {
      return reservations.slice()
    },
  }

  function attachTimeSnap(el) {
    if (!el) return
    const snap = () => {
      if (!el.value) return
      const s = snapToHalfHourSlot(el.value)
      if (s !== el.value) el.value = s
    }
    el.addEventListener('change', snap)
    el.addEventListener('blur', snap)
  }

  attachTimeSnap(inputTimeStart)
  attachTimeSnap(inputTimeEnd)

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
      let te = snapToHalfHourSlot(inputTimeEnd.value)
      inputTimeStart.value = ts
      inputTimeEnd.value = te
      if (!ts || !te) {
        alert('시작·종료 시간을 선택해 주세요.')
        return
      }
      const startM = parseTimeToMinutes(ts)
      const endM = parseTimeToMinutes(te)
      if (endM <= startM) {
        alert('종료 시간은 시작 시간보다 늦어야 합니다.')
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

      openPasswordSetModal()
    })
  }

  if (pwSetForm && pwSetInput && pwSetOverlay) {
    if (pwSetClose) {
      pwSetClose.addEventListener('click', () => {
        closePasswordSetModal()
      })
    }
    if (pwSetCancel) {
      pwSetCancel.addEventListener('click', () => {
        closePasswordSetModal()
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
      finalizeReservation(pwd)
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

    bar.append(left, title, right)

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
    WEEKDAYS.forEach((name) => {
      const th = document.createElement('div')
      th.className = 'cal__weekday'
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

      const num = document.createElement('span')
      num.className = 'cal__cell-num'
      num.textContent = String(date.getDate())
      cell.appendChild(num)

      cell.addEventListener('click', () => {
        openReservationModal(date)
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

    for (let h = SLOT_START; h < SLOT_END; h++) {
      const row = document.createElement('div')
      row.className = 'cal__slot'
      const label = document.createElement('div')
      label.className = 'cal__slot-label'
      label.textContent = `${String(h).padStart(2, '0')}:00`
      const body = document.createElement('button')
      body.type = 'button'
      body.className = 'cal__slot-body'
      body.dataset.hour = String(h)
      body.setAttribute('aria-label', `${h}시 예약 입력`)
      body.addEventListener('click', () => {
        state.cursor = startOfDay(state.cursor)
        openReservationModal(state.cursor, { startHour: h })
      })
      row.append(label, body)
      scroll.appendChild(row)
    }

    wrap.appendChild(scroll)
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

  render()
})()
