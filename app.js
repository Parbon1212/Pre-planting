"use strict";

const API_KEY = "AIzaSyBi4w2RapqTYpAudXkqBa2xAw54z18F5uY";

const PLOT_COLORS = [
  "#ff6b00", "#1f77b4", "#2ca02c", "#d62728",
  "#9467bd", "#8c564b", "#e377c2", "#17becf",
];

const MAX_DOTS = 2000; // 地図上に描画する点数の上限（多すぎるとブラウザが重くなるため）

const DEFAULT_LAT = 32.88158479139884;
const DEFAULT_LNG = 130.73541207830417;

let nextPlotId = 1;
function createPlot(overrides = {}) {
  const id = nextPlotId++;
  return Object.assign(
    {
      id,
      type: "rect", // "rect"（方形） | "dots"（ドット配置）
      // 表示名・色は plotName()/plotColor() で「現在の並び順」から都度計算する
      // （IDのまま固定すると、削除・再作成のたびに番号や色がずれてしまうため）。
      lat: DEFAULT_LAT,
      lng: DEFAULT_LNG,

      // --- 方形（rect）用 ---
      width: 100, // 横方向（回転前は東西）の長さ [m]
      height: 100, // 縦方向（回転前は南北）の長さ [m]
      rotation: 0, // 北から時計回りの回転角度 [度]
      lock: null, // "width" | "height" | "area" | null — 固定する値

      // --- ドット配置（dots）用 ---
      colSpacing: 5, // 列方向（東西）の点間距離 [m]
      rowSpacing: 5, // 行方向（南北）の点間距離 [m]
      cols: 10, // 列数（基準点から東方向）
      rows: 10, // 行数（基準点から北方向）
      azimuth: 0, // 北から時計回りの回転角度 [度]
    },
    overrides
  );
}

let plots = [];
let activePlotId = null;

function getActivePlot() {
  return plots.find((p) => p.id === activePlotId) || null;
}

function plotName(plot) {
  const n = plots.indexOf(plot) + 1;
  return plot.type === "dots" ? `区画${n}・ドット` : `区画${n}`;
}

function plotColor(plot) {
  return PLOT_COLORS[plots.indexOf(plot) % PLOT_COLORS.length];
}

let map = null;
let AreaLabelOverlay = null; // google.maps 読み込み後に定義するクラス
const drawings = new Map(); // plotId -> { polygon, dotMarkers, label, marker }

const el = {
  apiKeyError: document.getElementById("apiKeyError"),
  controls: document.getElementById("controls"),
  tabBar: document.getElementById("tabBar"),
  addRectPlotBtn: document.getElementById("addRectPlotBtn"),
  addDotsPlotBtn: document.getElementById("addDotsPlotBtn"),
  deletePlotBtn: document.getElementById("deletePlotBtn"),
  baseFields: document.getElementById("baseFields"),
  latInput: document.getElementById("latInput"),
  lngInput: document.getElementById("lngInput"),

  rectFields: document.getElementById("rectFields"),
  heightInput: document.getElementById("heightInput"),
  widthInput: document.getElementById("widthInput"),
  areaInput: document.getElementById("areaInput"),
  rotationInput: document.getElementById("rotationInput"),

  dotsFields: document.getElementById("dotsFields"),
  colSpacingInput: document.getElementById("colSpacingInput"),
  rowSpacingInput: document.getElementById("rowSpacingInput"),
  colsInput: document.getElementById("colsInput"),
  rowsInput: document.getElementById("rowsInput"),
  azimuthInput: document.getElementById("azimuthInput"),

  resultSection: document.getElementById("resultSection"),
  resultBox: document.getElementById("resultBox"),
  resultArea: document.getElementById("resultArea"),
  resultPerimeter: document.getElementById("resultPerimeter"),
  cornerList: document.getElementById("cornerList"),

  dotsResultBox: document.getElementById("dotsResultBox"),
  resultPointCount: document.getElementById("resultPointCount"),
  resultGridSize: document.getElementById("resultGridSize"),
  dotsCapHint: document.getElementById("dotsCapHint"),
  dotsCornerList: document.getElementById("dotsCornerList"),

  resultTotalArea: document.getElementById("resultTotalArea"),
  resultPlotCount: document.getElementById("resultPlotCount"),
  lockBtns: document.querySelectorAll(".lock-btn"),
};

function areaHaOf(width, height) {
  return (width * height) / 10000;
}

// 選択中の区画の「面積」。方形はそのままの面積、ドットは点間の外接矩形の面積とする。
function plotAreaHa(plot) {
  if (plot.type === "dots") {
    const w = Math.max(0, Math.round(plot.cols) - 1) * plot.colSpacing;
    const h = Math.max(0, Math.round(plot.rows) - 1) * plot.rowSpacing;
    return areaHaOf(w, h);
  }
  return areaHaOf(plot.width, plot.height);
}

function normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

// 東西・南北のローカルオフセット(m)を、指定した角度(北から時計回り)で回転させる
function rotateOffset(x, y, rotationDeg) {
  const rad = (rotationDeg * Math.PI) / 180;
  const rx = x * Math.cos(rad) + y * Math.sin(rad);
  const ry = -x * Math.sin(rad) + y * Math.cos(rad);
  return { x: rx, y: ry };
}

function offsetToLatLng(base, x, y) {
  const distance = Math.sqrt(x * x + y * y);
  if (distance === 0) return new google.maps.LatLng(base.lat, base.lng);
  let heading = (Math.atan2(x, y) * 180) / Math.PI; // atan2(東, 北)
  if (heading < 0) heading += 360;
  return google.maps.geometry.spherical.computeOffset(
    new google.maps.LatLng(base.lat, base.lng),
    distance,
    heading
  );
}

function computeCornersFromDims(base, width, height, rotationDeg) {
  const localCorners = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  return localCorners.map(([x, y]) => {
    const rotated = rotateOffset(x, y, rotationDeg);
    return offsetToLatLng(base, rotated.x, rotated.y);
  });
}

function computeCorners(plot) {
  return computeCornersFromDims(plot, plot.width, plot.height, plot.rotation);
}

// ドット配置の外接矩形の4隅（範囲の目安・地図フィット用）
function computeDotGridCorners(plot) {
  const width = Math.max(0, Math.round(plot.cols) - 1) * plot.colSpacing;
  const height = Math.max(0, Math.round(plot.rows) - 1) * plot.rowSpacing;
  return computeCornersFromDims(plot, width, height, plot.azimuth);
}

// ドット1点ずつの座標（基準点=原点、東方向に列、北方向に行）。MAX_DOTSで打ち切る。
function computeDotPositions(plot) {
  const rows = Math.max(1, Math.round(plot.rows));
  const cols = Math.max(1, Math.round(plot.cols));
  const points = [];
  outer: for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (points.length >= MAX_DOTS) break outer;
      const rotated = rotateOffset(j * plot.colSpacing, i * plot.rowSpacing, plot.azimuth);
      points.push(offsetToLatLng(plot, rotated.x, rotated.y));
    }
  }
  return points;
}

function syncFormFromActivePlot() {
  const p = getActivePlot();

  if (!p) {
    el.baseFields.hidden = true;
    el.rectFields.hidden = true;
    el.dotsFields.hidden = true;
    el.resultSection.hidden = true;
    return;
  }
  el.baseFields.hidden = false;
  el.resultSection.hidden = false;

  el.latInput.value = p.lat.toFixed(6);
  el.lngInput.value = p.lng.toFixed(6);

  const isDots = p.type === "dots";
  el.rectFields.hidden = isDots;
  el.dotsFields.hidden = !isDots;
  el.resultBox.hidden = isDots;
  el.dotsResultBox.hidden = !isDots;

  if (isDots) {
    el.colSpacingInput.value = round2(p.colSpacing);
    el.rowSpacingInput.value = round2(p.rowSpacing);
    el.colsInput.value = p.cols;
    el.rowsInput.value = p.rows;
    el.azimuthInput.value = round2(p.azimuth);
  } else {
    el.widthInput.value = round2(p.width);
    el.heightInput.value = round2(p.height);
    el.areaInput.value = round2(areaHaOf(p.width, p.height));
    el.rotationInput.value = round2(p.rotation);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function recenterMap(lat, lng) {
  // setCenterだけだと、環境によってタイルが灰色のまま再描画されないことがあるため、
  // resizeイベントを強制発火してから centre を入れ直す（既知の回避策）。
  map.setCenter({ lat, lng });
  google.maps.event.trigger(map, "resize");
  map.setCenter({ lat, lng });
}

function syncLockUI() {
  const plot = getActivePlot();
  const lock = plot && plot.type === "rect" ? plot.lock : null;
  el.heightInput.disabled = lock === "height";
  el.widthInput.disabled = lock === "width";
  el.areaInput.disabled = lock === "area";

  el.lockBtns.forEach((btn) => {
    const isActive = btn.dataset.field === lock;
    btn.classList.toggle("active", isActive);
    btn.textContent = isActive ? "🔒" : "🔓";
  });
}

function setLock(field) {
  const plot = getActivePlot();
  if (!plot || plot.type !== "rect") return;
  plot.lock = plot.lock === field ? null : field;
  syncLockUI();
}

function removePlotDrawing(id) {
  const d = drawings.get(id);
  if (!d) return;
  if (d.polygon) d.polygon.setMap(null);
  if (d.marker) d.marker.setMap(null);
  if (d.label) d.label.setMap(null);
  if (d.dotMarkers) d.dotMarkers.forEach((m) => m.setMap(null));
  if (d.rotateHandle) d.rotateHandle.setMap(null);
  drawings.delete(id);
}

// 回転ハンドルの幾何情報。方形は縦横、ドットは配置範囲の縦横を対角線とする。
function computeRotateHandleGeometry(plot) {
  let width, height;
  if (plot.type === "dots") {
    width = Math.max(0, Math.round(plot.cols) - 1) * plot.colSpacing;
    height = Math.max(0, Math.round(plot.rows) - 1) * plot.rowSpacing;
  } else {
    width = plot.width;
    height = plot.height;
  }
  if (width === 0 && height === 0) {
    width = 5;
    height = 5; // 寸法が0のときも掴めるよう仮の腕を確保
  }
  const radius = Math.sqrt(width * width + height * height);
  const baseHeadingDeg = normalizeAngle((Math.atan2(width, height) * 180) / Math.PI);
  return { radius, baseHeadingDeg };
}

function getPlotAngle(plot) {
  return plot.type === "dots" ? plot.azimuth : plot.rotation;
}

function getRotateHandlePosition(plot) {
  const { radius, baseHeadingDeg } = computeRotateHandleGeometry(plot);
  const base = new google.maps.LatLng(plot.lat, plot.lng);
  return google.maps.geometry.spherical.computeOffset(
    base,
    radius,
    normalizeAngle(baseHeadingDeg + getPlotAngle(plot))
  );
}

// ドラッグ中・ドラッグ終了の両方で呼ぶ：基準点からカーソル方向への方位角を採用し、
// この区画だけ軽量に再描画する（他区画・タブ一覧は触らない）。
function onRotateHandleDrag(plot, e) {
  const base = new google.maps.LatLng(plot.lat, plot.lng);
  const bearingToCursor = google.maps.geometry.spherical.computeHeading(base, e.latLng);
  const { baseHeadingDeg } = computeRotateHandleGeometry(plot);
  const newAngle = normalizeAngle(bearingToCursor - baseHeadingDeg);

  if (plot.type === "dots") {
    plot.azimuth = newAngle;
    el.azimuthInput.value = round2(newAngle);
  } else {
    plot.rotation = newAngle;
    el.rotationInput.value = round2(newAngle);
  }

  redrawPlot(plot); // ハンドル位置は半径固定で再計算されるため、弧の上にしか動かない
  updateResultBox();
}

function syncRotateHandle(plot, d, color, isActive) {
  if (!isActive) {
    if (d.rotateHandle) d.rotateHandle.setMap(null);
    return;
  }

  const handlePos = getRotateHandlePosition(plot);
  if (!d.rotateHandle) {
    d.rotateHandle = new google.maps.Marker({
      position: handlePos,
      map,
      draggable: true,
      zIndex: 30,
      title: "ドラッグして角度を変更",
    });
    d.rotateHandle.addListener("drag", (e) => onRotateHandleDrag(plot, e));
    d.rotateHandle.addListener("dragend", (e) => onRotateHandleDrag(plot, e));
  } else {
    d.rotateHandle.setPosition(handlePos);
    d.rotateHandle.setMap(map);
  }
  d.rotateHandle.setIcon({
    path: google.maps.SymbolPath.CIRCLE,
    scale: 6,
    fillColor: "#ffffff",
    fillOpacity: 1,
    strokeColor: color,
    strokeWeight: 2,
  });
}

function redrawDotsPlot(plot, d, color, isActive) {
  if (d.polygon) {
    d.polygon.setMap(null);
    d.polygon = null;
  }

  // 先頭の点（基準点そのもの）はドラッグ用マーカーと重なるため描画対象から除く
  const points = computeDotPositions(plot).slice(1);

  if (!d.dotMarkers) d.dotMarkers = [];
  while (d.dotMarkers.length < points.length) {
    d.dotMarkers.push(new google.maps.Marker({ map, clickable: false }));
  }
  while (d.dotMarkers.length > points.length) {
    d.dotMarkers.pop().setMap(null);
  }

  const scale = isActive ? 4 : 2.5;
  const fillOpacity = isActive ? 0.95 : 0.45;
  points.forEach((pos, idx) => {
    const marker = d.dotMarkers[idx];
    marker.setPosition(pos);
    marker.setMap(map);
    marker.setZIndex(isActive ? 10 : 5);
    marker.setIcon({
      path: google.maps.SymbolPath.CIRCLE,
      scale,
      fillColor: color,
      fillOpacity,
      strokeColor: color,
      strokeWeight: 1,
    });
  });

  if (!d.label) {
    d.label = new AreaLabelOverlay();
    d.label.setMap(map);
  }
  const gridCorners = computeDotGridCorners(plot);
  const centerLat = gridCorners.reduce((s, c) => s + c.lat(), 0) / gridCorners.length;
  const centerLng = gridCorners.reduce((s, c) => s + c.lng(), 0) / gridCorners.length;
  d.label.setPosition(new google.maps.LatLng(centerLat, centerLng));
  d.label.setText(`${plotName(plot)}: ${plot.rows * plot.cols}点`);
  d.label.setColor(color);
  d.label.setActive(isActive);

  syncRotateHandle(plot, d, color, isActive);
}

function redrawRectPlot(plot, d, color, isActive) {
  if (d.dotMarkers && d.dotMarkers.length) {
    d.dotMarkers.forEach((m) => m.setMap(null));
    d.dotMarkers = [];
  }

  const corners = computeCorners(plot);
  const style = isActive
    ? { strokeWeight: 3, strokeOpacity: 1, fillOpacity: 0.35, zIndex: 10 }
    : { strokeWeight: 1.5, strokeOpacity: 0.6, fillOpacity: 0.12, zIndex: 5 };

  if (!d.polygon) {
    d.polygon = new google.maps.Polygon({
      paths: corners,
      strokeColor: color,
      fillColor: color,
      map,
      ...style,
    });
  } else {
    d.polygon.setPath(corners);
    d.polygon.setOptions({ strokeColor: color, fillColor: color, ...style });
  }

  if (!d.label) {
    d.label = new AreaLabelOverlay();
    d.label.setMap(map);
  }
  const centerLat = corners.reduce((s, c) => s + c.lat(), 0) / corners.length;
  const centerLng = corners.reduce((s, c) => s + c.lng(), 0) / corners.length;
  d.label.setPosition(new google.maps.LatLng(centerLat, centerLng));
  d.label.setText(`${plotName(plot)}: ${round2(areaHaOf(plot.width, plot.height))} ha`);
  d.label.setColor(color);
  d.label.setActive(isActive);

  syncRotateHandle(plot, d, color, isActive);
}

// 基準点マーカーのドラッグ中・ドラッグ終了の両方で呼ぶ：位置を更新してこの区画だけ軽量に再描画する。
function onBaseMarkerDrag(plot, e) {
  plot.lat = e.latLng.lat();
  plot.lng = e.latLng.lng();
  el.latInput.value = plot.lat.toFixed(6);
  el.lngInput.value = plot.lng.toFixed(6);
  redrawPlot(plot);
  updateResultBox();
}

function redrawPlot(plot) {
  const isActive = plot.id === activePlotId;

  let d = drawings.get(plot.id);
  if (!d) {
    d = {};
    drawings.set(plot.id, d);
  }

  const color = plotColor(plot);
  if (plot.type === "dots") {
    redrawDotsPlot(plot, d, color, isActive);
  } else {
    redrawRectPlot(plot, d, color, isActive);
  }

  // 基準点マーカーは方形・ドット共通（ドラッグで基準点を移動）
  if (isActive) {
    if (!d.marker) {
      d.marker = new google.maps.Marker({
        position: { lat: plot.lat, lng: plot.lng },
        map,
        draggable: true,
        title: plotName(plot),
      });
      d.marker.addListener("drag", (e) => onBaseMarkerDrag(plot, e));
      d.marker.addListener("dragend", (e) => onBaseMarkerDrag(plot, e));
    } else {
      d.marker.setPosition({ lat: plot.lat, lng: plot.lng });
      d.marker.setMap(map);
      d.marker.setTitle(plotName(plot));
    }
  } else if (d.marker) {
    d.marker.setMap(null);
  }
}

function redrawAll() {
  if (!map) return;
  plots.forEach((plot) => redrawPlot(plot));
  updateResultBox();
  updateTotalArea();
}

function updateResultBox() {
  const p = getActivePlot();
  if (!p) return;

  if (p.type === "dots") {
    const total = Math.max(1, Math.round(p.rows)) * Math.max(1, Math.round(p.cols));
    el.resultPointCount.textContent = total;
    const w = round2(Math.max(0, Math.round(p.cols) - 1) * p.colSpacing);
    const h = round2(Math.max(0, Math.round(p.rows) - 1) * p.rowSpacing);
    el.resultGridSize.textContent = `${w} × ${h}`;
    el.dotsCapHint.hidden = total <= MAX_DOTS;

    el.dotsCornerList.innerHTML = "";
    computeDotGridCorners(p).forEach((c) => {
      const li = document.createElement("li");
      li.textContent = `${c.lat().toFixed(6)}, ${c.lng().toFixed(6)}`;
      el.dotsCornerList.appendChild(li);
    });
    return;
  }

  el.resultArea.textContent = round2(areaHaOf(p.width, p.height));
  const perimeter = 2 * (p.width + p.height);
  el.resultPerimeter.textContent = round2(perimeter);

  el.cornerList.innerHTML = "";
  computeCorners(p).forEach((c) => {
    const li = document.createElement("li");
    li.textContent = `${c.lat().toFixed(6)}, ${c.lng().toFixed(6)}`;
    el.cornerList.appendChild(li);
  });
}

function updateTotalArea() {
  const total = plots.reduce((sum, p) => sum + plotAreaHa(p), 0);
  el.resultTotalArea.textContent = round2(total);
  el.resultPlotCount.textContent = plots.length;
}

function fitAllPlots() {
  if (plots.length === 0) return;
  const bounds = new google.maps.LatLngBounds();
  plots.forEach((plot) => {
    const corners = plot.type === "dots" ? computeDotGridCorners(plot) : computeCorners(plot);
    corners.forEach((c) => bounds.extend(c));
  });
  map.fitBounds(bounds, 80);
}

let dragSourcePlotId = null;

function renderTabs() {
  el.tabBar.innerHTML = "";

  if (plots.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "区画がありません。下のボタンから追加してください。";
    el.tabBar.appendChild(hint);
    el.deletePlotBtn.disabled = true;
    return;
  }

  plots.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn" + (p.id === activePlotId ? " active" : "");
    btn.style.setProperty("--tab-color", plotColor(p));
    btn.textContent = plotName(p);
    btn.draggable = true;
    btn.addEventListener("click", () => selectPlot(p.id));

    // ドラッグ&ドロップで並び替え。名前・色は並び順から計算しているので、
    // 並び替えれば番号も自動でついてくる。
    btn.addEventListener("dragstart", (e) => {
      dragSourcePlotId = p.id;
      e.dataTransfer.effectAllowed = "move";
      btn.classList.add("dragging");
    });
    btn.addEventListener("dragend", () => {
      btn.classList.remove("dragging");
      dragSourcePlotId = null;
    });
    btn.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    btn.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (dragSourcePlotId !== p.id) btn.classList.add("drag-over");
    });
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("drag-over");
    });
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      btn.classList.remove("drag-over");
      if (dragSourcePlotId === null || dragSourcePlotId === p.id) return;
      reorderPlots(dragSourcePlotId, p.id);
    });

    el.tabBar.appendChild(btn);
  });
  el.deletePlotBtn.disabled = false;
}

function reorderPlots(sourceId, targetId) {
  const fromIdx = plots.findIndex((p) => p.id === sourceId);
  const toIdx = plots.findIndex((p) => p.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [moved] = plots.splice(fromIdx, 1);
  plots.splice(toIdx, 0, moved);
  dragSourcePlotId = null;
  renderTabs();
  redrawAll();
}

function selectPlot(id) {
  activePlotId = id;
  const plot = getActivePlot();
  syncFormFromActivePlot();
  syncLockUI();
  renderTabs();
  recenterMap(plot.lat, plot.lng);
  redrawAll();
}

function addPlot(type) {
  const current = getActivePlot();
  const newPlot = createPlot({
    lat: current ? current.lat : DEFAULT_LAT,
    lng: current ? current.lng : DEFAULT_LNG,
    type,
  });
  plots.push(newPlot);
  selectPlot(newPlot.id);
}

function deletePlot() {
  if (plots.length === 0) return;
  const idx = plots.findIndex((p) => p.id === activePlotId);
  removePlotDrawing(activePlotId);
  plots.splice(idx, 1);

  if (plots.length === 0) {
    activePlotId = null;
    syncFormFromActivePlot();
    renderTabs();
    redrawAll();
    return;
  }

  const nextActive = plots[Math.max(0, idx - 1)];
  activePlotId = nextActive.id;
  syncFormFromActivePlot();
  syncLockUI();
  renderTabs();
  recenterMap(nextActive.lat, nextActive.lng);
  redrawAll();
}

function wirePlotManagerEvents() {
  el.addRectPlotBtn.addEventListener("click", () => addPlot("rect"));
  el.addDotsPlotBtn.addEventListener("click", () => addPlot("dots"));
  el.deletePlotBtn.addEventListener("click", deletePlot);
}

function wireControlEvents() {
  el.latInput.addEventListener("change", () => {
    const plot = getActivePlot();
    const v = parseFloat(el.latInput.value);
    if (!isFinite(v)) {
      el.latInput.value = plot.lat.toFixed(6); // 不正な値は元に戻す
      return;
    }
    plot.lat = v;
    recenterMap(plot.lat, plot.lng);
    redrawAll();
  });
  el.lngInput.addEventListener("change", () => {
    const plot = getActivePlot();
    const v = parseFloat(el.lngInput.value);
    if (!isFinite(v)) {
      el.lngInput.value = plot.lng.toFixed(6); // 不正な値は元に戻す
      return;
    }
    plot.lng = v;
    recenterMap(plot.lat, plot.lng);
    redrawAll();
  });

  el.widthInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const newWidth = parseFloat(el.widthInput.value);
    // 入力途中（空文字など）でNaNになっている間は何もしない。0にフォールバックすると
    // ロック中の値（面積など）が壊れてしまうため。
    if (!isFinite(newWidth) || newWidth < 0) return;

    if (plot.lock === "area") {
      // 面積固定: 横を変えたら縦で面積を帳尻合わせ
      const areaM2 = areaHaOf(plot.width, plot.height) * 10000;
      plot.width = newWidth;
      plot.height = newWidth > 0 ? areaM2 / newWidth : 0;
      el.heightInput.value = round2(plot.height);
    } else {
      plot.width = newWidth;
    }
    el.areaInput.value = round2(areaHaOf(plot.width, plot.height));
    redrawAll();
  });

  el.heightInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const newHeight = parseFloat(el.heightInput.value);
    if (!isFinite(newHeight) || newHeight < 0) return;

    if (plot.lock === "area") {
      // 面積固定: 縦を変えたら横で面積を帳尻合わせ
      const areaM2 = areaHaOf(plot.width, plot.height) * 10000;
      plot.height = newHeight;
      plot.width = newHeight > 0 ? areaM2 / newHeight : 0;
      el.widthInput.value = round2(plot.width);
    } else {
      plot.height = newHeight;
    }
    el.areaInput.value = round2(areaHaOf(plot.width, plot.height));
    redrawAll();
  });

  el.areaInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const newAreaHa = parseFloat(el.areaInput.value);
    if (!isFinite(newAreaHa) || newAreaHa < 0) return;
    const newAreaM2 = newAreaHa * 10000;

    if (plot.lock === "width") {
      // 横固定: 面積を変えたら縦だけ変わる
      plot.height = plot.width > 0 ? newAreaM2 / plot.width : 0;
      el.heightInput.value = round2(plot.height);
    } else if (plot.lock === "height") {
      // 縦固定: 面積を変えたら横だけ変わる
      plot.width = plot.height > 0 ? newAreaM2 / plot.height : 0;
      el.widthInput.value = round2(plot.width);
    } else {
      // 固定なし: 現在の縦横比を保ったまま両方変える
      const ratio = plot.height > 0 ? plot.width / plot.height : 1;
      const newHeight = Math.sqrt(newAreaM2 / ratio);
      const newWidth = ratio * newHeight;
      plot.width = newWidth;
      plot.height = newHeight;
      el.widthInput.value = round2(plot.width);
      el.heightInput.value = round2(plot.height);
    }
    redrawAll();
  });

  el.rotationInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const v = parseFloat(el.rotationInput.value);
    if (!isFinite(v)) return; // 入力途中は何もしない
    plot.rotation = v;
    redrawAll();
  });

  el.colSpacingInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const v = parseFloat(el.colSpacingInput.value);
    if (!isFinite(v) || v < 0) return;
    plot.colSpacing = v;
    redrawAll();
  });

  el.rowSpacingInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const v = parseFloat(el.rowSpacingInput.value);
    if (!isFinite(v) || v < 0) return;
    plot.rowSpacing = v;
    redrawAll();
  });

  el.colsInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const v = parseFloat(el.colsInput.value);
    if (!isFinite(v) || v < 1) return;
    plot.cols = v;
    redrawAll();
  });

  el.rowsInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const v = parseFloat(el.rowsInput.value);
    if (!isFinite(v) || v < 1) return;
    plot.rows = v;
    redrawAll();
  });

  el.azimuthInput.addEventListener("input", () => {
    const plot = getActivePlot();
    const v = parseFloat(el.azimuthInput.value);
    if (!isFinite(v)) return;
    plot.azimuth = v;
    redrawAll();
  });

  el.lockBtns.forEach((btn) => {
    btn.addEventListener("click", () => setLock(btn.dataset.field));
  });
}

function loadGoogleMapsScript(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps && window.google.maps.geometry) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}&libraries=geometry`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Google Maps の読み込みに失敗しました。APIキーを確認してください。"));
    document.head.appendChild(script);
  });
}

async function initMap(apiKey) {
  el.apiKeyError.textContent = "";
  try {
    await loadGoogleMapsScript(apiKey);
  } catch (err) {
    el.apiKeyError.textContent = err.message;
    return;
  }

  AreaLabelOverlay = class extends google.maps.OverlayView {
    constructor() {
      super();
      this.div = null;
      this.position = null;
      this.text = "";
      this.color = "#ff6b00";
      this.active = true;
    }
    setPosition(latLng) {
      this.position = latLng;
      this.draw();
    }
    setText(text) {
      this.text = text;
      if (this.div) this.div.textContent = text;
    }
    setColor(color) {
      this.color = color;
      this.applyStyle();
    }
    setActive(active) {
      this.active = active;
      this.applyStyle();
    }
    applyStyle() {
      if (!this.div) return;
      this.div.style.borderColor = this.color;
      this.div.style.opacity = this.active ? "1" : "0.6";
      this.div.style.fontWeight = this.active ? "700" : "600";
      this.div.style.zIndex = this.active ? "20" : "10";
    }
    onAdd() {
      this.div = document.createElement("div");
      this.div.className = "area-label";
      this.div.textContent = this.text;
      this.getPanes().floatPane.appendChild(this.div);
      this.applyStyle();
    }
    draw() {
      if (!this.div || !this.position) return;
      const proj = this.getProjection();
      if (!proj) return;
      const pos = proj.fromLatLngToDivPixel(this.position);
      this.div.style.left = `${pos.x}px`;
      this.div.style.top = `${pos.y}px`;
    }
    onRemove() {
      if (this.div) {
        this.div.parentNode.removeChild(this.div);
        this.div = null;
      }
    }
  };

  const initialPlot = getActivePlot();
  map = new google.maps.Map(document.getElementById("map"), {
    center: initialPlot ? { lat: initialPlot.lat, lng: initialPlot.lng } : { lat: DEFAULT_LAT, lng: DEFAULT_LNG },
    zoom: 16,
    mapTypeId: "hybrid",
  });


  el.controls.hidden = false;
  renderTabs();
  syncFormFromActivePlot();
  syncLockUI();
  wireControlEvents();
  wirePlotManagerEvents();
  redrawAll();
  fitAllPlots();
}

window.addEventListener("DOMContentLoaded", () => {
  initMap(API_KEY);
});
