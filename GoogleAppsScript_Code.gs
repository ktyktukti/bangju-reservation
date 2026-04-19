// ==========================================
// 1. 환경 설정 (팀장님 여기서 수정하세요)
// ==========================================
var ADMIN_PASSWORD = "우리교회관리자123"; // 실제 사용할 관리자 비번으로 수정
var DB_SHEET_NAME = "Reserve_DB"; // 시트 탭 이름 확인
/** Key / Value / 설명 형식 — MAX_HOURS, OPEN_DAYS, LOCATIONS */
var CONFIG_SHEET_NAME = "Config";

// ==========================================
// CORS: 브라우저 fetch용 (런타임 미지원 시 무시)
// ==========================================
function withCors_(output) {
  try {
    if (output && typeof output.setHeaders === "function") {
      return output.setHeaders({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Accept, Cache-Control, Pragma, X-Requested-With",
        "Access-Control-Max-Age": "3600",
      });
    }
  } catch (ignore) {}
  return output;
}

/** 스프레드시트용 타임존 문자열 (Utilities.formatDate 두 번째 인자) */
function timezoneString_(ss) {
  return String(
    (ss && ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) ||
      Session.getScriptTimeZone() ||
      "Asia/Seoul"
  ).trim() || "Asia/Seoul";
}

function formatReservationPhone_(phone) {
  var formattedPhone = phone;
  if (formattedPhone && formattedPhone.toString().startsWith("0")) {
    formattedPhone = "'" + formattedPhone;
  } else if (
    formattedPhone &&
    !formattedPhone.toString().startsWith("0") &&
    formattedPhone.toString().length >= 9
  ) {
    formattedPhone = "'0" + formattedPhone;
  }
  return formattedPhone;
}

/** 종료 시간 셀 → JSON용 'HH:mm' 문자열 */
function endTimeToHHmm_(cellVal, tzStr) {
  if (
    Object.prototype.toString.call(cellVal) === "[object Date]" &&
    !isNaN(cellVal.getTime())
  ) {
    return Utilities.formatDate(cellVal, tzStr, "HH:mm");
  }
  return String(cellVal != null ? cellVal : "");
}

/** Config 시트 기본값(Key 컬럼 매칭 실패 시) */
var CONFIG_DEFAULTS_ = {
  maxHours: 3,
  openDays: 14,
  locations: ["다목적실", "유아예배실 1", "유아예배실 2"],
};

/**
 * Config 시트에서 설정 로드 (열 A=Key, B=Value).
 * 반환: { maxHours: number, openDays: number, locations: string[] }
 */
function getConfig_() {
  var out = {
    maxHours: CONFIG_DEFAULTS_.maxHours,
    openDays: CONFIG_DEFAULTS_.openDays,
    locations: CONFIG_DEFAULTS_.locations.slice(),
  };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(CONFIG_SHEET_NAME);
    if (!sh) return out;
    var data = sh.getDataRange().getValues();
    for (var r = 1; r < data.length; r++) {
      var key = String(data[r][0] || "").trim();
      var val = data[r][1];
      if (key === "MAX_HOURS") {
        var h = parseInt(val, 10);
        if (!isNaN(h) && h >= 1 && h <= 24) out.maxHours = h;
      } else if (key === "OPEN_DAYS") {
        var d = parseInt(val, 10);
        if (!isNaN(d) && d >= 1 && d <= 366) out.openDays = d;
      } else if (key === "LOCATIONS") {
        var list = String(val || "")
          .split(/[,，、]/)
          .map(function (s) {
            return String(s).trim();
          })
          .filter(function (s) {
            return s.length > 0;
          });
        if (list.length > 0) out.locations = list;
      }
    }
  } catch (ignore) {}
  return out;
}

/** 편집기 실행·테스트용 */
function getConfig() {
  return getConfig_();
}

/** 신규 예약·수정 시 최대 허용 길이(분) */
function maxReservationSpanMinutes_() {
  var c = getConfig_();
  var h = Number(c.maxHours);
  if (isNaN(h) || h < 1) h = CONFIG_DEFAULTS_.maxHours;
  if (h > 24) h = 24;
  return Math.round(h * 60);
}

/** 신규 저장 시 장소가 Config 목록에 있는지 */
function placeAllowed_(placeStr) {
  var cfg = getConfig_();
  var p = String(placeStr || "").trim();
  var locs = cfg.locations || [];
  for (var i = 0; i < locs.length; i++) {
    if (String(locs[i]).trim() === p) return true;
  }
  return false;
}

/** 브라우저가 POST 전에 보내는 OPTIONS(프리플라이트) 처리 */
function doOptions() {
  return withCors_(
    ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT)
  );
}

// ==========================================
// 2. 저장 / 상세조회 / 취소 / 수정 / 중복체크 (POST 방식)
// ==========================================
function doPost(e) {
  try {
    var params = e.parameter;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(DB_SHEET_NAME);
    if (!sheet) {
      return withCors_(
        ContentService.createTextOutput("Error: Sheet not found").setMimeType(
          ContentService.MimeType.TEXT
        )
      );
    }
    var data = sheet.getDataRange().getValues();

    /** 반드시 getDetail 이전에 정의 — formatDate의 timeZone은 String만 허용 */
    var tz = timezoneString_(ss);

    // --- [모드 A: 상세조회 (getDetail)] ---
    if (params.mode === "getDetail") {
      for (var i = 1; i < data.length; i++) {
        if (data[i][0] == params.id) {
          if (
            params.password === ADMIN_PASSWORD ||
            data[i][9] == params.password
          ) {
            return withCors_(
              ContentService.createTextOutput(
                JSON.stringify({
                  phone: data[i][7],
                  purpose: data[i][8],
                  name: data[i][5],
                  group: data[i][6],
                  endTime: endTimeToHHmm_(data[i][4], tz),
                })
              ).setMimeType(ContentService.MimeType.JSON)
            );
          }
        }
      }
      return withCors_(
        ContentService.createTextOutput("AuthFail").setMimeType(
          ContentService.MimeType.TEXT
        )
      );
    }

    // --- [모드 B: 예약 취소 (cancel)] ---
    if (params.mode === "cancel") {
      var targetRow = -1;
      for (var j = 1; j < data.length; j++) {
        if (data[j][0] == params.id) {
          if (
            params.password === ADMIN_PASSWORD ||
            data[j][9] == params.password
          ) {
            targetRow = j + 1;
            break;
          }
        }
      }
      if (targetRow !== -1) {
        sheet.getRange(targetRow, 12).setValue("Y");
        return withCors_(
          ContentService.createTextOutput("CancelSuccess").setMimeType(
            ContentService.MimeType.TEXT
          )
        );
      }
      return withCors_(
        ContentService.createTextOutput("AuthFail").setMimeType(
          ContentService.MimeType.TEXT
        )
      );
    }

    // --- [모드 C: 예약 수정 (update)] ---
    if (params.mode === "update") {
      var rowIdx = -1;
      for (var k = 1; k < data.length; k++) {
        if (data[k][0] == params.id) {
          if (
            params.password === ADMIN_PASSWORD ||
            data[k][9] == params.password
          ) {
            rowIdx = k;
            break;
          }
        }
      }
      if (rowIdx === -1) {
        return withCors_(
          ContentService.createTextOutput("AuthFail").setMimeType(
            ContentService.MimeType.TEXT
          )
        );
      }

      var placeLocked = String(data[rowIdx][1] || "").trim();
      var dateLocked = data[rowIdx][2];
      var startLocked = data[rowIdx][3];

      var newEndMin = reservationTimeToMinutes_(params.endTime, tz);
      var startMin = reservationTimeToMinutes_(startLocked, tz);
      if (isNaN(newEndMin) || isNaN(startMin) || newEndMin <= startMin) {
        return withCors_(
          ContentService.createTextOutput("Error: Invalid time range").setMimeType(
            ContentService.MimeType.TEXT
          )
        );
      }
      if (newEndMin - startMin > maxReservationSpanMinutes_()) {
        return withCors_(
          ContentService.createTextOutput(
            "Error: Exceeds max reservation span"
          ).setMimeType(ContentService.MimeType.TEXT)
        );
      }

      var dateParam = "";
      if (
        Object.prototype.toString.call(dateLocked) === "[object Date]" &&
        !isNaN(dateLocked.getTime())
      ) {
        dateParam = Utilities.formatDate(dateLocked, tz, "yyyy-MM-dd");
      } else {
        var s0 = String(dateLocked).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s0)) {
          dateParam = s0;
        } else {
          var d0 = new Date(s0);
          dateParam = isNaN(d0.getTime())
            ? ""
            : Utilities.formatDate(d0, tz, "yyyy-MM-dd");
        }
      }
      if (!dateParam) {
        return withCors_(
          ContentService.createTextOutput("Error: Invalid row date").setMimeType(
            ContentService.MimeType.TEXT
          )
        );
      }

      var isConflictUpdate = data.slice(1).some(function (row) {
        if (String(row[11]) === "Y") return false;
        if (String(row[0]) == params.id) return false;
        if (String(row[1]).trim() !== placeLocked) return false;
        if (!reservationDateMatches_(row[2], dateParam, tz)) return false;
        var exStartMin = reservationTimeToMinutes_(row[3], tz);
        var exEndMin = reservationTimeToMinutes_(row[4], tz);
        if (isNaN(exStartMin) || isNaN(exEndMin) || exEndMin <= exStartMin)
          return false;
        return intervalsOverlapMinutes_(
          startMin,
          newEndMin,
          exStartMin,
          exEndMin
        );
      });
      if (isConflictUpdate) {
        return withCors_(
          ContentService.createTextOutput("Conflict").setMimeType(
            ContentService.MimeType.TEXT
          )
        );
      }

      var formattedPhoneUp = formatReservationPhone_(params.phone);
      var sheetRow = rowIdx + 1;
      sheet.getRange(sheetRow, 5, 1, 5).setValues([
        [
          params.endTime,
          params.name,
          params.group,
          formattedPhoneUp,
          params.purpose,
        ],
      ]);
      return withCors_(
        ContentService.createTextOutput("UpdateSuccess").setMimeType(
          ContentService.MimeType.TEXT
        )
      );
    }

    // --- [모드 D: 신규 예약 저장 (기본)] ---
    var placeNew = String(params.place || "").trim();
    if (!placeAllowed_(placeNew)) {
      return withCors_(
        ContentService.createTextOutput("Error: Invalid place").setMimeType(
          ContentService.MimeType.TEXT
        )
      );
    }
    var dateNew = String(params.date || "").trim();
    var newStartMin = reservationTimeToMinutes_(params.startTime, tz);
    var newEndMin = reservationTimeToMinutes_(params.endTime, tz);
    if (isNaN(newStartMin) || isNaN(newEndMin) || newEndMin <= newStartMin) {
      return withCors_(
        ContentService.createTextOutput("Error: Invalid time range").setMimeType(
          ContentService.MimeType.TEXT
        )
      );
    }
    if (newEndMin - newStartMin > maxReservationSpanMinutes_()) {
      return withCors_(
        ContentService.createTextOutput(
          "Error: Exceeds max reservation span"
        ).setMimeType(ContentService.MimeType.TEXT)
      );
    }
    var isConflictNew = data.slice(1).some(function (row) {
      if (String(row[11]) === "Y") return false;
      if (String(row[1]).trim() !== placeNew) return false;
      if (!reservationDateMatches_(row[2], dateNew, tz)) return false;
      var exStartMin = reservationTimeToMinutes_(row[3], tz);
      var exEndMin = reservationTimeToMinutes_(row[4], tz);
      if (isNaN(exStartMin) || isNaN(exEndMin) || exEndMin <= exStartMin)
        return false;
      return intervalsOverlapMinutes_(newStartMin, newEndMin, exStartMin, exEndMin);
    });
    if (isConflictNew) {
      return withCors_(
        ContentService.createTextOutput("Conflict").setMimeType(
          ContentService.MimeType.TEXT
        )
      );
    }

    var reservationID = generateID();
    var now = new Date();
    var timestamp = Utilities.formatDate(now, "GMT+9", "yyyy-MM-dd HH:mm:ss");
    var formattedPhoneNew = formatReservationPhone_(params.phone);
    var rowData = [
      reservationID,
      params.place,
      params.date,
      params.startTime,
      params.endTime,
      params.name,
      params.group,
      formattedPhoneNew,
      params.purpose,
      params.password,
      timestamp,
      "N",
    ];
    sheet.appendRow(rowData);
    return withCors_(
      ContentService.createTextOutput("Success:" + reservationID).setMimeType(
        ContentService.MimeType.TEXT
      )
    );
  } catch (error) {
    return withCors_(
      ContentService.createTextOutput("Error: " + error.toString()).setMimeType(
        ContentService.MimeType.TEXT
      )
    );
  }
}

// ==========================================
// 3. 달력 표시용 일반 데이터 조회 (GET 방식)
// ==========================================
function doGet(e) {
  e = e || {};
  var p = e.parameter || {};
  if (p.mode === "getConfig") {
    var cfgOut = getConfig_();
    var cbCfg = p.callback;
    if (cbCfg) {
      var cfgPayload = cbCfg + "(" + JSON.stringify(cfgOut) + ");";
      return withCors_(
        ContentService.createTextOutput(cfgPayload).setMimeType(
          ContentService.MimeType.JAVASCRIPT
        )
      );
    }
    return withCors_(
      ContentService.createTextOutput(JSON.stringify(cfgOut)).setMimeType(
        ContentService.MimeType.JSON
      )
    );
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DB_SHEET_NAME);
  if (!sheet) {
    return withCors_(
      ContentService.createTextOutput("Error: Sheet not found").setMimeType(
        ContentService.MimeType.TEXT
      )
    );
  }
  var data = sheet.getDataRange().getDisplayValues();
  var result = data
    .slice(1)
    .filter(function (row) {
      return row[11] !== "Y";
    })
    .map(function (row) {
      var rawName = row[5] != null ? String(row[5]) : "";
      return {
        예약번호: row[0],
        장소: row[1],
        일자: row[2],
        시작시간: row[3],
        종료시간: row[4],
        예약자:
          rawName.substring(0, 1) +
          "*" +
          (rawName.length > 2 ? rawName.substring(rawName.length - 1) : ""),
      };
    });
  var cb = e.parameter && e.parameter.callback;
  if (cb) {
    var payload = cb + "(" + JSON.stringify(result) + ");";
    return withCors_(
      ContentService.createTextOutput(payload).setMimeType(
        ContentService.MimeType.JAVASCRIPT
      )
    );
  }
  return withCors_(
    ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
      ContentService.MimeType.JSON
    )
  );
}

// ==========================================
// 4. 유틸리티: 10자리 랜덤 예약 ID 생성
// ==========================================
function generateID() {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var res = "";
  for (var i = 0; i < 10; i++)
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

/** "9:00"/"09:00" 또는 시트 시간 Date → 그날 0시부터 분 */
function reservationTimeToMinutes_(v, timeZone) {
  if (v == null || v === "") return NaN;
  var tzLocal =
    String(
      timeZone || Session.getScriptTimeZone() || "Asia/Seoul"
    ).trim() || "Asia/Seoul";
  if (
    Object.prototype.toString.call(v) === "[object Date]" &&
    !isNaN(v.getTime())
  ) {
    return (
      parseInt(Utilities.formatDate(v, tzLocal, "HH"), 10) * 60 +
      parseInt(Utilities.formatDate(v, tzLocal, "mm"), 10)
    );
  }
  var s = String(v).replace(/\s+/g, "");
  var m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  var hh = parseInt(m[1], 10);
  var mm = parseInt(m[2], 10);
  if (hh > 23 || mm > 59) return NaN;
  return hh * 60 + mm;
}

/** 시트 날짜 셀과 params.date (yyyy-MM-dd) 비교 */
function reservationDateMatches_(cellVal, paramYmd, timeZone) {
  if (paramYmd == null || paramYmd === "") return false;
  var p = String(paramYmd).trim();
  var tzLocal =
    String(
      timeZone || Session.getScriptTimeZone() || "Asia/Seoul"
    ).trim() || "Asia/Seoul";
  if (
    Object.prototype.toString.call(cellVal) === "[object Date]" &&
    !isNaN(cellVal.getTime())
  ) {
    return Utilities.formatDate(cellVal, tzLocal, "yyyy-MM-dd") === p;
  }
  var s = String(cellVal).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s === p;
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, tzLocal, "yyyy-MM-dd") === p;
  }
  return false;
}

/** [ns, ne), [es, ee) 구간 겹침 — 딱 맞닿음(한쪽 종료 = 다른 쪽 시작)은 겹침 아님 */
function intervalsOverlapMinutes_(ns, ne, es, ee) {
  if (isNaN(ns) || isNaN(ne) || isNaN(es) || isNaN(ee)) return false;
  if (ne <= ns || ee <= es) return false;
  return ns < ee && ne > es;
}
