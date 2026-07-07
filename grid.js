// The world grid: 5deg x 5deg cells covering the globe.
const CELL_SIZE = 5; // degrees
const COLS = 360 / CELL_SIZE; // 72
const ROWS = 180 / CELL_SIZE; // 36

function cellId(col, row) {
  return row * COLS + col;
}

function cellIdFromLonLat(lon, lat) {
  const col = Math.min(COLS - 1, Math.max(0, Math.floor((lon + 180) / CELL_SIZE)));
  const row = Math.min(ROWS - 1, Math.max(0, Math.floor((90 - lat) / CELL_SIZE)));
  return cellId(col, row);
}

function cellCenter(id) {
  const col = id % COLS;
  const row = Math.floor(id / COLS);
  const lon = -180 + (col + 0.5) * CELL_SIZE;
  const lat = 90 - (row + 0.5) * CELL_SIZE;
  return { lon, lat };
}

function allCellIds() {
  const ids = [];
  for (let i = 0; i < COLS * ROWS; i++) ids.push(i);
  return ids;
}

module.exports = { CELL_SIZE, COLS, ROWS, cellId, cellIdFromLonLat, cellCenter, allCellIds };
